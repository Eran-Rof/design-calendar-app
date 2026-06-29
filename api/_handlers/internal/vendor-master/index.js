// api/internal/vendor-master
//
// GET  — list vendors (active by default). Returns ERP-grade vendor data, but
//        intentionally omits tax_id and bank_account_encrypted (PII per
//        CLAUDE.md security rules — never return in API responses).
//        Query: ?q=<search> matches name/code; ?include_inactive=true; ?limit=N
// POST — create a vendor. Body: { name, code?, legal_name?, country?,
//        payment_terms?, default_currency?, is_1099_vendor?, status?, address?,
//        contact?, contact_title?, email?, phone?, website?, wechat_id?,
//        default_gl_ap_account_id?, default_gl_expense_account_id? }
//        tax_id/bank_account_encrypted MUST be set via a separate PII-aware
//        endpoint (TBD) — they are rejected here.
//
// Tangerine P1 Chunk 7b. Mirrors style-master handler shape.

import { createClient } from "@supabase/supabase-js";
import { insertWithAutoCode } from "../../../_lib/autoCode.js";

export const config = { maxDuration: 15 };

// Chunk M — vendor codes are server-generated + read-only (operator item 14).
// vendors.code is a GLOBAL identifier (per-entity overrides live in
// entity_vendors.vendor_code), so the sequence is counted across all vendors,
// not scoped to an entity.
const CODE_PREFIX = "VEND-";
const STATUS_VALUES = ["active", "on_hold", "inactive"];

// Default GL accounts applied to NEW vendors when the caller doesn't supply one.
// (Backfilled on existing vendors via prod SQL 2026-06-10.)
//   A/P 2000 ("Accounts Payable (A/P)") — every vendor.
//   Inventory Adjustments Expense 6343 — apparel vendors only (the default;
//   non-apparel vendors are the documented exception set, see
//   20260856000000_seed_non_apparel_vendors.sql).
const DEFAULT_AP_ACCOUNT_ID = "a76c35e7-8335-464a-b31b-95a30cb39220";
const DEFAULT_APPAREL_EXPENSE_ACCOUNT_ID = "1adcc4a0-3eae-4d89-b9dc-7605e254ffa8";

// Non-apparel vendors (lower-cased names) — the authoritative exception set from
// the non-apparel seed migration. categories do NOT discriminate apparel here, so
// the apparel default expense account is suppressed by explicit name match.
const NON_APPAREL_NAMES = new Set([
  "gpa logistics group inc.",
  "ebay",
  "blue shield ca",
  "damian valencia",
  "health first new york",
  "meta platforms, inc. - ads",
]);

// Conservative Title-Case for NEW vendor names: only re-cases tokens that are
// all-lowercase, leaving acronyms (ROF, BMO, EDI, HK), mixed-case (McGraw), and
// known legal suffixes (LLC, Inc., Ltd.) untouched. Existing names are NOT
// touched — bulk initcap would mangle acronyms/suffixes.
const PRESERVE_TOKENS = new Set([
  "LLC", "L.L.C.", "INC", "INC.", "LTD", "LTD.", "CO", "CO.", "CORP", "CORP.",
  "HK", "EDI", "USA", "US", "UK", "EU", "ROF", "BMO", "DBA", "PLC", "GMBH",
]);
function titleCaseVendorName(raw) {
  const s = String(raw).trim().replace(/\s+/g, " ");
  if (!s) return s;
  return s
    .split(" ")
    .map((tok) => {
      const upper = tok.toUpperCase();
      // Preserve known acronyms / legal suffixes verbatim (upper-cased).
      if (PRESERVE_TOKENS.has(upper)) return upper;
      // Leave anything already containing an uppercase letter alone (acronyms,
      // brand casing like "eBay", "McGraw") — only fix fully-lowercase tokens.
      if (/[A-Z]/.test(tok)) return tok;
      // Fully lowercase word → capitalize first letter.
      return tok.charAt(0).toUpperCase() + tok.slice(1);
    })
    .join(" ");
}

// Columns safe to return — explicitly omits tax_id, bank_account_encrypted.
// payment_terms_id (P3-9) is the new structured FK; the legacy free-text
// payment_terms column is retained read-only for backward-compat display.
const SAFE_SELECT =
  "id, code, name, legal_name, country, transit_days, categories, contact, contact_title, email, phone, phone_country_code, website, wechat_id, moq, " +
  "payment_terms, payment_terms_id, default_currency, default_gl_ap_account_id, default_gl_expense_account_id, " +
  "status, is_1099_vendor, address, deleted_at, created_at, updated_at";

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

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const includeInactive = url.searchParams.get("include_inactive") === "true";
    const q = (url.searchParams.get("q") || "").trim();
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "1000", 10) || 1000, 5000);

    let query = admin
      .from("vendors")
      .select(SAFE_SELECT)
      .is("deleted_at", null)
      .order("name", { ascending: true })
      .limit(limit);

    if (!includeInactive) query = query.eq("status", "active");
    if (q) query = query.or(`name.ilike.%${q}%,code.ilike.%${q}%,legal_name.ilike.%${q}%`);

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
    const { data, error } = await insertWithAutoCode(
      admin, "vendors", "code", CODE_PREFIX,
      (code) => ({ ...v.data, code }),
      { select: SAFE_SELECT },
    );
    if (error) {
      if (error.code === "23505") return res.status(409).json({ error: "Could not allocate a unique vendor code; please retry" });
      return res.status(500).json({ error: error.message });
    }
    return res.status(201).json(data);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

