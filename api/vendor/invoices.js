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

export const config = { maxDuration: 30 };

async function resolveVendor(admin, authHeader) {
  const jwt = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!jwt) return null;
  try {
    const { data, error } = await admin.auth.getUser(jwt);
    if (error || !data?.user) return null;
    const { data: vu } = await admin
      .from("vendor_users")
      .select("id, vendor_id, display_name")
      .eq("auth_id", data.user.id)
      .maybeSingle();
    if (!vu) return null;
    return { ...vu, auth_id: data.user.id, email: data.user.email };
  } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const caller = await resolveVendor(admin, req.headers.authorization);
  if (!caller) return res.status(401).json({ error: "Authentication required" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }

  const {
    po_id, invoice_number, invoice_date, due_date, currency,
    subtotal, tax, total, notes, file_url,
    line_items,
  } = body || {};

  if (!po_id) return res.status(400).json({ error: "po_id is required" });
  if (!invoice_number || typeof invoice_number !== "string" || !invoice_number.trim()) return res.status(400).json({ error: "invoice_number is required" });
  if (!Array.isArray(line_items) || line_items.length === 0) return res.status(400).json({ error: "At least one line_item is required" });

  // Verify the PO belongs to the caller's vendor
  const { data: po } = await admin
    .from("tanda_pos").select("uuid_id, po_number, vendor_id")
    .eq("uuid_id", po_id).eq("vendor_id", caller.vendor_id).maybeSingle();
  if (!po) return res.status(403).json({ error: "PO not found or not yours" });

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
    submitted_by: caller.id,
    notes: notes ? String(notes).trim() : null,
  }).select("*").single();
  if (invErr) {
    if (invErr.code === "23505") return res.status(409).json({ error: `Invoice ${invoice_number} already exists for this vendor` });
    return res.status(500).json({ error: invErr.message });
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
    return res.status(201).json({ ...inv, line_items_error: liErr.message });
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

  return res.status(201).json(inv);
}
