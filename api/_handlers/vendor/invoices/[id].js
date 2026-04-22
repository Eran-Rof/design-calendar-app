// api/vendor/invoices/:id
//
// PATCH — vendor edits an invoice they submitted. Only allowed while
//         status === 'submitted'. Updates header fields and fully
//         replaces the line_items set if provided. 403 once the invoice
//         has moved to under_review or beyond.
//
// body (all fields optional — only provided keys are updated):
//   invoice_number, invoice_date, due_date, currency, subtotal, tax,
//   total, notes, file_url, line_items: [...]

import { createClient } from "@supabase/supabase-js";
import { authenticateVendor } from "../../../_lib/vendor-auth.js";

export const config = { maxDuration: 30 };

function getId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("invoices");
  return idx >= 0 ? parts[idx + 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "PATCH") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const authRes = await authenticateVendor(admin, req, { requiredScope: "invoices:write" });
  if (!authRes.ok) return res.status(authRes.status || 401).json({ error: authRes.error });
  const vendorId = authRes.auth.vendor_id;

  const invoiceId = getId(req);
  if (!invoiceId) return res.status(400).json({ error: "Invoice id missing from path" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  const {
    invoice_number, invoice_date, due_date, currency,
    subtotal, tax, total, notes, file_url, line_items,
  } = body || {};

  const { data: current, error: fetchErr } = await admin
    .from("invoices").select("id, vendor_id, status").eq("id", invoiceId).maybeSingle();
  if (fetchErr) return res.status(500).json({ error: fetchErr.message });
  if (!current || current.vendor_id !== vendorId) return res.status(403).json({ error: "Invoice not found or not yours" });
  if (current.status !== "submitted") {
    return res.status(409).json({ error: `Cannot edit invoice in status "${current.status}" — contact your Ring of Fire reviewer for changes.` });
  }

  const patch = { updated_at: new Date().toISOString() };
  if (invoice_number !== undefined) patch.invoice_number = String(invoice_number).trim();
  if (invoice_date !== undefined) patch.invoice_date = invoice_date || null;
  if (due_date !== undefined) patch.due_date = due_date || null;
  if (currency !== undefined) patch.currency = String(currency || "USD").toUpperCase();
  if (subtotal !== undefined) patch.subtotal = subtotal != null ? Number(subtotal) : null;
  if (tax !== undefined) patch.tax = tax != null ? Number(tax) : 0;
  if (total !== undefined) patch.total = total != null ? Number(total) : null;
  if (notes !== undefined) patch.notes = notes ? String(notes).trim() : null;
  if (file_url !== undefined) patch.file_url = file_url || null;

  if (Object.keys(patch).length > 1) {
    const { error: upErr } = await admin.from("invoices").update(patch).eq("id", invoiceId);
    if (upErr) {
      if (upErr.code === "23505") return res.status(409).json({ error: "Invoice number already in use for this vendor" });
      return res.status(500).json({ error: upErr.message });
    }
  }

  if (Array.isArray(line_items)) {
    const { error: delErr } = await admin.from("invoice_line_items").delete().eq("invoice_id", invoiceId);
    if (delErr) return res.status(500).json({ error: delErr.message });
    const rows = line_items.map((l, idx) => ({
      invoice_id: invoiceId,
      po_line_item_id: l.po_line_item_id || null,
      line_index: l.line_index ?? idx + 1,
      description: l.description || null,
      quantity_invoiced: l.quantity_invoiced != null ? Number(l.quantity_invoiced) : null,
      unit_price: l.unit_price != null ? Number(l.unit_price) : null,
      line_total: l.line_total != null
        ? Number(l.line_total)
        : ((Number(l.quantity_invoiced) || 0) * (Number(l.unit_price) || 0)),
    }));
    if (rows.length > 0) {
      const { error: insErr } = await admin.from("invoice_line_items").insert(rows);
      if (insErr) return res.status(500).json({ error: insErr.message });
    }
  }

  const { data: updated } = await admin.from("invoices").select("*").eq("id", invoiceId).maybeSingle();
  return res.status(200).json(updated);
}
