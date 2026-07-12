// api/internal/customer-master/[id]
//
// GET    — fetch a single customers row (full row, including
//          tax_exempt_certificate — admin-authenticated context).
// PATCH  — update mutable fields.
//          Mutable fields: name, code, customer_type, country, payment_terms,
//          default_currency, tax_exempt, tax_exempt_certificate, credit_limit,
//          status, billing_address, shipping_address,
//          parent_customer_id, contact_name, contact_title, email, phone,
//          website, wechat_id, xoro_customer_id.
// DELETE — soft-delete: set deleted_at = now(); 404 if already deleted.
//
// Tangerine P1 Chunk 7c (M36 Customer Master admin).

import { createClient } from "@supabase/supabase-js";
import { sanitizeContacts } from "./index.js";

export const config = { maxDuration: 15 };

const CUSTOMER_TYPES = ["wholesale", "ecom", "showroom", "employee", "other"];
const STATUS_VALUES  = ["active", "inactive", "on_hold"];

const MUTABLE_FIELDS = new Set([
  "name", "code", "customer_type", "country", "payment_terms", "payment_terms_id",
  "default_currency", "tax_exempt", "credit_limit",
  "credit_limit_cents", "credit_limit_currency",
  // Chunk K — customer factoring (operator item 17).
  "is_factored", "factor_id",
  "status",
  "billing_address", "shipping_address",
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
  "parent_customer_id",
  "price_list_id",
  "contact_name", "contact_title", "email", "phone", "website", "wechat_id",
  "contacts",
  // Xoro identity back-fill (rest_customer_locations_sync.py name-match).
  "xoro_customer_id",
]);

// Nullable fields whose empty-string input should be normalized to null.
const NULLABLE_TEXT_FIELDS = [
  "code", "country", "payment_terms", "payment_terms_id",
  // P4-family UUID FK fields normalize "" → null too.
  "sales_rep_1_id", "sales_rep_2_id", "default_brand_id", "default_channel_id",
  "default_revenue_account_id", "default_returns_account_id",
  "default_cogs_account_id", "default_ar_account_id",
  "parent_customer_id", "price_list_id",
  // Chunk K — factor_id FK normalizes "" → null too.
  "factor_id",
  "contact_name", "contact_title", "email", "phone", "website", "wechat_id",
];

// P4-family UUID FK fields whose non-null value must be a valid UUID.
const P4_UUID_FIELDS = [
  "sales_rep_1_id", "sales_rep_2_id", "default_brand_id", "default_channel_id",
  "default_revenue_account_id", "default_returns_account_id",
  "default_cogs_account_id", "default_ar_account_id", "price_list_id",
];

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
    // Full row, including tax_exempt_certificate. id-specific lookup
    // is treated as authenticated admin context per chunk arch.
    const { data, error } = await admin
      .from("customers")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Customer not found" });
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
      .from("customers")
      .update({ ...v.data, updated_at: new Date().toISOString() })
      .eq("id", id)
      .is("deleted_at", null)
      .select()
      .maybeSingle();
    if (error) {
      if (error.code === "23505") {
        return res.status(409).json({ error: `code '${v.data.code}' already exists for this entity` });
      }
      return res.status(500).json({ error: error.message });
    }
    if (!data) return res.status(404).json({ error: "Customer not found or deleted" });
    return res.status(200).json(data);
  }

  if (req.method === "DELETE") {
    const { data, error } = await admin
      .from("customers")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id)
      .is("deleted_at", null)
      .select()
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Customer not found or already deleted" });
    return res.status(200).json({ deleted: true, id });
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

