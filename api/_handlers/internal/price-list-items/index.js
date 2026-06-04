// api/internal/price-list-items
//
// M43 — items (per-style prices + qty breaks) within a price list.
//   GET  ?price_list_id=  → items for a list (style embedded)
//   POST { price_list_id, style_id, price_cents, min_qty?, effective_from?,
//          effective_to?, is_active? }
//
// Multiple rows per (list, style) with different min_qty = quantity breaks
// (UNIQUE(price_list_id, style_id, min_qty)).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}
const ITEM_COLS =
  "id, price_list_id, style_id, price_cents, min_qty, effective_from, effective_to, is_active, " +
  "style:style_master!price_list_items_style_id_fkey(id, style_code, style_name)";

export function validateItem(body, { isCreate }) {
  const out = {};
  if (isCreate) {
    if (!UUID_RE.test(String(body.price_list_id || ""))) return { error: "price_list_id (uuid) required" };
    if (!UUID_RE.test(String(body.style_id || ""))) return { error: "style_id (uuid) required" };
    out.price_list_id = body.price_list_id;
    out.style_id = body.style_id;
  }
  if (isCreate || body.price_cents !== undefined) {
    const p = Math.round(Number(body.price_cents));
    if (!Number.isFinite(p) || p < 0) return { error: "price_cents must be a non-negative integer" };
    out.price_cents = p;
  }
  if (body.min_qty !== undefined) {
    const m = Number(body.min_qty);
    if (!Number.isFinite(m) || m < 0) return { error: "min_qty must be >= 0" };
    out.min_qty = m;
  }
  for (const f of ["effective_from", "effective_to"]) {
    if (body[f] !== undefined) {
      const val = body[f] === "" || body[f] === null ? null : String(body[f]);
      if (val && !DATE_RE.test(val)) return { error: `${f} must be YYYY-MM-DD` };
      out[f] = val;
    }
  }
  if (body.is_active !== undefined) out.is_active = !!body.is_active;
  return { data: out };
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
    const listId = (url.searchParams.get("price_list_id") || "").trim();
    if (!UUID_RE.test(listId)) return res.status(400).json({ error: "price_list_id (uuid) required" });
    const { data, error } = await admin.from("price_list_items").select(ITEM_COLS)
      .eq("price_list_id", listId).order("style_id").order("min_qty");
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data || []);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const v = validateItem(body || {}, { isCreate: true });
    if (v.error) return res.status(400).json({ error: v.error });
    const { data, error } = await admin.from("price_list_items").insert(v.data).select(ITEM_COLS).single();
    if (error) return res.status(error.code === "23505" ? 409 : 500).json({ error: error.code === "23505" ? "a price for this style + min-qty already exists in this list" : error.message });
    return res.status(201).json(data);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
