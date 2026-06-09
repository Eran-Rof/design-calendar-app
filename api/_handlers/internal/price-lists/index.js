// api/internal/price-lists
//
// M43 — named price lists (CRUD list/create). Scope is exactly one of:
//   customer_id (per-customer own list) | customer_tier (per-tier) | is_default.
//
// GET  ?q=&include_inactive=   → lists for the default entity (+ customer name,
//                                + item_count). Active-only unless include_inactive.
// POST { name, currency?, customer_id?, customer_tier?, is_default? }
//        `code` is AUTO-GENERATED (PL-NNNNN) by a DB trigger and is immutable —
//        any client-supplied code is ignored on create and frozen on update.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY_RE = /^[A-Z]{3}$/;

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
const SELECT_COLS =
  "id, entity_id, code, name, currency, customer_id, customer_tier, is_default, is_active, created_at, updated_at, " +
  "customer:customers!price_lists_customer_id_fkey(id, name, customer_code)";

// Validate the one-scope rule + shape. Returns {data} or {error}.
function validate(body, { isCreate }) {
  const out = {};
  // `code` is auto-generated (PL-NNNNN) + immutable (DB trigger) — never
  // accepted on create, never patched on update.
  if (isCreate) {
    if (!body.name || !String(body.name).trim()) return { error: "name is required" };
    out.name = String(body.name).trim();
  } else {
    if (body.name != null) out.name = String(body.name).trim();
  }
  if (body.currency != null) {
    const c = String(body.currency).trim().toUpperCase();
    if (!CURRENCY_RE.test(c)) return { error: "currency must be a 3-letter code" };
    out.currency = c;
  }
  const custSet = body.customer_id != null && body.customer_id !== "";
  const tierSet = body.customer_tier != null && body.customer_tier !== "";
  if (custSet && tierSet) return { error: "set at most one of customer_id / customer_tier" };
  if (body.customer_id !== undefined) {
    if (custSet && !UUID_RE.test(String(body.customer_id))) return { error: "customer_id must be a uuid" };
    out.customer_id = custSet ? String(body.customer_id) : null;
  }
  if (body.customer_tier !== undefined) out.customer_tier = tierSet ? String(body.customer_tier).trim() : null;
  if (body.is_default !== undefined) out.is_default = !!body.is_default;
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
    let query = admin.from("price_lists").select(SELECT_COLS).eq("entity_id", entityId).order("code");
    if (!includeInactive) query = query.eq("is_active", true);
    if (q) query = query.or(`code.ilike.%${q}%,name.ilike.%${q}%`);
    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    // item counts
    const ids = (data || []).map((l) => l.id);
    const counts = {};
    if (ids.length) {
      const { data: items } = await admin.from("price_list_items").select("price_list_id").in("price_list_id", ids);
      for (const it of items || []) counts[it.price_list_id] = (counts[it.price_list_id] || 0) + 1;
    }
    return res.status(200).json((data || []).map((l) => ({ ...l, item_count: counts[l.id] || 0 })));
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const v = validate(body || {}, { isCreate: true });
    if (v.error) return res.status(400).json({ error: v.error });
    const { data, error } = await admin.from("price_lists").insert({ entity_id: entityId, ...v.data }).select(SELECT_COLS).single();
    if (error) return res.status(error.code === "23505" ? 409 : 500).json({ error: error.message });
    return res.status(201).json(data);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

export { validate };
