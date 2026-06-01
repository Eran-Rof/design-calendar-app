// api/internal/sales-orders/:id
//
// P16 / M10-B.
// GET    → header + lines.
// PATCH  → update mutable header fields, replace lines (when `lines` supplied),
//          and/or change status. Confirming (status → 'confirmed') assigns the
//          immutable so_number (SO-YYYY-NNNNN) if not already set.
// DELETE → only a draft SO (cascades lines).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 20 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ["draft", "confirmed", "allocated", "fulfilling", "shipped", "invoiced", "closed", "cancelled"];
const FACTOR_STATUSES = ["not_submitted", "pending", "approved", "partial", "declined", "not_required"];

// Item 9 — resolve the revenue account to stamp on each SO line: the customer's
// default_revenue_account_id, else the entity default. Returns a uuid or null.
async function resolveLineRevenueAccount(admin, customerId, entityId) {
  let acct = null;
  if (customerId) {
    const { data: cust } = await admin.from("customers").select("default_revenue_account_id").eq("id", customerId).maybeSingle();
    if (cust?.default_revenue_account_id) acct = cust.default_revenue_account_id;
  }
  if (!acct && entityId) {
    const { data: ent } = await admin.from("entities").select("default_revenue_account_id").eq("id", entityId).maybeSingle();
    if (ent?.default_revenue_account_id) acct = ent.default_revenue_account_id;
  }
  return acct || null;
}

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}

async function nextSoNumber(admin, entityId, year) {
  const prefix = `SO-${year}-`;
  const { count } = await admin.from("sales_orders")
    .select("id", { count: "exact", head: true })
    .eq("entity_id", entityId)
    .ilike("so_number", `${prefix}%`);
  return `${prefix}${String((count || 0) + 1).padStart(5, "0")}`;
}

export default async function handler(req, res, params) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  const id = params?.id || req.query?.id;
  if (!id || !UUID_RE.test(String(id))) return res.status(400).json({ error: "Invalid id" });
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: so, error: soErr } = await admin.from("sales_orders").select("*").eq("id", id).maybeSingle();
  if (soErr) return res.status(500).json({ error: soErr.message });
  if (!so) return res.status(404).json({ error: "Sales order not found" });

  if (req.method === "GET") {
    const { data: lines, error: lErr } = await admin.from("sales_order_lines")
      .select("*").eq("sales_order_id", id).order("line_number", { ascending: true });
    if (lErr) return res.status(500).json({ error: lErr.message });
    return res.status(200).json({ ...so, lines: lines || [] });
  }

  if (req.method === "DELETE") {
    if (so.status !== "draft") return res.status(409).json({ error: "Only a draft sales order can be deleted (cancel a confirmed one instead)." });
    const { error } = await admin.from("sales_orders").delete().eq("id", id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  if (req.method === "PATCH") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    body = body || {};

    const patch = {};
    const nz = (k) => (body[k] && UUID_RE.test(String(body[k])) ? body[k] : null);
    for (const k of ["ship_to_location_id", "brand_id", "channel_id", "payment_terms_id", "ar_account_id", "revenue_account_id"]) {
      if (k in body) patch[k] = nz(k);
    }
    if ("customer_id" in body) {
      if (!UUID_RE.test(String(body.customer_id))) return res.status(400).json({ error: "customer_id must be a uuid" });
      patch.customer_id = body.customer_id;
    }
    for (const k of ["order_date", "requested_ship_date", "cancel_date"]) {
      if (k in body) patch[k] = /^\d{4}-\d{2}-\d{2}$/.test(body[k] || "") ? body[k] : null;
    }
    if ("notes" in body) patch.notes = body.notes ? String(body.notes).trim() : null;

    // Item 3 — factor / credit-insurance approval (manual).
    if ("factor_approval_status" in body) {
      const fs = body.factor_approval_status;
      if (fs == null || fs === "") {
        patch.factor_approval_status = "not_submitted";
      } else if (!FACTOR_STATUSES.includes(fs)) {
        return res.status(400).json({ error: `factor_approval_status must be one of ${FACTOR_STATUSES.join(", ")}` });
      } else {
        patch.factor_approval_status = fs;
      }
    }
    if ("factor_reference" in body) patch.factor_reference = body.factor_reference ? String(body.factor_reference).trim() : null;
    if ("factor_approved_cents" in body) {
      if (body.factor_approved_cents == null || body.factor_approved_cents === "") {
        patch.factor_approved_cents = null;
      } else {
        const n = typeof body.factor_approved_cents === "number" ? body.factor_approved_cents : parseInt(body.factor_approved_cents, 10);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return res.status(400).json({ error: "factor_approved_cents must be a non-negative integer" });
        patch.factor_approved_cents = n;
      }
    }

    if ("status" in body) {
      if (!STATUSES.includes(body.status)) return res.status(400).json({ error: `status must be one of ${STATUSES.join(", ")}` });
      patch.status = body.status;
      // Assign the immutable SO number when first confirmed.
      if (body.status === "confirmed" && !so.so_number) {
        const year = (so.order_date || new Date().toISOString().slice(0, 10)).slice(0, 4);
        patch.so_number = await nextSoNumber(admin, so.entity_id, year);
      }
    }

    // Replace lines if supplied (drafts only — confirmed SOs are line-locked here).
    if (Array.isArray(body.lines)) {
      if (so.status !== "draft" && !("status" in body)) {
        // allow line edits only while draft
        return res.status(409).json({ error: "Lines can only be edited while the order is a draft." });
      }
      // Item 9 — revenue is auto-routed from the customer master (entity fallback),
      // not taken from the per-line payload.
      const custForRouting = ("customer_id" in patch ? patch.customer_id : so.customer_id);
      const lineRevenueAccountId = await resolveLineRevenueAccount(admin, custForRouting, so.entity_id);
      const norm = [];
      let ln = 1;
      for (const l of body.lines) {
        const qty = Number(l.qty_ordered);
        if (!Number.isFinite(qty) || qty <= 0) continue;
        const unit = l.unit_price_cents == null || l.unit_price_cents === "" ? 0 : Math.round(Number(l.unit_price_cents));
        norm.push({
          sales_order_id: id, line_number: ln++,
          inventory_item_id: l.inventory_item_id && UUID_RE.test(String(l.inventory_item_id)) ? l.inventory_item_id : null,
          description: l.description ? String(l.description).trim() : null,
          qty_ordered: qty, unit_price_cents: unit, line_total_cents: Math.round(qty * unit),
          revenue_account_id: lineRevenueAccountId,
        });
      }
      await admin.from("sales_order_lines").delete().eq("sales_order_id", id);
      if (norm.length) {
        const { error: lErr } = await admin.from("sales_order_lines").insert(norm);
        if (lErr) return res.status(500).json({ error: `Line update failed: ${lErr.message}` });
      }
      const subtotal = norm.reduce((s, l) => s + l.line_total_cents, 0);
      patch.subtotal_cents = subtotal;
      patch.total_cents = subtotal;
    }

    if (Object.keys(patch).length === 0) return res.status(200).json(so);
    const { data, error } = await admin.from("sales_orders").update(patch).eq("id", id).select("*").single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
