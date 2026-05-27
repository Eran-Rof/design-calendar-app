// api/internal/customer-master/[id]
//
// GET    — fetch a single customers row (full row, including
//          tax_exempt_certificate — admin-authenticated context).
// PATCH  — update mutable fields. Rejects tax_exempt_certificate (PII).
//          Mutable fields: name, code, customer_type, country, payment_terms,
//          default_currency, tax_exempt, credit_limit, status,
//          billing_address, shipping_address, default_gl_ar_account_id,
//          default_gl_revenue_account_id, parent_customer_id.
// DELETE — soft-delete: set deleted_at = now(); 404 if already deleted.
//
// Tangerine P1 Chunk 7c (M36 Customer Master admin).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const CUSTOMER_TYPES = ["wholesale", "ecom", "showroom", "employee", "other"];
const STATUS_VALUES  = ["active", "inactive", "on_hold"];

const MUTABLE_FIELDS = new Set([
  "name", "code", "customer_type", "country", "payment_terms",
  "default_currency", "tax_exempt", "credit_limit", "status",
  "billing_address", "shipping_address",
  "default_gl_ar_account_id", "default_gl_revenue_account_id",
  "parent_customer_id",
]);

// Nullable fields whose empty-string input should be normalized to null.
const NULLABLE_TEXT_FIELDS = [
  "code", "country", "payment_terms",
  "default_gl_ar_account_id", "default_gl_revenue_account_id",
  "parent_customer_id",
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
  // PII rejection.
  if ("tax_exempt_certificate" in body) {
    return { error: "tax_exempt_certificate must be set via the dedicated PII endpoint (not this admin route)" };
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

  if ("tax_exempt" in out && typeof out.tax_exempt !== "boolean") {
    out.tax_exempt = out.tax_exempt === "true" || out.tax_exempt === 1;
  }

  // Normalize empty strings to null for nullable text/uuid fields.
  for (const k of NULLABLE_TEXT_FIELDS) {
    if (out[k] === "") out[k] = null;
  }

  return { data: out };
}