export function validatePatch(body) {
  if (body == null || typeof body !== "object") {
    return { error: "Request body must be an object" };
  }
  // tax_exempt_certificate is PII-workflow-only — never accepted via this endpoint.
  if (body.tax_exempt_certificate != null && String(body.tax_exempt_certificate).trim() !== "") {
    return { error: "tax_exempt_certificate must be set via the dedicated PII workflow, not this endpoint" };
  }

  const out = {};
  for (const [k, val] of Object.entries(body)) {
    if (!MUTABLE_FIELDS.has(k)) continue;
    out[k] = val;
  }

  // name cannot be blanked
  if ("name" in out) {
    if (out.name == null || String(out.name).trim() === "") {
      return { error: "name cannot be empty" };
    }
    out.name = String(out.name).trim();
  }

  if ("contacts" in out) {
    const c = sanitizeContacts(out.contacts, 12);
    if (c && c.error) return { error: c.error };
    out.contacts = c ?? [];
  }

  if (out.customer_type != null && out.customer_type !== "") {
    if (!CUSTOMER_TYPES.includes(out.customer_type)) {
      return { error: `customer_type must be one of ${CUSTOMER_TYPES.join(", ")}` };
    }
  } else if (out.customer_type === "") {
    // customer_type is NOT NULL — reject blanking attempts.
    return { error: "customer_type cannot be empty" };
  }

  if (out.status != null && out.status !== "") {
    if (!STATUS_VALUES.includes(out.status)) {
      return { error: `status must be one of ${STATUS_VALUES.join(", ")}` };
    }
  } else if (out.status === "") {
    return { error: "status cannot be empty" };
  }

  if (out.default_currency != null && out.default_currency !== "") {
    const ccy = String(out.default_currency).toUpperCase();
    if (!/^[A-Z]{3}$/.test(ccy)) {
      return { error: "default_currency must be a 3-letter ISO code (e.g. USD)" };
    }
    out.default_currency = ccy;
  } else if (out.default_currency === "") {
    return { error: "default_currency cannot be empty" };
  }

  if ("credit_limit" in out) {
    if (out.credit_limit == null || out.credit_limit === "") {
      out.credit_limit = null;
    } else {
      const n = typeof out.credit_limit === "number" ? out.credit_limit : parseFloat(out.credit_limit);
      if (!Number.isFinite(n)) {
        return { error: "credit_limit must be a number" };
      }
      if (n < 0) {
        return { error: "credit_limit must be >= 0" };
      }
      out.credit_limit = n;
    }
  }

  // P4-7: canonical credit-gate fields.
  if ("credit_limit_cents" in out) {
    if (out.credit_limit_cents == null || out.credit_limit_cents === "") {
      out.credit_limit_cents = null;
    } else {
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
    }
  }
  if ("credit_limit_currency" in out) {
    if (out.credit_limit_currency == null || out.credit_limit_currency === "") {
      out.credit_limit_currency = null;
    } else {
      const ccy = String(out.credit_limit_currency).toUpperCase();
      if (!/^[A-Z]{3}$/.test(ccy)) {
        return { error: "credit_limit_currency must be a 3-letter ISO code (e.g. USD)" };
      }
      out.credit_limit_currency = ccy;
    }
  }

  if ("tax_exempt" in out && typeof out.tax_exempt !== "boolean") {
    out.tax_exempt = out.tax_exempt === "true" || out.tax_exempt === 1;
  }

  // Xoro customer id — positive integer, or null to clear.
  if ("xoro_customer_id" in out) {
    if (out.xoro_customer_id == null || out.xoro_customer_id === "") {
      out.xoro_customer_id = null;
    } else {
      const n = typeof out.xoro_customer_id === "number"
        ? out.xoro_customer_id
        : parseInt(out.xoro_customer_id, 10);
      if (!Number.isInteger(n) || n <= 0) {
        return { error: "xoro_customer_id must be a positive integer" };
      }
      out.xoro_customer_id = n;
    }
  }

  // Chunk K — customer factoring (operator item 17).
  if ("is_factored" in out && typeof out.is_factored !== "boolean") {
    out.is_factored = out.is_factored === "true" || out.is_factored === 1;
  }

  // Normalize empty strings to null for nullable text/uuid fields.
  for (const k of NULLABLE_TEXT_FIELDS) {
    if (out[k] === "") out[k] = null;
  }

  // P3-9: validate payment_terms_id is a valid UUID when not null.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (out.payment_terms_id != null && !UUID_RE.test(String(out.payment_terms_id))) {
    return { error: "payment_terms_id must be a valid UUID" };
  }

  // Chunk K — factor_id must be a valid UUID when not null.
  if (out.factor_id != null && !UUID_RE.test(String(out.factor_id))) {
    return { error: "factor_id must be a valid UUID" };
  }

  // P4-family: validate UUID FK fields when not null.
  for (const k of P4_UUID_FIELDS) {
    if (out[k] != null && !UUID_RE.test(String(out[k]))) {
      return { error: `${k} must be a valid UUID` };
    }
  }

  // P4-family: commission percentages — numeric, 0..100; "" → null.
  for (const k of ["sales_rep_1_commission_pct", "sales_rep_2_commission_pct", "closeout_commission_pct"]) {
    if (k in out) {
      if (out[k] == null || out[k] === "") {
        out[k] = null;
      } else {
        const n = typeof out[k] === "number" ? out[k] : parseFloat(out[k]);
        if (!Number.isFinite(n)) return { error: `${k} must be a number` };
        if (n < 0 || n > 100) return { error: `${k} must be between 0 and 100` };
        out[k] = n;
      }
    }
  }

  return { data: out };
}
