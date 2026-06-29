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
//        contact_name, contact_title, email, phone, website, wechat_id }
//
// GL routing accounts (AR / revenue / returns / COGS) live on the GL Accounts
// tab and use the default_ar_/revenue_/returns_/cogs_account_id columns — the
// only ones the SO + AR posting engines read. The older default_gl_ar/revenue
// pair is retired (no longer written or shown); the columns remain in the DB.
//
// Tangerine P1 Chunk 7c (M36 Customer Master admin).

import { createClient } from "@supabase/supabase-js";
import { insertWithAutoCode } from "../../../_lib/autoCode.js";

export const config = { maxDuration: 15 };

// Chunk M — customer codes are server-generated + read-only (operator item 14).
const CODE_PREFIX = "CUST-";
const CUSTOMER_TYPES = ["wholesale", "ecom", "showroom", "employee", "other"];
const STATUS_VALUES  = ["active", "inactive", "on_hold"];

// Conservative Title-Case for NEW customer names: only re-cases tokens that are
// all-lowercase, leaving acronyms (ROF, BMO, EDI, FBM, USA), mixed-case brands
// (eBay, McGraw), and known legal suffixes (LLC, Inc., Ltd.) untouched. Existing
// names are NOT touched here — bulk initcap would mangle acronyms/suffixes.
// Mirrors titleCaseVendorName in vendor-master/index.js.
const PRESERVE_TOKENS = new Set([
  "LLC", "L.L.C.", "INC", "INC.", "LTD", "LTD.", "CO", "CO.", "CORP", "CORP.",
  "HK", "EDI", "USA", "US", "UK", "EU", "ROF", "BMO", "DBA", "PLC", "GMBH",
  "FBM", "JLC", "NV", "SC", "SW", "SWFM", "CSX",
]);
export function titleCaseCustomerName(raw) {
  const s = String(raw).trim().replace(/\s+/g, " ");
  if (!s) return s;
  return s
    .split(" ")
    .map((tok) => {
      // Already mixed-case (e.g. "Corp", "eBay", "McGraw") — leave verbatim so
      // we never re-mangle a nicely-cased token into an acronym.
      if (/[a-z]/.test(tok) && /[A-Z]/.test(tok)) return tok;
      const upper = tok.toUpperCase();
      // Preserve known acronyms / legal suffixes verbatim (upper-cased). Only
      // reached for uniformly-cased tokens (all-caps or all-lowercase).
      if (PRESERVE_TOKENS.has(upper)) return upper;
      // Leave anything already containing an uppercase letter alone (acronyms,
      // brand casing) — only fix fully-lowercase tokens.
      if (/[A-Z]/.test(tok)) return tok;
      // Fully lowercase word → capitalize first letter.
      return tok.charAt(0).toUpperCase() + tok.slice(1);
    })
    .join(" ");
}

// Columns returned for LIST responses. tax_exempt_certificate intentionally omitted.
const LIST_COLUMNS = [
  "id", "entity_id", "customer_code", "code", "name", "parent_customer_id",
  "customer_tier", "country", "channel_id", "customer_type",
  // P16 — SO routing defaults (brand/channel prefill + per-line revenue routing).
  "default_brand_id", "default_channel_id",
  "default_revenue_account_id", "default_returns_account_id", "default_cogs_account_id",
  "payment_terms", "payment_terms_id",
  "default_currency", "tax_exempt", "credit_limit",
  "credit_limit_cents", "credit_limit_currency",
  // Chunk K — customer factoring (operator item 17).
  "is_factored", "factor_id",
  // P4-family sales-rep / default / GL-routing columns.
  "sales_rep_1_id",
  "sales_rep_1_commission_pct",
  "sales_rep_2_id",
  "sales_rep_2_commission_pct",
  "closeout_commission_pct",
  "default_brand_id",
  "default_channel_id",
  "default_revenue_account_id",
  "default_returns_account_id",
  "default_cogs_account_id",
  "default_ar_account_id",
  "price_list_id",
  "status", "billing_address", "shipping_address", "attributes",
  "contacts",
  "active", "external_refs", "created_at", "updated_at", "deleted_at",
].join(", ");

