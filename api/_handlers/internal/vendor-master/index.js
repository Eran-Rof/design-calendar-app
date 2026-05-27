// api/internal/vendor-master
//
// GET  — list vendors (active by default). Returns ERP-grade vendor data, but
//        intentionally omits tax_id and bank_account_encrypted (PII per
//        CLAUDE.md security rules — never return in API responses).
//        Query: ?q=<search> matches name/code; ?include_inactive=true; ?limit=N
// POST — create a vendor. Body: { name, code?, legal_name?, country?,
//        payment_terms?, default_currency?, is_1099_vendor?, status?, address? }
//        tax_id/bank_account_encrypted MUST be set via a separate PII-aware
//        endpoint (TBD) — they are rejected here.
//
// Tangerine P1 Chunk 7b. Mirrors style-master handler shape.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const STATUS_VALUES = ["active", "on_hold", "inactive"];

// Columns safe to return — explicitly omits tax_id, bank_account_encrypted.
// payment_terms_id (P3-9) is the new structured FK; the legacy free-text
// payment_terms column is retained read-only for backward-compat display.
const SAFE_SELECT =
  "id, code, name, legal_name, country, transit_days, categories, contact, email, moq, " +
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
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "200", 10) || 200, 500);

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

    const { data, error } = await admin
      .from("vendors")
      .insert(v.data)
      .select(SAFE_SELECT)
      .single();
    if (error) {
      if (error.code === "23505") return res.status(409).json({ error: "A vendor with that name or code already exists" });
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
  return {
    data: {
      name:             String(body.name).trim(),
      code:             body.code ? String(body.code).trim().toUpperCase() : null,
      legal_name:       body.legal_name ? String(body.legal_name).trim() : null,
      country:          body.country ? String(body.country).trim() : null,
      transit_days:     body.transit_days ?? null,
      categories:       Array.isArray(body.categories) ? body.categories : [],
      contact:          body.contact ?? null,
      email:            body.email ?? null,
      moq:              body.moq ?? null,
      payment_terms:    body.payment_terms ?? null,
      payment_terms_id: body.payment_terms_id || null,
      default_currency: body.default_currency || "USD",
      status:           body.status || "active",
      is_1099_vendor:   body.is_1099_vendor === true,
      address:          body.address && typeof body.address === "object" ? body.address : {},
    },
  };
}
