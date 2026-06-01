// api/internal/customer-master
//
// GET  — list customers for the default entity. By default returns
//        status='active' rows only; ?include_inactive=true returns all
//        non-deleted rows. Query params:
//          ?q=<search>             — ilike match on name, code, customer_code
//          ?customer_type=<type>   — filter by customer_type
//          ?include_inactive=true  — include inactive/on_hold rows
//          ?limit=N                — default 200, max 500
//        tax_exempt_certificate is OMITTED from list responses (PII-adjacent).
// POST — create a customer. Body: { name (required), code, customer_type,
//        country, payment_terms, default_currency, tax_exempt,
//        tax_exempt_certificate, credit_limit, credit_limit_cents,
//        status, billing_address, shipping_address,
//        contact_name, contact_title, email, phone, website, wechat_id,
//        default_gl_ar_account_id, default_gl_revenue_account_id }
//
// Tangerine P1 Chunk 7c (M36 Customer Master admin).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const CUSTOMER_TYPES = ["wholesale", "ecom", "showroom", "employee", "other"];
const STATUS_VALUES  = ["active", "inactive", "on_hold"];

// Columns returned for LIST responses. tax_exempt_certificate intentionally omitted.
const LIST_COLUMNS = [
  "id", "entity_id", "customer_code", "code", "name", "parent_customer_id",
  "customer_tier", "country", "channel_id", "customer_type",
  "default_gl_ar_account_id", "default_gl_revenue_account_id",
  // P16 — SO routing defaults (brand/channel prefill + per-line revenue routing).
  "default_brand_id", "default_channel_id",
  "default_revenue_account_id", "default_returns_account_id", "default_cogs_account_id",
  "payment_terms", "payment_terms_id",
  "default_currency", "tax_exempt", "credit_limit",
  "credit_limit_cents", "credit_limit_currency",
  "status", "billing_address", "shipping_address", "attributes",
  "active", "external_refs", "created_at", "updated_at", "deleted_at",
].join(", ");

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
    const customerType = (url.searchParams.get("customer_type") || "").trim();
    const q = (url.searchParams.get("q") || "").trim();
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "200", 10) || 200, 500);

    let query = admin
      .from("customers")
      .select(LIST_COLUMNS)
      .eq("entity_id", entityId)
      .is("deleted_at", null)
      .order("name", { ascending: true })
      .limit(limit);

    if (!includeInactive) query = query.eq("status", "active");
    if (customerType) {
      if (!CUSTOMER_TYPES.includes(customerType)) {
        return res.status(400).json({ error: `customer_type must be one of ${CUSTOMER_TYPES.join(", ")}` });
      }
      query = query.eq("customer_type", customerType);
    }
    if (q) {
      const esc = q.replace(/[,()]/g, " ");
      query = query.or(`name.ilike.%${esc}%,code.ilike.%${esc}%,customer_code.ilike.%${esc}%`);
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

    const row = {
      entity_id: entityId,
      name: v.data.name,
      code: v.data.code || null,
      customer_type: v.data.customer_type || "wholesale",
      country: v.data.country || null,
      payment_terms: v.data.payment_terms || null,
      payment_terms_id: v.data.payment_terms_id || null,
      default_currency: v.data.default_currency || "USD",
      tax_exempt: v.data.tax_exempt === true,
      credit_limit: v.data.credit_limit != null ? v.data.credit_limit : null,
      credit_limit_cents: v.data.credit_limit_cents ?? null,
      credit_limit_currency: v.data.credit_limit_currency ?? null,
      status: v.data.status || "active",
      billing_address: v.data.billing_address || {},
      shipping_address: v.data.shipping_address || {},
      default_gl_ar_account_id: v.data.default_gl_ar_account_id || null,
      default_gl_revenue_account_id: v.data.default_gl_revenue_account_id || null,
      contact_name: v.data.contact_name || null,
      contact_title: v.data.contact_title || null,
      email: v.data.email || null,
      phone: v.data.phone || null,
      website: v.data.website || null,
      wechat_id: v.data.wechat_id || null,
    };

    const { data, error } = await admin
      .from("customers")
      .insert(row)
      .select(LIST_COLUMNS)
      .single();

    if (error) {
      if (error.code === "23505") {
        return res.status(409).json({ error: `code '${row.code}' already exists for this entity` });
      }
      return res.status(500).json({ error: error.message });
    }
    return res.status(201).json(data);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

export function validateInsert(body) {
  if (body == null || typeof body !== "object") {
    return { error: "Request body must be an object" };
  }
  if (!body.name || !String(body.name).trim()) {
    return { error: "name is required" };
  }
  // tax_exempt_certificate is PII-workflow-only — never accepted via this endpoint.
  if (body.tax_exempt_certificate != null && String(body.tax_exempt_certificate).trim() !== "") {
    return { error: "tax_exempt_certificate must be set via the dedicated PII workflow, not this endpoint" };
  }
  const out = { ...body };
  out.name = String(out.name).trim();
  if (out.code != null) {
    out.code = String(out.code).trim() || null;
  }

  if (out.customer_type != null && out.customer_type !== "") {
    if (!CUSTOMER_TYPES.includes(out.customer_type)) {
      return { error: `customer_type must be one of ${CUSTOMER_TYPES.join(", ")}` };
    }
  }
  if (out.status != null && out.status !== "") {
    if (!STATUS_VALUES.includes(out.status)) {
      return { error: `status must be one of ${STATUS_VALUES.join(", ")}` };
    }
  }
  if (out.default_currency != null && out.default_currency !== "") {
    const ccy = String(out.default_currency).toUpperCase();
    if (!/^[A-Z]{3}$/.test(ccy)) {
      return { error: "default_currency must be a 3-letter ISO code (e.g. USD)" };
    }
    out.default_currency = ccy;
  }
  if (out.credit_limit != null && out.credit_limit !== "") {
    const n = typeof out.credit_limit === "number" ? out.credit_limit : parseFloat(out.credit_limit);
    if (!Number.isFinite(n)) {
      return { error: "credit_limit must be a number" };
    }
    if (n < 0) {
      return { error: "credit_limit must be >= 0" };
    }
    out.credit_limit = n;
  } else {
    out.credit_limit = null;
  }
  // P4-7: credit_limit_cents (bigint cents) is the canonical credit-gate field.
  // credit_limit (numeric dollars) is kept for legacy back-compat.
  if (out.credit_limit_cents != null && out.credit_limit_cents !== "") {
    const n = typeof out.credit_limit_cents === "number"
      ? out.credit_limit_cents
      : parseInt(out.credit_limit_cents, 10);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      return { error: "credit_limit_cents must be an integer" };
    }
    if (n < 0) {
      return { error: "credit_limit_cents must be >= 0" };
    }
    out.credit_limit_cents = n;
  } else {
    out.credit_limit_cents = null;
  }
  if (out.credit_limit_currency != null && out.credit_limit_currency !== "") {
    const ccy = String(out.credit_limit_currency).toUpperCase();
    if (!/^[A-Z]{3}$/.test(ccy)) {
      return { error: "credit_limit_currency must be a 3-letter ISO code (e.g. USD)" };
    }
    out.credit_limit_currency = ccy;
  } else {
    out.credit_limit_currency = null;
  }
  if (out.tax_exempt != null && typeof out.tax_exempt !== "boolean") {
    out.tax_exempt = out.tax_exempt === "true" || out.tax_exempt === 1;
  }
  // P3-9: payment_terms_id structured FK. Validate UUID when provided.
  if (out.payment_terms_id != null && out.payment_terms_id !== "") {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(out.payment_terms_id))) {
      return { error: "payment_terms_id must be a valid UUID" };
    }
  } else {
    out.payment_terms_id = null;
  }
  // UUID FK fields — coerce empty string to null.
  for (const k of ["default_gl_ar_account_id", "default_gl_revenue_account_id"]) {
    if (out[k] === "" || out[k] == null) out[k] = null;
  }
  // Free-text contact fields — coerce empty string to null.
  for (const k of ["contact_name", "contact_title", "email", "phone", "website", "wechat_id"]) {
    if (out[k] === "") out[k] = null;
  }
  return { data: out };
}