// Up to 12 contacts, each {id,name,email,phone,title,department} (strings only).
// `id` is a stable per-contact key (lets customer_contact_notes attach to a
// contact); preserved verbatim. Blank rows are dropped; beyond `max` truncated.
export function sanitizeContacts(raw, max) {
  if (raw == null) return undefined;
  if (!Array.isArray(raw)) return { error: "contacts must be an array" };
  const keys = ["id", "name", "email", "phone", "title", "department"];
  const out = [];
  for (const c of raw) {
    if (c == null || typeof c !== "object") continue;
    const row = {};
    for (const k of keys) {
      const val = c[k];
      if (val != null && String(val).trim() !== "") row[k] = String(val).trim();
    }
    // An id-only row (no name/email/phone) is still blank → dropped below.
    if (Object.keys(row).filter((k) => k !== "id").length) out.push(row);
    if (out.length >= max) break;
  }
  return out;
}

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
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "1000", 10) || 1000, 5000);

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

    // Chunk M — `code` is always server-generated; any client-supplied code is ignored.
    const buildRow = (code) => ({
      entity_id: entityId,
      name: v.data.name,
      // customer_code is NOT NULL (legacy Xoro ref). App-created customers have no
      // Xoro ref, so default it to the generated code (CUST-NNNNN) — fixes the
      // "null value in column customer_code" error when adding a customer on the fly.
      customer_code: v.data.customer_code != null && String(v.data.customer_code).trim() !== "" ? String(v.data.customer_code).trim() : code,
      code,
      customer_type: v.data.customer_type || "wholesale",
      country: v.data.country || null,
      payment_terms: v.data.payment_terms || null,
      payment_terms_id: v.data.payment_terms_id || null,
      default_currency: v.data.default_currency || "USD",
      tax_exempt: v.data.tax_exempt === true,
      credit_limit: v.data.credit_limit != null ? v.data.credit_limit : null,
      // credit_limit_cents (NOT NULL default 0) + credit_limit_currency (NOT NULL
      // default 'USD'): default to the column defaults rather than null, else an
      // on-the-fly add (which sends neither) overrides the default with an explicit
      // null and trips the not-null constraint (operator item 14, second cause).
      credit_limit_cents: v.data.credit_limit_cents ?? 0,
      credit_limit_currency: v.data.credit_limit_currency ?? "USD",
      // Chunk K — customer factoring (operator item 17).
      is_factored: v.data.is_factored === true,
      factor_id: v.data.factor_id || null,
      status: v.data.status || "active",
      billing_address: v.data.billing_address || {},
      shipping_address: v.data.shipping_address || {},
      // P4-family sales-rep / default / GL-routing columns.
      sales_rep_1_id: v.data.sales_rep_1_id || null,
      // sales_rep_*_commission_pct are NOT NULL default 0 — default to 0, not null,
      // so an on-the-fly add (which omits them) doesn't override the default and trip
      // the not-null constraint. closeout_commission_pct IS nullable, so it stays null.
      sales_rep_1_commission_pct: v.data.sales_rep_1_commission_pct ?? 0,
      sales_rep_2_id: v.data.sales_rep_2_id || null,
      sales_rep_2_commission_pct: v.data.sales_rep_2_commission_pct ?? 0,
      closeout_commission_pct: v.data.closeout_commission_pct ?? null,
      default_brand_id: v.data.default_brand_id || null,
      default_channel_id: v.data.default_channel_id || null,
      default_revenue_account_id: v.data.default_revenue_account_id || null,
      default_returns_account_id: v.data.default_returns_account_id || null,
      default_cogs_account_id: v.data.default_cogs_account_id || null,
      default_ar_account_id: v.data.default_ar_account_id || null,
      contact_name: v.data.contact_name || null,
      contact_title: v.data.contact_title || null,
      email: v.data.email || null,
      phone: v.data.phone || null,
      website: v.data.website || null,
      wechat_id: v.data.wechat_id || null,
      contacts: v.data.contacts || [],
    });

    const { data, error } = await insertWithAutoCode(
      admin, "customers", "code", CODE_PREFIX, buildRow,
      { entityId, select: LIST_COLUMNS },
    );

    if (error) {
      if (error.code === "23505") {
        return res.status(409).json({ error: "Could not allocate a unique customer code; please retry" });
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
  // Conservative Title-Case on NEW names (acronym/suffix-safe). Existing names
  // are never bulk-updated through this path.
  out.name = titleCaseCustomerName(out.name);
  if (out.code != null) {
    out.code = String(out.code).trim() || null;
  }
  if ("contacts" in out) {
    const c = sanitizeContacts(out.contacts, 12);
    if (c && c.error) return { error: c.error };
    out.contacts = c;
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
  // Chunk K — customer factoring (operator item 17).
  if (out.is_factored != null && typeof out.is_factored !== "boolean") {
    out.is_factored = out.is_factored === "true" || out.is_factored === 1;
  }
  if (out.factor_id === "" || out.factor_id == null) {
    out.factor_id = null;
  } else if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(out.factor_id))) {
    return { error: "factor_id must be a valid UUID" };
  }
  // P3-9: payment_terms_id structured FK. Validate UUID when provided.
  if (out.payment_terms_id != null && out.payment_terms_id !== "") {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(out.payment_terms_id))) {
      return { error: "payment_terms_id must be a valid UUID" };
    }
  } else {
    out.payment_terms_id = null;
  }
  // P4-family UUID FK fields — coerce empty string to null + validate UUID.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const k of [
    "sales_rep_1_id", "sales_rep_2_id", "default_brand_id", "default_channel_id",
    "default_revenue_account_id", "default_returns_account_id",
    "default_cogs_account_id", "default_ar_account_id",
  ]) {
    if (out[k] === "" || out[k] == null) {
      out[k] = null;
    } else if (!UUID_RE.test(String(out[k]))) {
      return { error: `${k} must be a valid UUID` };
    }
  }
  // P4-family commission percentages — numeric, 0..100.
  for (const k of ["sales_rep_1_commission_pct", "sales_rep_2_commission_pct", "closeout_commission_pct"]) {
    if (out[k] === "" || out[k] == null) {
      out[k] = null;
    } else {
      const n = typeof out[k] === "number" ? out[k] : parseFloat(out[k]);
      if (!Number.isFinite(n)) return { error: `${k} must be a number` };
      if (n < 0 || n > 100) return { error: `${k} must be between 0 and 100` };
      out[k] = n;
    }
  }
  // Free-text contact fields — coerce empty string to null.
  for (const k of ["contact_name", "contact_title", "email", "phone", "website", "wechat_id"]) {
    if (out[k] === "") out[k] = null;
  }
  return { data: out };
}
