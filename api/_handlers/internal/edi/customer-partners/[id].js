// api/internal/edi/customer-partners/[id]
//
// GET    — fetch a single edi_customer_partners row (with customer NAME).
// PATCH  — update mutable fields. entity_id / customer_id / id are LOCKED.
//          Mutable: partner_isa_qualifier, partner_isa_id, supported_docs,
//          is_active.
// DELETE — hard-delete the trading-partner config (no transport state to orphan).
//
// Tangerine — EDI Customers. req.query.id per dispatcher convention.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MUTABLE_FIELDS = new Set(["partner_isa_qualifier", "partner_isa_id", "supported_docs", "is_active"]);
const LOCKED_FIELDS  = new Set(["id", "entity_id", "customer_id"]);

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

async function customerName(admin, customerId) {
  if (!customerId) return { name: "", code: "" };
  const { data } = await admin
    .from("customers")
    .select("name, customer_code, code")
    .eq("id", customerId)
    .maybeSingle();
  return { name: data?.name || "", code: data?.customer_code || data?.code || "" };
}

function normalizeDocs(raw) {
  if (raw == null) return [];
  const arr = Array.isArray(raw) ? raw : String(raw).split(",");
  return [...new Set(arr.map((d) => String(d).trim()).filter(Boolean))];
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
      .from("edi_customer_partners")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "EDI customer partner not found" });
    const c = await customerName(admin, data.customer_id);
    return res.status(200).json({ ...data, customer_name: c.name, customer_code: c.code });
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
      .from("edi_customer_partners")
      .update(v.data)
      .eq("id", id)
      .select()
      .single();
    if (error) {
      if (error.code === "PGRST116") return res.status(404).json({ error: "EDI customer partner not found" });
      return res.status(500).json({ error: error.message });
    }
    const c = await customerName(admin, data.customer_id);
    return res.status(200).json({ ...data, customer_name: c.name, customer_code: c.code });
  }

  if (req.method === "DELETE") {
    const { data, error } = await admin
      .from("edi_customer_partners")
      .delete()
      .eq("id", id)
      .select("id")
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "EDI customer partner not found" });
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
  if ("partner_isa_qualifier" in out) {
    out.partner_isa_qualifier = out.partner_isa_qualifier ? String(out.partner_isa_qualifier).trim() : null;
  }
  if ("partner_isa_id" in out) {
    out.partner_isa_id = out.partner_isa_id ? String(out.partner_isa_id).trim() : null;
  }
  if ("supported_docs" in out) {
    out.supported_docs = normalizeDocs(out.supported_docs);
  }
  if ("is_active" in out) {
    if (typeof out.is_active !== "boolean") {
      out.is_active = out.is_active === "true" || out.is_active === 1;
    }
  }
  return { data: out };
}