export function validateInsert(body) {
  if (!body.name || !String(body.name).trim()) {
    return { error: "name is required" };
  }
  // Reject PII fields on create — they must go through a dedicated PII endpoint.
  if (body.tax_id != null) {
    return { error: "tax_id cannot be set via this endpoint (PII). Use the dedicated tax-id endpoint." };
  }
  if (body.bank_account_encrypted != null) {
    return { error: "bank_account_encrypted cannot be set via this endpoint. Use the dedicated banking endpoint." };
  }
  if (body.status && !STATUS_VALUES.includes(body.status)) {
    return { error: `status must be one of ${STATUS_VALUES.join(", ")}` };
  }
  if (body.default_currency && !/^[A-Z]{3}$/.test(body.default_currency)) {
    return { error: "default_currency must be a 3-letter ISO code" };
  }
  if (body.transit_days != null) {
    const n = parseInt(body.transit_days, 10);
    if (!Number.isFinite(n) || n < 0) return { error: "transit_days must be a non-negative integer" };
    body.transit_days = n;
  }
  if (body.moq != null) {
    const n = parseInt(body.moq, 10);
    if (!Number.isFinite(n) || n < 0) return { error: "moq must be a non-negative integer" };
    body.moq = n;
  }
  // P3-9: payment_terms_id is the new structured FK. Validate it's a UUID
  // when provided; empty string normalizes to null.
  if (body.payment_terms_id != null && body.payment_terms_id !== "") {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(body.payment_terms_id))) {
      return { error: "payment_terms_id must be a valid UUID" };
    }
  }
  // GL account FK fields — empty string normalizes to null.
  if (body.default_gl_ap_account_id != null && body.default_gl_ap_account_id !== "") {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(body.default_gl_ap_account_id))) {
      return { error: "default_gl_ap_account_id must be a valid UUID" };
    }
  }
  if (body.default_gl_expense_account_id != null && body.default_gl_expense_account_id !== "") {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(body.default_gl_expense_account_id))) {
      return { error: "default_gl_expense_account_id must be a valid UUID" };
    }
  }
  // Conservative Title-Case on NEW names (acronym/suffix-safe). Existing names
  // are never bulk-updated.
  const name = titleCaseVendorName(body.name);
  const isNonApparel = NON_APPAREL_NAMES.has(name.toLowerCase());
  return {
    data: {
      name,
      code:                        body.code ? String(body.code).trim().toUpperCase() : null,
      legal_name:                  body.legal_name ? String(body.legal_name).trim() : null,
      country:                     body.country ? String(body.country).trim() : null,
      transit_days:                body.transit_days ?? null,
      categories:                  Array.isArray(body.categories) ? body.categories : [],
      contact:                     body.contact ?? null,
      contact_title:               body.contact_title ?? null,
      email:                       body.email ?? null,
      phone:                       body.phone ?? null,
      phone_country_code:          body.phone_country_code != null && body.phone_country_code !== ""
                                     ? parseInt(String(body.phone_country_code).replace(/\D/g, ""), 10) || null
                                     : null,
      website:                     body.website ?? null,
      wechat_id:                   body.wechat_id ?? null,
      moq:                         body.moq ?? null,
      payment_terms:               body.payment_terms ?? null,
      payment_terms_id:            body.payment_terms_id || null,
      default_currency:            body.default_currency || "USD",
      // Default A/P 2000 for every vendor when not supplied.
      default_gl_ap_account_id:    body.default_gl_ap_account_id || DEFAULT_AP_ACCOUNT_ID,
      // Default expense 6343 for apparel vendors (the default) when not supplied;
      // non-apparel vendors get no expense default.
      default_gl_expense_account_id: body.default_gl_expense_account_id
                                       || (isNonApparel ? null : DEFAULT_APPAREL_EXPENSE_ACCOUNT_ID),
      status:                      body.status || "active",
      is_1099_vendor:              body.is_1099_vendor === true,
      address:                     body.address && typeof body.address === "object" ? body.address : {},
    },
  };
}
