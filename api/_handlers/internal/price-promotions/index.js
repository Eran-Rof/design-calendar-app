// api/internal/price-promotions
//
// M43 — promotions layered on the resolved list price.
//   GET  ?q=&include_inactive=  → promos for the default entity (style/customer embedded)
//   POST { name, discount_type('percent'|'amount'), discount_value, code?,
//          style_id?, brand_id?, customer_id?, customer_tier?, min_qty?,
//          effective_from?, effective_to?, priority?, is_active? }

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
async function resolveDefaultEntityId(admin) {
  const { data } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
  return data?.id || null;
}
const COLS =
  "id, entity_id, code, name, discount_type, discount_value, style_id, brand_id, customer_id, customer_tier, " +
  "min_qty, effective_from, effective_to, priority, is_active, created_at, updated_at, " +
  "style:style_master!price_promotions_style_id_fkey(id, style_code, style_name), " +
  "customer:customers!price_promotions_customer_id_fkey(id, name)";

export function validatePromo(body, { isCreate }) {
  const out = {};
  if (isCreate && (!body.name || !String(body.name).trim())) return { error: "name is required" };
  if (body.name != null) out.name = String(body.name).trim();
  if (isCreate || body.discount_type !== undefined) {
    if (!["percent", "amount"].includes(body.discount_type)) return { error: "discount_type must be 'percent' or 'amount'" };
    out.discount_type = body.discount_type;
  }
  if (isCreate || body.discount_value !== undefined) {
    const v = Number(body.discount_value);
    if (!Number.isFinite(v) || v < 0) return { error: "discount_value must be >= 0" };
    if ((out.discount_type || body.discount_type) === "percent" && v > 100) return { error: "percent discount cannot exceed 100" };
    out.discount_value = v;
  }
  if (body.code !== undefined) out.code = body.code ? String(body.code).trim().toUpperCase() : null;
  for (const f of ["style_id", "brand_id", "customer_id"]) {
    if (body[f] !== undefined) {
      const set = body[f] != null && body[f] !== "";
      if (set && !UUID_RE.test(String(body[f]))) return { error: `${f} must be a uuid` };
      out[f] = set ? String(body[f]) : null;
    }
  }
  if (body.customer_tier !== undefined) out.customer_tier = body.customer_tier ? String(body.customer_tier).trim() : null;
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
  if (body.priority !== undefined) { const p = parseInt(body.priority, 10); out.priority = Number.isFinite(p) ? p : 0; }
  if (body.is_active !== undefined) out.is_active = !!body.is_active;
  return { data: out };
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });
  const entityId = await resolveDefaultEntityId(admin);
  if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
    const q = (url.searchParams.get("q") || "").trim();
    const includeInactive = url.searchParams.get("include_inactive") === "true";
    let query = admin.from("price_promotions").select(COLS).eq("entity_id", entityId).order("priority", { ascending: false }).order("created_at", { ascending: false });
    if (!includeInactive) query = query.eq("is_active", true);
    if (q) query = query.or(`name.ilike.%${q}%,code.ilike.%${q}%`);
    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data || []);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const v = validatePromo(body || {}, { isCreate: true });
    if (v.error) return res.status(400).json({ error: v.error });
    const { data, error } = await admin.from("price_promotions").insert({ entity_id: entityId, ...v.data }).select(COLS).single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json(data);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

export { resolveDefaultEntityId };
