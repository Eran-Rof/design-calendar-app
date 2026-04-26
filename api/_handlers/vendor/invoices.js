// api/vendor/invoices.js
//
// POST — vendor submits an invoice (header + line items).
//   body: {
//     po_id: uuid (required — tanda_pos.uuid_id),
//     invoice_number: string (required),
//     invoice_date?: "YYYY-MM-DD",
//     due_date?: "YYYY-MM-DD",
//     currency?: string (default "USD"),
//     subtotal: number, tax: number, total: number,
//     notes?: string,
//     file_url?: string (Supabase Storage path, optional),
//     line_items: [{ po_line_item_id, description, quantity_invoiced,
//                    unit_price, line_total }]
//   }
//
// Side effects:
//   - Inserts one invoices row + N invoice_line_items rows
//   - Fires invoice_submitted notification to INTERNAL_INVOICE_EMAILS
//     (falls back to INTERNAL_COMPLIANCE_EMAILS), subject:
//     '{vendor name} submitted invoice {invoice_number}'

import { createClient } from "@supabase/supabase-js";
import { authenticateVendor } from "../../_lib/vendor-auth.js";
import { fireWorkflowEvent } from "../../_lib/workflow.js";

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const authResult = await authenticateVendor(admin, req, { requiredScope: "invoices:write" });
  if (!authResult.ok) return res.status(authResult.status).json({ error: authResult.error });
  const { auth, finish } = authResult;
  const caller = { vendor_id: auth.vendor_id, id: auth.vendor_user_id || null };
  const send = (code, body) => { finish?.(code); return res.status(code).json(body); };

  // Onboarding gate: block invoice submission until workflow approved.
  const { data: wf } = await admin.from("onboarding_workflows").select("status").eq("vendor_id", caller.vendor_id).maybeSingle();
  if (wf && wf.status !== "approved") {
    return send(403, { error: `Onboarding must be approved before submitting invoices (current status: ${wf.status}). Complete onboarding at /vendor/onboarding.` });
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return send(400, { error: "Invalid JSON" }); } }

  const {
    po_id, invoice_number, invoice_date, due_date, currency,
    subtotal, tax, total, notes, file_url, file_description, payment_terms,
    from_asn_id, discrepancies,
    line_items,
  } = body || {};

  if (!po_id) return send(400, { error: "po_id is required" });
  if (!invoice_number || typeof invoice_number !== "string" || !invoice_number.trim()) return send(400, { error: "invoice_number is required" });
  if (!Array.isArray(line_items) || line_items.length === 0) return send(400, { error: "At least one line_item is required" });

  // Reject non-numeric qty / price before the Number() fallbacks below
  // silently coerce them into NaN and we insert garbage financial data.
  for (const [i, l] of line_items.entries()) {
    if (l.quantity_invoiced != null && !Number.isFinite(Number(l.quantity_invoiced))) {
      return send(400, { error: `line_items[${i}].quantity_invoiced must be a number` });
    }
    if (l.unit_price != null && !Number.isFinite(Number(l.unit_price))) {
      return send(400, { error: `line_items[${i}].unit_price must be a number` });
    }
    if (l.line_total != null && !Number.isFinite(Number(l.line_total))) {
      return send(400, { error: `line_items[${i}].line_total must be a number` });
    }
  }

  // Verify the PO belongs to the caller's vendor
  const { data: po } = await admin
    .from("tanda_pos").select("uuid_id, po_number, vendor_id")
    .eq("uuid_id", po_id).eq("vendor_id", caller.vendor_id).maybeSingle();
  if (!po) return send(403, { error: "PO not found or not yours" });

  // Path-injection guard — file_url must live under the caller's folder
  // when supplied. Without this, a vendor could submit an invoice whose
  // attachment points at another vendor's storage path.
  if (file_url && (typeof file_url !== "string" || !file_url.startsWith(`${caller.vendor_id}/`))) {
    return send(403, { error: "file_url must be under the caller's vendor folder" });
  }

  // Insert invoice header
  const { data: inv, error: invErr } = await admin.from("invoices").insert({
    vendor_id: caller.vendor_id,
    po_id,
    invoice_number: invoice_number.trim(),
    invoice_date: invoice_date || null,
    due_date: due_date || null,
    currency: (currency || "USD").toUpperCase(),
    subtotal: subtotal != null ? Number(subtotal) : null,
    tax: tax != null ? Number(tax) : 0,
    total: total != null ? Number(total) : null,
    status: "submitted",
    file_url: file_url || null,
    file_description: file_description ? String(file_description).trim() : null,
    submitted_by: caller.id,
    notes: notes ? String(notes).trim() : null,
    payment_terms: payment_terms ? String(payment_terms).trim() : null,
  }).select("*").single();
  if (invErr) {
    if (invErr.code === "23505") return send(409, { error: `Invoice ${invoice_number} already exists for this vendor` });
    return send(500, { error: invErr.message });
  }

  // Insert line items
  const lineRows = line_items.map((l, idx) => ({
    invoice_id: inv.id,
    po_line_item_id: l.po_line_item_id || null,
    line_index: l.line_index ?? idx + 1,
    description: l.description || null,
    quantity_invoiced: l.quantity_invoiced != null ? Number(l.quantity_invoiced) : null,
    unit_price: l.unit_price != null ? Number(l.unit_price) : null,
    line_total: l.line_total != null
      ? Number(l.line_total)
      : ((Number(l.quantity_invoiced) || 0) * (Number(l.unit_price) || 0)),
  }));
  const { error: liErr } = await admin.from("invoice_line_items").insert(lineRows);
  if (liErr) {
    // Non-fatal: header exists. Return with warning so caller knows.
    return send(201, { ...inv, line_items_error: liErr.message });
  }

  // Auto-generated PO message when this invoice was submitted via the
  // combined ASN + Invoice flow. Gives the internal Ring of Fire team a
  // single thread-entry that announces both.
  // Discrepancy message — fires whenever the client flagged mismatches,
  // independent of whether the invoice came from the ASN + Invoice flow.
  if (Array.isArray(discrepancies) && discrepancies.length > 0 && auth.auth_id) {
    try {
      const lines = [
        `⚠️ Invoice ${inv.invoice_number} submitted with ${discrepancies.length} discrepanc${discrepancies.length === 1 ? "y" : "ies"} (PO ${po.po_number}):`,
        ...discrepancies.slice(0, 25).map((d) => `• ${String(d)}`),
      ].join("\n");
      await admin.from("po_messages").insert({
        po_id: inv.po_id,
        sender_type: "vendor",
        sender_auth_id: auth.auth_id,
        sender_name: "Vendor (auto-generated)",
        body: lines,
        read_by_vendor: true,
        read_by_internal: false,
      });
    } catch { /* non-blocking */ }
  }

  // Resolve the shipment to stamp: prefer the client-provided from_asn_id,
  // but fall back to the newest un-invoiced shipment on the same PO so
  // an invoice still marks the shipment even when the user submits via
  // the regular Invoice form (no asn query param).
  let stampTargetShipmentId = null;
  if (from_asn_id) {
    stampTargetShipmentId = from_asn_id;
  } else {
    const { data: pending } = await admin
      .from("shipments")
      .select("id")
      .eq("vendor_id", caller.vendor_id)
      .eq("po_id", po_id)
      .is("invoice_id", null)
      .order("created_at", { ascending: false })
      .limit(1);
    if (pending && pending[0]) stampTargetShipmentId = pending[0].id;
  }

  if (stampTargetShipmentId && auth.auth_id) {
    try {
      // Stamp the shipment: link the invoice + timestamp. Scoped by
      // vendor_id so a rogue id pointing at another vendor's shipment
      // does nothing.
      await admin.from("shipments")
        .update({ invoice_id: inv.id, invoice_created_at: new Date().toISOString() })
        .eq("id", stampTargetShipmentId)
        .eq("vendor_id", caller.vendor_id);

      const { data: shipment } = await admin
        .from("shipments").select("asn_number, carrier, ship_via, ship_date")
        .eq("id", stampTargetShipmentId).eq("vendor_id", caller.vendor_id).maybeSingle();
      const totalDisplay = inv.total != null
        ? Number(inv.total).toLocaleString(undefined, { style: "currency", currency: inv.currency || "USD" })
        : "—";
      const lines = [
        `📦 New ASN + Invoice submitted for PO ${po.po_number}`,
        shipment?.asn_number ? `• ASN: ${shipment.asn_number}` : null,
        shipment?.carrier ? `• Carrier: ${shipment.carrier}${shipment.ship_via ? ` (${shipment.ship_via})` : ""}` : null,
        shipment?.ship_date ? `• Ship date: ${shipment.ship_date}` : null,
        `• Invoice: ${inv.invoice_number} — ${totalDisplay}`,
        inv.payment_terms ? `• Terms: ${inv.payment_terms}` : null,
      ].filter(Boolean).join("\n");
      await admin.from("po_messages").insert({
        po_id: inv.po_id,
        sender_type: "vendor",
        sender_auth_id: auth.auth_id,
        sender_name: "Vendor (auto-generated)",
        body: lines,
        read_by_vendor: true,
        read_by_internal: false,
      });
    } catch { /* non-blocking */ }
  }

  // Fire internal notifications
  try {
    const emails = (process.env.INTERNAL_INVOICE_EMAILS || process.env.INTERNAL_COMPLIANCE_EMAILS || "")
      .split(",").map((e) => e.trim()).filter(Boolean);
    if (emails.length > 0) {
      const { data: vendor } = await admin.from("vendors").select("name").eq("id", caller.vendor_id).maybeSingle();
      const vendorName = vendor?.name || "A vendor";
      const origin = `https://${req.headers.host}`;
      await Promise.all(emails.map((email) =>
        fetch(`${origin}/api/send-notification`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event_type: "invoice_submitted",
            title: `${vendorName} submitted invoice ${inv.invoice_number}`,
            body: `PO ${po.po_number} · Total ${(inv.total != null ? Number(inv.total).toLocaleString(undefined, { style: "currency", currency: inv.currency || "USD" }) : "—")}. Open TandA to review.`,
            link: "/",
            metadata: { invoice_id: inv.id, vendor_id: caller.vendor_id, po_number: po.po_number },
            recipient: { internal_id: "ap_team", email },
            dedupe_key: `invoice_submitted_${inv.id}_${email}`,
            email: true,
          }),
        }).catch(() => {})
      ));
    }
  } catch { /* non-blocking */ }

  // Fire invoice_submitted workflow event. Rules can require approval,
  // notify finance, auto-approve, or webhook out. The engine returns
  // the results list so the caller can see what happened.
  let workflow = null;
  try {
    const origin = `https://${req.headers.host}`;
    workflow = await fireWorkflowEvent({
      admin,
      event: "invoice_submitted",
      entity_id: inv.entity_id,
      origin,
      context: {
        entity_type: "invoice",
        entity_id: inv.id,
        vendor_id: caller.vendor_id,
        amount: Number(inv.total) || 0,
        invoice_status: inv.status,
        po_id: inv.po_id,
        po_number: po.po_number,
        invoice_number: inv.invoice_number,
      },
    });
  } catch { /* non-blocking */ }

  return send(201, workflow ? { ...inv, workflow } : inv);
}
