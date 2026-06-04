// api/internal/b2b-price-list/[id]
//
// GET    — fetch a single b2b_price_list row (with customer + style embeds).
// PATCH  — update mutable fields. id + entity_id are LOCKED. Mutable:
//          customer_id, customer_tier, style_id, currency, price_cents,
//          min_qty, effective_from, effective_to, is_active.
// DELETE — hard-delete the price-list row.
//
// Tangerine P18-F — internal B2B admin.

import { createClient } from "@supabase/supabase-js";
import { parseOptionalDate } from "./index.js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY_RE = /^[A-Z]{3}$/;

const MUTABLE_FIELDS = new Set([
  "customer_id", "customer_tier", "style_id", "currency", "price_cents",
  "min_qty", "effective_from", "effective_to", "is_active",
]);
const LOCKED_FIELDS = new Set(["id", "entity_id"]);

const SELECT_COLS =
  "id, entity_id, customer_id, customer_tier, style_id, currency, price_cents, min_qty, effective_from, effective_to, is_active, created_at, updated_at, " +
  "customer:customers!b2b_price_list_customer_id_fkey(id, name, customer_code), " +
  "style:style_master!b2b_price_list_style_id_fkey(id, style_code, style_name)";

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  // Per feedback_dispatcher_query_not_params: always read path params from req.query.
  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const { data, error } = await admin
      .from("b2b_price_list")
      .select(SELECT_COLS)
      .eq("id", id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Price-list row not found" });
    return res.status(200).json(data);
  }

  if (req.method === "PATCH") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    const v = validatePatch(body || {});
    if (v.error) return res.status(400).json({ error: v.error });
    if (Object.keys(v.data).length === 0) {
      return res.status(400).json({ error: "No mutable fields supplied" });
    }
    const { data, error } = await admin
      .from("b2b_price_list")
      .update(v.data)
      .eq("id", id)
      .select(SELECT_COLS)
      .single();
    if (error) {
      if (error.code === "PGRST116") return res.status(404).json({ error: "Price-list row not found" });
      if (error.code === "23503") return res.status(400).json({ error: "customer_id or style_id does not reference an existing row." });
      return res.status(500).json({ error: error.message });
    }
    return res.status(200).json(data);
  }

  if (req.method === "DELETE") {
    const { data, error } = await admin
      .from("b2b_price_list")
      .delete()
      .eq("id", id)
      .select("id")
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Price-list row not found" });
    return res.status(200).json({ deleted: true, id });
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

export function validatePatch(body) {
  if (body == null || typeof body !== "object") {
    return { error: "Request body must be an object" };
  }
  for (const f of Object.keys(body)) {
    if (LOCKED_FIELDS.has(f)) {
      return { error: `${f} is locked post-creation and cannot be updated` };
    }
  }

  const out = {};
  for (const [k, val] of Object.entries(body)) {
    if (!MUTABLE_FIELDS.has(k)) continue;
    out[k] = val;
  }

  if ("style_id" in out) {
    if (out.style_id == null || String(out.style_id).trim() === "") {
      return { error: "style_id cannot be blanked" };
    }
    out.style_id = String(out.style_id).trim();
  }

  // customer_id is nullable (NULL = default/all). Empty string => NULL.
  if ("customer_id" in out) {
    out.customer_id = out.customer_id == null || String(out.customer_id).trim() === ""
      ? null : String(out.customer_id).trim();
  }

  if ("customer_tier" in out) {
    out.customer_tier = out.customer_tier == null || String(out.customer_tier).trim() === ""
      ? null : String(out.customer_tier).trim();
  }

  if ("currency" in out) {
    const cur = String(out.currency || "").trim().toUpperCase();
    if (!CURRENCY_RE.test(cur)) return { error: "currency must be a 3-letter ISO code" };
    out.currency = cur;
  }

  if ("price_cents" in out) {
    if (out.price_cents == null || out.price_cents === "") {
      return { error: "price_cents cannot be blanked" };
    }
    const n = typeof out.price_cents === "number" ? out.price_cents : parseInt(out.price_cents, 10);
    if (!Number.isInteger(n) || n < 0) {
      return { error: "price_cents must be a non-negative integer" };
    }
    out.price_cents = n;
  }

  if ("min_qty" in out) {
    if (out.min_qty == null || out.min_qty === "") {
      out.min_qty = 0;
    } else {
      const n = typeof out.min_qty === "number" ? out.min_qty : parseFloat(out.min_qty);
      if (!Number.isFinite(n) || n < 0) {
        return { error: "min_qty must be a non-negative number" };
      }
      out.min_qty = n;
    }
  }

  if ("effective_from" in out) {
    const d = parseOptionalDate(out.effective_from);
    if (d === false) return { error: "effective_from must be YYYY-MM-DD" };
    out.effective_from = d;
  }
  if ("effective_to" in out) {
    const d = parseOptionalDate(out.effective_to);
    if (d === false) return { error: "effective_to must be YYYY-MM-DD" };
    out.effective_to = d;
  }
  if ("effective_from" in out && "effective_to" in out &&
      out.effective_from && out.effective_to && out.effective_from > out.effective_to) {
    return { error: "effective_from must be on or before effective_to" };
  }

  if ("is_active" in out && typeof out.is_active !== "boolean") {
    out.is_active = out.is_active === "true" || out.is_active === 1;
  }

  return { data: out };
}
