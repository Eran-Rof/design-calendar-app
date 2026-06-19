// api/internal/sales-orders
//
// P16 / M10-B — native Sales Order list + create.
//
// GET  ?status=&customer_id=&q=&limit=   → SO headers for the default entity.
// POST { customer_id, ship_to_location_id?, brand_id?, channel_id?, order_date?,
//        requested_ship_date?, cancel_date?, payment_terms_id?, ar_account_id?,
//        revenue_account_id?, notes?, lines: [{ inventory_item_id?, description?,
//        qty_ordered, unit_price_cents?, revenue_account_id? }] }
//        → creates a DRAFT SO (so_number is assigned later, on confirm).
//
// Brand/channel + entity scoped. Writes via service-role (anon-read RLS).

import { createClient } from "@supabase/supabase-js";
import { applyBrandScope, applyChannelScope, activeBrandId, activeChannelId } from "../../../_lib/brandContext.js";

export const config = { maxDuration: 20 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ["draft", "confirmed", "allocated", "fulfilling", "shipped", "invoiced", "closed", "cancelled"];
const FACTOR_STATUSES = ["not_submitted", "pending", "approved", "partial", "declined", "not_required"];

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID, X-Brand-ID, X-Channel-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}
async function resolveDefaultEntity(admin) {
  const { data } = await admin.from("entities").select("id, default_revenue_account_id").eq("code", "ROF").maybeSingle();
  return data || null;
}

const SELECT_COLS =
  "id, entity_id, brand_id, channel_id, customer_id, ship_to_location_id, so_number, " +
  "order_date, requested_ship_date, cancel_date, status, currency, payment_terms_id, " +
  "ar_account_id, revenue_account_id, notes, customer_po, customer_po_is_placeholder, subtotal_cents, total_cents, fulfillment_source, " +
  "factor_approval_status, factor_reference, factor_approved_cents, buyer_id, " +
  "parent_sales_order_id, is_split_parent, created_at, updated_at";

export function validateInsert(body) {
  if (!body || typeof body !== "object") return { error: "body required" };
  if (!body.customer_id || !UUID_RE.test(String(body.customer_id))) {
    return { error: "customer_id (uuid) required" };
  }
  const lines = Array.isArray(body.lines) ? body.lines : [];
  const normLines = [];
  let ln = 1;
  for (const l of lines) {
    const qty = Number(l.qty_ordered);
    if (!Number.isFinite(qty) || qty <= 0) continue; // skip empty/zero lines
    const unit = l.unit_price_cents == null || l.unit_price_cents === "" ? 0 : Math.round(Number(l.unit_price_cents));
    if (!Number.isFinite(unit) || unit < 0) return { error: `line ${ln}: unit_price_cents must be >= 0` };
    normLines.push({
      line_number: ln++,
      inventory_item_id: l.inventory_item_id && UUID_RE.test(String(l.inventory_item_id)) ? l.inventory_item_id : null,
      description: l.description ? String(l.description).trim() : null,
      qty_ordered: qty,
      unit_price_cents: unit,
      line_total_cents: Math.round(qty * unit),
      // Lot (grain: style+color). Set by customer PO (Scenario 3) or lot-aware
      // ATS allocation (Scenario 5); accepted here so callers can seed it.
      lot_number: l.lot_number != null && String(l.lot_number).trim() !== "" ? String(l.lot_number).trim() : null,
      // Item 9 — revenue_account_id is resolved server-side from the customer
      // (default_revenue_account_id) → entity default; NOT taken from the payload.
    });
  }
  if (normLines.length === 0) return { error: "at least one line with qty_ordered > 0 is required" };

  // Item 3 — factor / credit-insurance approval (manual).
  let factorStatus = "not_submitted";
  if (body.factor_approval_status != null && body.factor_approval_status !== "") {
    if (!FACTOR_STATUSES.includes(body.factor_approval_status)) {
      return { error: `factor_approval_status must be one of ${FACTOR_STATUSES.join(", ")}` };
    }
    factorStatus = body.factor_approval_status;
  }
  let factorApprovedCents = null;
  if (body.factor_approved_cents != null && body.factor_approved_cents !== "") {
    const n = typeof body.factor_approved_cents === "number" ? body.factor_approved_cents : parseInt(body.factor_approved_cents, 10);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return { error: "factor_approved_cents must be a non-negative integer" };
    factorApprovedCents = n;
  }

  const nz = (k) => (body[k] && UUID_RE.test(String(body[k])) ? body[k] : null);
  return {
    data: {
      customer_id: body.customer_id,
      buyer_id: nz("buyer_id"),
      ship_to_location_id: nz("ship_to_location_id"),
      brand_id: nz("brand_id"),
      channel_id: nz("channel_id"),
      order_date: /^\d{4}-\d{2}-\d{2}$/.test(body.order_date || "") ? body.order_date : null,
      requested_ship_date: /^\d{4}-\d{2}-\d{2}$/.test(body.requested_ship_date || "") ? body.requested_ship_date : null,
      cancel_date: /^\d{4}-\d{2}-\d{2}$/.test(body.cancel_date || "") ? body.cancel_date : null,
      payment_terms_id: nz("payment_terms_id"),
      ar_account_id: nz("ar_account_id"),
      revenue_account_id: nz("revenue_account_id"),
      notes: body.notes ? String(body.notes).trim() : null,
      customer_po: body.customer_po ? String(body.customer_po).trim() : null,
      customer_po_is_placeholder: body.customer_po_is_placeholder === true,
      fulfillment_source: ["production", "ats"].includes(body.fulfillment_source) ? body.fulfillment_source : null,
      factor_approval_status: factorStatus,
      factor_reference: body.factor_reference ? String(body.factor_reference).trim() : null,
      factor_approved_cents: factorApprovedCents,
      lines: normLines,
    },
  };
}

