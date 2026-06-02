// api/internal/price-lists/:id
//
// M43 — one price list: detail (with its items), update, delete.
//   GET    → list + items[] (style_code/name embedded), ordered by style then min_qty
//   PATCH  → update list fields (validate via index.validate)
//   DELETE → delete the list (CASCADE removes its items)

import { createClient } from "@supabase/supabase-js";
import { validate } from "./index.js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}
function client() {
  const u = process.env.VITE_SUPABASE_URL, k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return u && k ? createClient(u, k, { auth: { persistSession: false } }) : null;
}
const LIST_COLS =
  "id, entity_id, code, name, currency, customer_id, customer_tier, is_default, is_active, created_at, updated_at, " +
  "customer:customers!price_lists_customer_id_fkey(id, name, customer_code)";
const ITEM_COLS =
  "id, price_list_id, style_id, price_cents, min_qty, effective_from, effective_to, is_active, " +
  "style:style_master!price_list_items_style_id_fkey(id, style_code, style_name)";

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: "Invalid id" });
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const { data: list, error } = await admin.from("price_lists").select(LIST_COLS).eq("id", id).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!list) return res.status(404).json({ error: "Not found" });
    const { data: items, error: iErr } = await admin.from("price_list_items").select(ITEM_COLS)
      .eq("price_list_id", id).order("style_id").order("min_qty");
    if (iErr) return res.status(500).json({ error: iErr.message });
    return res.status(200).json({ ...list, items: items || [] });
  }

  if (req.method === "PATCH") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const v = validate(body || {}, { isCreate: false });
    if (v.error) return res.status(400).json({ error: v.error });
    if (Object.keys(v.data).length === 0) return res.status(400).json({ error: "no updatable fields" });
    const { data, error } = await admin.from("price_lists").update(v.data).eq("id", id).select(LIST_COLS).single();
    if (error) return res.status(error.code === "23505" ? 409 : 500).json({ error: error.message });
    return res.status(200).json(data);
  }

  if (req.method === "DELETE") {
    const { error } = await admin.from("price_lists").delete().eq("id", id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
