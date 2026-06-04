// api/internal/price-promotions/:id
//   GET / PATCH / DELETE one promotion.

import { createClient } from "@supabase/supabase-js";
import { validatePromo } from "./index.js";

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
const COLS =
  "id, entity_id, code, name, discount_type, discount_value, style_id, brand_id, customer_id, customer_tier, " +
  "min_qty, effective_from, effective_to, priority, is_active, created_at, updated_at, " +
  "style:style_master!price_promotions_style_id_fkey(id, style_code, style_name), " +
  "customer:customers!price_promotions_customer_id_fkey(id, name)";

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: "Invalid id" });
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const { data, error } = await admin.from("price_promotions").select(COLS).eq("id", id).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Not found" });
    return res.status(200).json(data);
  }

  if (req.method === "PATCH") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const v = validatePromo(body || {}, { isCreate: false });
    if (v.error) return res.status(400).json({ error: v.error });
    if (Object.keys(v.data).length === 0) return res.status(400).json({ error: "no updatable fields" });
    const { data, error } = await admin.from("price_promotions").update(v.data).eq("id", id).select(COLS).single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  if (req.method === "DELETE") {
    const { error } = await admin.from("price_promotions").delete().eq("id", id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
