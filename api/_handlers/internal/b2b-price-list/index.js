// api/internal/b2b-price-list
//
// GET  — list B2B wholesale price rows for the default entity (ROF). By default
//        returns is_active=true rows only; ?include_inactive=true returns all.
//        Embeds customer name + style code/name for display.
//        Query:
//          ?q=<search>             — ilike match on customer_tier
//          ?include_inactive=true  — include inactive rows
// POST — create one price-list row. Body:
//          { customer_id? (NULL = default/all customers), customer_tier?,
//            style_id (required, FK style_master), currency (default USD),
//            price_cents (required, >= 0), min_qty (default 0),
//            effective_from?, effective_to?, is_active (default true) }
//
// Resolution at lookup time (handled by the future pricing engine):
//   customer match > tier match > default (customer_id IS NULL).
//
// Tangerine P18-F — internal B2B admin. Mirrors the payment-terms handler shape.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const CURRENCY_RE = /^[A-Z]{3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

async function resolveDefaultEntityId(admin) {
  const { data, error } = await admin
    .from("entities")
    .select("id")
    .eq("code", "ROF")
    .maybeSingle();
  if (error || !data) return null;
  return data.id;
}

const SELECT_COLS =
  "id, entity_id, customer_id, customer_tier, style_id, currency, price_cents, min_qty, effective_from, effective_to, is_active, created_at, updated_at, " +
  "customer:customers!b2b_price_list_customer_id_fkey(id, name, customer_code), " +
  "style:style_master!b2b_price_list_style_id_fkey(id, style_code, style_name)";

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const entityId = await resolveDefaultEntityId(admin);
  if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const includeInactive = url.searchParams.get("include_inactive") === "true";
    const q = (url.searchParams.get("q") || "").trim();

    let query = admin
      .from("b2b_price_list")
      .select(SELECT_COLS)
      .eq("entity_id", entityId)
      .order("created_at", { ascending: false });

    if (!includeInactive) query = query.eq("is_active", true);
    if (q) {
      const esc = q.replace(/[,()]/g, " ");
      query = query.ilike("customer_tier", `%${esc}%`);
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data || []);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    const v = validateInsert(body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    const { data, error } = await admin
      .from("b2b_price_list")
      .insert({ ...v.data, entity_id: entityId })
      .select(SELECT_COLS)
      .single();
    if (error) {
      if (error.code === "23503") {
        return res.status(400).json({ error: "customer_id or style_id does not reference an existing row." });
      }
      return res.status(500).json({ error: error.message });
    }
    return res.status(201).json(data);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

// Shared field coercion for POST. Returns { data } or { error }.
export function validateInsert(body) {
  if (body == null || typeof body !== "object") {
    return { error: "Request body must be an object" };
  }
  if (!body.style_id || !String(body.style_id).trim()) {
    return { error: "style_id is required" };
  }
  if (body.price_cents == null || body.price_cents === "") {
    return { error: "price_cents is required" };
  }
  const priceCents = typeof body.price_cents === "number" ? body.price_cents : parseInt(body.price_cents, 10);
  if (!Number.isInteger(priceCents) || priceCents < 0) {
    return { error: "price_cents must be a non-negative integer" };
  }

  // customer_id is optional (NULL = applies to all customers).
  const customerId = body.customer_id == null || String(body.customer_id).trim() === ""
    ? null : String(body.customer_id).trim();

  const customerTier = body.customer_tier == null || String(body.customer_tier).trim() === ""
    ? null : String(body.customer_tier).trim();

  let currency = "USD";
  if (body.currency != null && String(body.currency).trim() !== "") {
    currency = String(body.currency).trim().toUpperCase();
    if (!CURRENCY_RE.test(currency)) return { error: "currency must be a 3-letter ISO code" };
  }

  let minQty = 0;
  if (body.min_qty != null && body.min_qty !== "") {
    minQty = typeof body.min_qty === "number" ? body.min_qty : parseFloat(body.min_qty);
    if (!Number.isFinite(minQty) || minQty < 0) {
      return { error: "min_qty must be a non-negative number" };
    }
  }

  const effFrom = parseOptionalDate(body.effective_from);
  if (effFrom === false) return { error: "effective_from must be YYYY-MM-DD" };
  const effTo = parseOptionalDate(body.effective_to);
  if (effTo === false) return { error: "effective_to must be YYYY-MM-DD" };
  if (effFrom && effTo && effFrom > effTo) {
    return { error: "effective_from must be on or before effective_to" };
  }

  const isActive = body.is_active == null ? true :
    typeof body.is_active === "boolean" ? body.is_active :
      body.is_active === "true" || body.is_active === 1;

  return {
    data: {
      customer_id:    customerId,
      customer_tier:  customerTier,
      style_id:       String(body.style_id).trim(),
      currency,
      price_cents:    priceCents,
      min_qty:        minQty,
      effective_from: effFrom,
      effective_to:   effTo,
      is_active:      isActive,
    },
  };
}

// Returns: null (blank), a YYYY-MM-DD string (valid), or false (invalid).
export function parseOptionalDate(v) {
  if (v == null || String(v).trim() === "") return null;
  const s = String(v).trim();
  if (!DATE_RE.test(s)) return false;
  return s;
}
