// api/internal/purchase-orders/:id
//
// P16 / M11.
// GET    → header + lines.
// PATCH  → update mutable header fields, replace lines (drafts only), and/or
//          change status. Issuing (status → 'issued') assigns the immutable
//          po_number (PO-YYYY-NNNNN) if not already set.
// DELETE → only a draft PO (cascades lines).
//
// Status flow: draft → issued → in_transit → received → cancelled.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 20 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ["draft", "issued", "in_transit", "received", "cancelled"];

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}

async function nextPoNumber(admin, entityId, year) {
  const prefix = `PO-${year}-`;
  const { count } = await admin.from("purchase_orders")
    .select("id", { count: "exact", head: true })
    .eq("entity_id", entityId)
    .ilike("po_number", `${prefix}%`);
  return `${prefix}${String((count || 0) + 1).padStart(5, "0")}`;
}

export default async function handler(req, res, params) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  const id = params?.id || req.query?.id;
  if (!id || !UUID_RE.test(String(id))) return res.status(400).json({ error: "Invalid id" });
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: po, error: poErr } = await admin.from("purchase_orders").select("*").eq("id", id).maybeSingle();
  if (poErr) return res.status(500).json({ error: poErr.message });
  if (!po) return res.status(404).json({ error: "Purchase order not found" });

  if (req.method === "GET") {
    const { data: lines, error: lErr } = await admin.from("purchase_order_lines")
      .select("*").eq("purchase_order_id", id).order("line_number", { ascending: true });
    if (lErr) return res.status(500).json({ error: lErr.message });
    return res.status(200).json({ ...po, lines: lines || [] });
  }

  if (req.method === "DELETE") {
    if (po.status !== "draft") return res.status(409).json({ error: "Only a draft purchase order can be deleted (cancel an issued one instead)." });
    const { error } = await admin.from("purchase_orders").delete().eq("id", id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  if (req.method === "PATCH") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    body = body || {};

    const patch = {};
    const nz = (k) => (body[k] && UUID_RE.test(String(body[k])) ? body[k] : null);
    for (const k of ["brand_id", "payment_terms_id"]) {
      if (k in body) patch[k] = nz(k);
    }
    if ("vendor_id" in body) {
      if (!UUID_RE.test(String(body.vendor_id))) return res.status(400).json({ error: "vendor_id must be a uuid" });
      patch.vendor_id = body.vendor_id;
    }
    for (const k of ["order_date", "expected_date"]) {
      if (k in body) patch[k] = /^\d{4}-\d{2}-\d{2}$/.test(body[k] || "") ? body[k] : null;
    }
    if ("notes" in body) patch.notes = body.notes ? String(body.notes).trim() : null;

    if ("status" in body) {
      if (!STATUSES.includes(body.status)) return res.status(400).json({ error: `status must be one of ${STATUSES.join(", ")}` });
      patch.status = body.status;
      // Assign the immutable PO number when first issued (po_number is immutable once set).
      if (body.status === "issued" && !po.po_number) {
        const year = (po.order_date || new Date().toISOString().slice(0, 10)).slice(0, 4);
        patch.po_number = await nextPoNumber(admin, po.entity_id, year);
      }
    }

    // Replace lines if supplied (drafts only — issued POs are line-locked here).
    if (Array.isArray(body.lines)) {
      if (po.status !== "draft" && !("status" in body)) {
        return res.status(409).json({ error: "Lines can only be edited while the order is a draft." });
      }
      const norm = [];
      let ln = 1;
      for (const l of body.lines) {
        const qty = Number(l.qty_ordered);
        if (!Number.isFinite(qty) || qty <= 0) continue;
        const unit = l.unit_cost_cents == null || l.unit_cost_cents === "" ? 0 : Math.round(Number(l.unit_cost_cents));
        norm.push({
          purchase_order_id: id, line_number: ln++,
          inventory_item_id: l.inventory_item_id && UUID_RE.test(String(l.inventory_item_id)) ? l.inventory_item_id : null,
          description: l.description ? String(l.description).trim() : null,
          qty_ordered: qty, unit_cost_cents: unit, line_total_cents: Math.round(qty * unit),
        });
      }
      await admin.from("purchase_order_lines").delete().eq("purchase_order_id", id);
      if (norm.length) {
        const { error: lErr } = await admin.from("purchase_order_lines").insert(norm);
        if (lErr) return res.status(500).json({ error: `Line update failed: ${lErr.message}` });
      }
      const subtotal = norm.reduce((s, l) => s + l.line_total_cents, 0);
      patch.subtotal_cents = subtotal;
      patch.total_cents = subtotal;
    }

    if (Object.keys(patch).length === 0) return res.status(200).json(po);
    const { data, error } = await admin.from("purchase_orders").update(patch).eq("id", id).select("*").single();
    if (error) return res.status(500).json({ error: error.message });

    // P13/C0 — open-PO commitment tracking (off-balance-sheet, D3).
    // On first issue, record one po_commitments row per line; on cancel, close them.
    if ("status" in body) {
      if (body.status === "issued" && po.status !== "issued") {
        const { count } = await admin.from("po_commitments")
          .select("id", { count: "exact", head: true }).eq("purchase_order_id", id);
        if (!count) {
          const { data: lines } = await admin.from("purchase_order_lines")
            .select("id, line_total_cents, qty_ordered").eq("purchase_order_id", id);
          const rows = (lines || [])
            .filter((l) => Number(l.qty_ordered) > 0)
            .map((l) => ({
              entity_id: data.entity_id, purchase_order_id: id, purchase_order_line_id: l.id,
              vendor_id: data.vendor_id, committed_amount_cents: Number(l.line_total_cents) || 0,
              status: "open", expected_in_dc_date: data.expected_date || null,
            }));
          if (rows.length) await admin.from("po_commitments").insert(rows);
        }
      } else if (body.status === "cancelled") {
        await admin.from("po_commitments")
          .update({ status: "cancelled", closed_at: new Date().toISOString() })
          .eq("purchase_order_id", id).in("status", ["open", "partial"]);
      }
    }
    return res.status(200).json(data);
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
