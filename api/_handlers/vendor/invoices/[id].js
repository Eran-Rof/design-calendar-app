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
  const { auth, finish } = authRes;
  const vendorId = auth.vendor_id;
  const send = (code, payload) => { finish?.(code); return res.status(code).json(payload); };

  const invoiceId = getId(req);
  if (!invoiceId) return send(400, { error: "Invoice id missing from path" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return send(400, { error: "Invalid JSON" }); } }
  const {
    invoice_number, invoice_date, due_date, currency,
    subtotal, tax, total, notes, file_url, file_description, payment_terms, line_items,
  } = body || {};

  // Reject an explicit empty array — callers should omit the key to
  // leave existing line items alone. Silently accepting `[]` would
  // DELETE every line without a replacement.
  if (line_items !== undefined && (!Array.isArray(line_items) || line_items.length === 0)) {
    return send(400, { error: "line_items must be a non-empty array, or omit the field to leave existing items unchanged." });
  }

  // Validate numeric coercion up-front so invalid values don't reach Postgres as NaN.
  if (Array.isArray(line_items)) {
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
  }

  const { data: current, error: fetchErr } = await admin
    .from("invoices").select("id, vendor_id, status").eq("id", invoiceId).maybeSingle();
  if (fetchErr) return send(500, { error: fetchErr.message });
  if (!current || current.vendor_id !== vendorId) return send(403, { error: "Invoice not found or not yours" });
  if (current.status !== "submitted") {
    return send(409, { error: `Cannot edit invoice in status "${current.status}" — contact your Ring of Fire reviewer for changes.` });
  }

  const patch = { updated_at: new Date().toISOString() };
  if (invoice_number !== undefined) patch.invoice_number = String(invoice_number).trim();
  if (invoice_date !== undefined) patch.invoice_date = invoice_date || null;
  if (due_date !== undefined) patch.due_date = due_date || null;
  if (currency !== undefined) patch.currency = String(currency || "USD").toUpperCase();
  if (subtotal !== undefined) patch.subtotal = subtotal != null && Number.isFinite(Number(subtotal)) ? Number(subtotal) : null;
  if (tax !== undefined) patch.tax = tax != null && Number.isFinite(Number(tax)) ? Number(tax) : 0;
  if (total !== undefined) patch.total = total != null && Number.isFinite(Number(total)) ? Number(total) : null;
  if (notes !== undefined) patch.notes = notes ? String(notes).trim() : null;
  if (file_url !== undefined) {
    if (file_url && (typeof file_url !== "string" || !file_url.startsWith(`${vendorId}/`))) {
      return send(403, { error: "file_url must be under the caller's vendor folder" });
    }
    patch.file_url = file_url || null;
  }
  if (file_description !== undefined) patch.file_description = file_description ? String(file_description).trim() : null;
  if (payment_terms !== undefined) patch.payment_terms = payment_terms ? String(payment_terms).trim() : null;

  if (Object.keys(patch).length > 1) {
    // Compound-WHERE so the UPDATE itself enforces the status='submitted'
    // gate, closing the race where two concurrent PATCHes both pass the
    // initial check while the row's status is flipping to under_review.
    // Returning="*" lets us detect zero-row updates (status changed
    // between read and write) and surface a 409 instead of silently
    // letting one race winner update an invoice mid-review.
    const { data: updated, error: upErr } = await admin
      .from("invoices")
      .update(patch)
      .eq("id", invoiceId)
      .eq("vendor_id", vendorId)
      .eq("status", "submitted")
      .select("id");
    if (upErr) {
      if (upErr.code === "23505") return send(409, { error: "Invoice number already in use for this vendor" });
      return send(500, { error: upErr.message });
    }
    if (!updated || updated.length === 0) {
      return send(409, { error: "Invoice is no longer in 'submitted' status — refresh and re-check." });
    }
  }

  if (Array.isArray(line_items)) {
    // Snapshot the current lines before the destructive swap so we can
    // roll back if the INSERT half fails — prevents data loss from a
    // partial DELETE+INSERT when the new rows are rejected.
    const { data: oldRows, error: snapErr } = await admin
      .from("invoice_line_items").select("*").eq("invoice_id", invoiceId);
    if (snapErr) return send(500, { error: snapErr.message });

    const { error: delErr } = await admin.from("invoice_line_items").delete().eq("invoice_id", invoiceId);
    if (delErr) return send(500, { error: delErr.message });

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
    const { error: insErr } = await admin.from("invoice_line_items").insert(rows);
    if (insErr) {
      // Restore the old lines so the invoice isn't left in a zero-lines state.
      if (oldRows && oldRows.length > 0) {
        await admin.from("invoice_line_items").insert(oldRows);
      }
      return send(500, { error: insErr.message });
    }
  }

  const { data: updated } = await admin.from("invoices").select("*").eq("id", invoiceId).maybeSingle();
  return send(200, updated);
}
