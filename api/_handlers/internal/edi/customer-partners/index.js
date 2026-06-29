// api/internal/edi/customer-partners
//
// Customer-side EDI trading partners (MVP config).
//
// GET  — list trading partners for the default entity, joined to the customer
//        NAME (the uuid is never surfaced to the UI). By default returns
//        is_active=true rows only; ?include_inactive=true returns all.
//          ?q=<search>            — ilike match on customer name / partner ISA ID
//          ?include_inactive=true — include inactive rows
// POST — create one edi_customer_partners row. Body:
//          { customer_id (required, uuid),
//            partner_isa_qualifier, partner_isa_id,
//            supported_docs (string[], e.g. ['850','810','856']),
//            is_active (default true) }
//        UNIQUE(entity_id, customer_id) — a customer can only be a partner once.
//
// Tangerine — EDI Customers. Service-role writes; anon-read in DB (RLS).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

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

// Resolve customer NAMEs for a set of customer ids → map id→{name,code}.
async function resolveCustomerNames(admin, ids) {
  const map = new Map();
  const uniq = [...new Set(ids.filter(Boolean))];
  if (uniq.length === 0) return map;
  const { data } = await admin
    .from("customers")
    .select("id, name, customer_code, code")
    .in("id", uniq);
  for (const c of data || []) {
    map.set(c.id, { name: c.name || "", code: c.customer_code || c.code || "" });
  }
  return map;
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
    const q = (url.searchParams.get("q") || "").trim();

    let query = admin
      .from("edi_customer_partners")
      .select("*")
      .eq("entity_id", entityId)
      .order("created_at", { ascending: false });
    if (!includeInactive) query = query.eq("is_active", true);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    const rows = data || [];
    const nameMap = await resolveCustomerNames(admin, rows.map((r) => r.customer_id));
    let out = rows.map((r) => {
      const c = nameMap.get(r.customer_id) || { name: "", code: "" };
      return { ...r, customer_name: c.name, customer_code: c.code };
    });

    if (q) {
      const needle = q.toLowerCase();
      out = out.filter((r) =>
        (r.customer_name || "").toLowerCase().includes(needle) ||
        (r.partner_isa_id || "").toLowerCase().includes(needle));
    }
    return res.status(200).json(out);
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
      .from("edi_customer_partners")
      .insert({ ...v.data, entity_id: entityId })
      .select()
      .single();
    if (error) {
      if (error.code === "23505") {
        return res.status(409).json({ error: "This customer is already configured as an EDI trading partner." });
      }
      if (error.code === "23503") {
        return res.status(400).json({ error: "Unknown customer_id." });
      }
      return res.status(500).json({ error: error.message });
    }

    // Echo the customer name back so the UI can render it without a re-fetch.
    const nameMap = await resolveCustomerNames(admin, [data.customer_id]);
    const c = nameMap.get(data.customer_id) || { name: "", code: "" };
    return res.status(201).json({ ...data, customer_name: c.name, customer_code: c.code });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeDocs(raw) {
  if (raw == null) return [];
  const arr = Array.isArray(raw) ? raw : String(raw).split(",");
  return [...new Set(arr.map((d) => String(d).trim()).filter(Boolean))];
}

export function validateInsert(body) {
  if (body == null || typeof body !== "object") {
    return { error: "Request body must be an object" };
  }
  if (!body.customer_id || !UUID_RE.test(String(body.customer_id))) {
    return { error: "customer_id is required (uuid)" };
  }
  const isActive = body.is_active == null ? true :
    typeof body.is_active === "boolean" ? body.is_active :
      body.is_active === "true" || body.is_active === 1;

  return {
    data: {
      customer_id:           String(body.customer_id),
      partner_isa_qualifier: body.partner_isa_qualifier ? String(body.partner_isa_qualifier).trim() : null,
      partner_isa_id:        body.partner_isa_id ? String(body.partner_isa_id).trim() : null,
      supported_docs:        normalizeDocs(body.supported_docs),
      is_active:             isActive,
    },
  };
}