// Item 9 — resolve the revenue account to stamp on each SO line: the customer's
// default_revenue_account_id, else the entity default. Returns a uuid or null.
async function resolveLineRevenueAccount(admin, customerId, entity) {
  let acct = null;
  if (customerId) {
    const { data: cust } = await admin.from("customers").select("default_revenue_account_id").eq("id", customerId).maybeSingle();
    if (cust?.default_revenue_account_id) acct = cust.default_revenue_account_id;
  }
  if (!acct && entity?.default_revenue_account_id) acct = entity.default_revenue_account_id;
  return acct || null;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });
  const entity = await resolveDefaultEntity(admin);
  if (!entity) return res.status(500).json({ error: "Default entity (ROF) not found" });

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
    const status = (url.searchParams.get("status") || "").trim();
    const customerId = (url.searchParams.get("customer_id") || "").trim();
    const q = (url.searchParams.get("q") || "").trim();
    let limit = parseInt(url.searchParams.get("limit") || "200", 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 200;
    limit = Math.min(limit, 500);
    if (status && !STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of ${STATUSES.join(", ")}` });

    const custId = customerId && UUID_RE.test(customerId) ? customerId : null;
    let data, error;
    if (q) {
      // All-field search (SO #, notes, customer name/code, and any line's
      // description / SKU sku_code / style_code / description) runs in the
      // search_sales_orders RPC so the line-level match never has to ship a
      // large id.in.(…) URL. NULL brand/channel = "all" unless enforcing.
      ({ data, error } = await admin.rpc("search_sales_orders", {
        p_entity_id: entity.id,
        p_q: q,
        p_status: status || null,
        p_customer_id: custId,
        p_brand_id: activeBrandId(req),
        p_channel_id: activeChannelId(req),
        p_limit: limit,
      }));
    } else {
      let query = admin.from("sales_orders").select(SELECT_COLS)
        .eq("entity_id", entity.id)
        .order("order_date", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(limit);
      query = applyBrandScope(query, req);
      query = applyChannelScope(query, req);
      if (status) query = query.eq("status", status);
      if (custId) query = query.eq("customer_id", custId);
      ({ data, error } = await query);
    }
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data || []);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const v = validateInsert(body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    // Optional buyer must belong to this SO's customer.
    if (v.data.buyer_id) {
      const { data: b } = await admin.from("customer_buyers").select("id, customer_id").eq("id", v.data.buyer_id).maybeSingle();
      if (!b) return res.status(400).json({ error: "buyer_id not found" });
      if (b.customer_id !== v.data.customer_id) return res.status(400).json({ error: "buyer_id must belong to the order's customer" });
    }

    const subtotal = v.data.lines.reduce((s, l) => s + l.line_total_cents, 0);
    const { data: header, error: hErr } = await admin.from("sales_orders").insert({
      entity_id: entity.id,
      customer_id: v.data.customer_id,
      buyer_id: v.data.buyer_id,
      ship_to_location_id: v.data.ship_to_location_id,
      brand_id: v.data.brand_id || undefined, // undefined → DB default rof_default_brand_id()
      channel_id: v.data.channel_id,
      order_date: v.data.order_date || undefined,
      requested_ship_date: v.data.requested_ship_date,
      cancel_date: v.data.cancel_date,
      status: "draft",
      payment_terms_id: v.data.payment_terms_id,
      ar_account_id: v.data.ar_account_id,
      revenue_account_id: v.data.revenue_account_id,
      notes: v.data.notes,
      customer_po: v.data.customer_po,
      customer_po_is_placeholder: v.data.customer_po_is_placeholder,
      fulfillment_source: v.data.fulfillment_source,
      factor_approval_status: v.data.factor_approval_status,
      factor_reference: v.data.factor_reference,
      factor_approved_cents: v.data.factor_approved_cents,
      subtotal_cents: subtotal,
      total_cents: subtotal,
    }).select(SELECT_COLS).single();
    if (hErr) return res.status(500).json({ error: hErr.message });

    // Item 9 — auto-route revenue per customer master (entity default fallback).
    const lineRevenueAccountId = await resolveLineRevenueAccount(admin, v.data.customer_id, entity);
    const lineRows = v.data.lines.map((l) => ({ ...l, revenue_account_id: lineRevenueAccountId, sales_order_id: header.id }));
    const { error: lErr } = await admin.from("sales_order_lines").insert(lineRows);
    if (lErr) return res.status(500).json({ error: `Header saved (${header.id}) but lines failed: ${lErr.message}` });

    return res.status(201).json(header);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
