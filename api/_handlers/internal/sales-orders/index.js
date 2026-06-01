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
import { applyBrandScope, applyChannelScope } from "../../../_lib/brandContext.js";

export const config = { maxDuration: 20 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ["draft", "confirmed", "allocated", "fulfilling", "shipped", "invoiced", "closed", "cancelled"];

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
  const { data } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  return data || null;
}

const SELECT_COLS =
  "id, entity_id, brand_id, channel_id, customer_id, ship_to_location_id, so_number, " +
  "order_date, requested_ship_date, cancel_date, status, currency, payment_terms_id, " +
  "ar_account_id, revenue_account_id, notes, subtotal_cents, total_cents, created_at, updated_at";

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
      revenue_account_id: l.revenue_account_id && UUID_RE.test(String(l.revenue_account_id)) ? l.revenue_account_id : null,
    });
  }
  if (normLines.length === 0) return { error: "at least one line with qty_ordered > 0 is required" };

  const nz = (k) => (body[k] && UUID_RE.test(String(body[k])) ? body[k] : null);
  return {
    data: {
      customer_id: body.customer_id,
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
      lines: normLines,
    },
  };
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

    let query = admin.from("sales_orders").select(SELECT_COLS)
      .eq("entity_id", entity.id)
      .order("order_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(limit);
    query = applyBrandScope(query, req);
    query = applyChannelScope(query, req);
    if (status) query = query.eq("status", status);
    if (customerId && UUID_RE.test(customerId)) query = query.eq("customer_id", customerId);
    if (q) query = query.ilike("so_number", `%${q}%`);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data || []);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const v = validateInsert(body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    const subtotal = v.data.lines.reduce((s, l) => s + l.line_total_cents, 0);
    const { data: header, error: hErr } = await admin.from("sales_orders").insert({
      entity_id: entity.id,
      customer_id: v.data.customer_id,
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
      subtotal_cents: subtotal,
      total_cents: subtotal,
    }).select(SELECT_COLS).single();
    if (hErr) return res.status(500).json({ error: hErr.message });

    const lineRows = v.data.lines.map((l) => ({ ...l, sales_order_id: header.id }));
    const { error: lErr } = await admin.from("sales_order_lines").insert(lineRows);
    if (lErr) return res.status(500).json({ error: `Header saved (${header.id}) but lines failed: ${lErr.message}` });

    return res.status(201).json(header);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
