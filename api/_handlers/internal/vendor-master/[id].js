// api/internal/vendor-master/[id]
//
// GET    — fetch a single vendor (omits tax_id + bank_account_encrypted).
// PATCH  — update mutable fields. PII fields (tax_id, bank_account_encrypted)
//          are rejected — use dedicated PII endpoints.
// DELETE — soft-delete by setting deleted_at and status='inactive'.
//
// Tangerine P1 Chunk 7b.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const STATUS_VALUES = ["active", "on_hold", "inactive"];

const MUTABLE_FIELDS = new Set([
  "name", "code", "legal_name", "country", "transit_days", "categories",
  "contact", "contact_title", "email", "phone", "phone_country_code", "website", "wechat_id",
  "moq", "payment_terms", "payment_terms_id", "default_currency",
  "default_gl_ap_account_id", "default_gl_expense_account_id",
  "status", "is_1099_vendor", "address",
]);

// Explicitly excluded — must go via dedicated PII endpoints.
const PII_FIELDS = new Set(["tax_id", "bank_account_encrypted"]);

const SAFE_SELECT =
  "id, code, name, legal_name, country, transit_days, categories, contact, contact_title, email, phone, phone_country_code, website, wechat_id, moq, " +
  "payment_terms, payment_terms_id, default_currency, default_gl_ap_account_id, default_gl_expense_account_id, " +
  "status, is_1099_vendor, address, deleted_at, created_at, updated_at";

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

export default async function handler(req, res, params) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const id = params?.id || req.query?.id;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const { data, error } = await admin
      .from("vendors")
      .select(SAFE_SELECT)
      .eq("id", id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Vendor not found" });
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
      .from("vendors")
      .update({ ...v.data, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select(SAFE_SELECT)
      .single();
    if (error) {
      if (error.code === "PGRST116") return res.status(404).json({ error: "Vendor not found" });
      return res.status(500).json({ error: error.message });
    }
    return res.status(200).json(data);
  }

  if (req.method === "DELETE") {
    const now = new Date().toISOString();
    const { data, error } = await admin
      .from("vendors")
      .update({ deleted_at: now, status: "inactive" })
      .eq("id", id)
      .is("deleted_at", null)
      .select("id")
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Vendor not found or already deleted" });
    return res.status(200).json({ deleted: true, id });
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

export function validatePatch(body) {
  for (const f of Object.keys(body)) {
    if (PII_FIELDS.has(f)) {
      return { error: `${f} cannot be updated via this endpoint (PII). Use the dedicated endpoint.` };
    }
  }
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (!MUTABLE_FIELDS.has(k)) continue;
    out[k] = v;
  }
  if (out.status != null && !STATUS_VALUES.includes(out.status)) {
    return { error: `status must be one of ${STATUS_VALUES.join(", ")}` };
  }
  if (out.default_currency != null && !/^[A-Z]{3}$/.test(out.default_currency)) {
    return { error: "default_currency must be a 3-letter ISO code" };
  }
  if (out.transit_days != null && out.transit_days !== "") {
    const n = parseInt(out.transit_days, 10);
    if (!Number.isFinite(n) || n < 0) return { error: "transit_days must be a non-negative integer" };
    out.transit_days = n;
  }
  if (out.moq != null && out.moq !== "") {
    const n = parseInt(out.moq, 10);
    if (!Number.isFinite(n) || n < 0) return { error: "moq must be a non-negative integer" };
    out.moq = n;
  }
  if ("phone_country_code" in out) {
    if (out.phone_country_code === "" || out.phone_country_code == null) {
      out.phone_country_code = null;
    } else {
      const n = parseInt(String(out.phone_country_code).replace(/\D/g, ""), 10);
      out.phone_country_code = Number.isFinite(n) && n > 0 ? n : null;
    }
  }
  if (out.code != null) out.code = out.code === "" ? null : String(out.code).trim().toUpperCase();
  for (const k of ["legal_name", "country", "contact", "contact_title", "email", "phone", "website", "wechat_id", "payment_terms"]) {
    if (out[k] === "") out[k] = null;
  }
  // P3-9: payment_terms_id — empty → null, otherwise must be a valid UUID.
  if ("payment_terms_id" in out) {
    if (out.payment_terms_id === "" || out.payment_terms_id == null) {
      out.payment_terms_id = null;
    } else if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(out.payment_terms_id))) {
      return { error: "payment_terms_id must be a valid UUID" };
    }
  }
  // GL account FK fields — empty string normalizes to null.
  for (const k of ["default_gl_ap_account_id", "default_gl_expense_account_id"]) {
    if (k in out) {
      if (out[k] === "" || out[k] == null) {
        out[k] = null;
      } else if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(out[k]))) {
        return { error: `${k} must be a valid UUID` };
      }
    }
  }
  return { data: out };
}
