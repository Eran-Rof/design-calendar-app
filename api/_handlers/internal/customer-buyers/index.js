// api/internal/customer-buyers
//
// Per-row buyer CRUD for a customer (replaces the legacy customers.contacts
// jsonb tab). Per-row (NOT batch-replace) to avoid the self-FK ordering
// problem: a manager buyer must exist before a report can point at it.
//
// GET  ?customer_id=<uuid>  → buyers for that customer, each decorated with
//        reports_to_name and scopes:[{id,name}] (no raw UUIDs surface).
// POST { customer_id, name, phone, email, title, is_manager?,
//        reports_to_buyer_id?, scope_ids?:[uuid], sort_order?, is_active? }
//        → creates one buyer + replaces its scope join rows. name/phone/email/
//          title are REQUIRED here (nullable in DB only for legacy migration).
//
// Tangerine — Customer Buyers (#1156). Writes via service role; anon-read RLS.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHONE_RE = /^\(\d{3}\) \d{3}-\d{4}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

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

// Decorate buyers with reports_to_name + scopes:[{id,name}] (no raw UUIDs).
export async function decorateBuyers(admin, buyers) {
  const list = buyers || [];
  if (list.length === 0) return [];
  const ids = list.map((b) => b.id);

  // Scope join rows + names.
  const { data: joins } = await admin
    .from("customer_buyer_scopes")
    .select("buyer_id, scope_id")
    .in("buyer_id", ids);
  const scopeIds = [...new Set((joins || []).map((j) => j.scope_id))];
  let scopeName = new Map();
  if (scopeIds.length) {
    const { data: scopes } = await admin
      .from("buyer_scope_master")
      .select("id, name")
      .in("id", scopeIds);
    scopeName = new Map((scopes || []).map((s) => [s.id, s.name]));
  }
  const scopesByBuyer = new Map();
  for (const j of joins || []) {
    if (!scopesByBuyer.has(j.buyer_id)) scopesByBuyer.set(j.buyer_id, []);
    scopesByBuyer.get(j.buyer_id).push({ id: j.scope_id, name: scopeName.get(j.scope_id) || null });
  }

  // reports_to name (a buyer on the same customer).
  const byId = new Map(list.map((b) => [b.id, b]));
  return list.map((b) => ({
    ...b,
    reports_to_name: b.reports_to_buyer_id ? (byId.get(b.reports_to_buyer_id)?.name || null) : null,
    scopes: (scopesByBuyer.get(b.id) || []).map((s) => ({ id: s.id, name: s.name })),
    scope_ids: (scopesByBuyer.get(b.id) || []).map((s) => s.id),
  }));
}

// Replace the scope join rows for one buyer.
async function replaceScopes(admin, buyerId, scopeIds) {
  await admin.from("customer_buyer_scopes").delete().eq("buyer_id", buyerId);
  const clean = [...new Set((scopeIds || []).filter((s) => UUID_RE.test(String(s))))];
  if (clean.length) {
    const rows = clean.map((scope_id) => ({ buyer_id: buyerId, scope_id }));
    const { error } = await admin.from("customer_buyer_scopes").insert(rows);
    if (error) return error;
  }
  return null;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const customerId = (url.searchParams.get("customer_id") || "").trim();
    if (!customerId || !UUID_RE.test(customerId)) {
      return res.status(400).json({ error: "customer_id (uuid) query param is required" });
    }
    const { data, error } = await admin
      .from("customer_buyers")
      .select("*")
      .eq("customer_id", customerId)
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(await decorateBuyers(admin, data || []));
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    body = body || {};
    if (!body.customer_id || !UUID_RE.test(String(body.customer_id))) {
      return res.status(400).json({ error: "customer_id (uuid) is required" });
    }
    const v = validateBuyer(body, { requireRequired: true });
    if (v.error) return res.status(400).json({ error: v.error });

    // reports_to must be a manager buyer on the SAME customer (if supplied).
    if (v.data.reports_to_buyer_id) {
      const okRep = await isValidManagerReport(admin, body.customer_id, v.data.reports_to_buyer_id, null);
      if (okRep.error) return res.status(400).json({ error: okRep.error });
    }

    const { data: buyer, error } = await admin
      .from("customer_buyers")
      .insert({
        customer_id: body.customer_id,
        name: v.data.name,
        phone: v.data.phone,
        email: v.data.email,
        title: v.data.title,
        is_manager: v.data.is_manager,
        reports_to_buyer_id: v.data.reports_to_buyer_id,
        sort_order: v.data.sort_order,
        is_active: v.data.is_active,
      })
      .select("*")
      .single();
    if (error) return res.status(500).json({ error: error.message });

    if (Array.isArray(body.scope_ids)) {
      const sErr = await replaceScopes(admin, buyer.id, body.scope_ids);
      if (sErr) return res.status(500).json({ error: `Buyer saved but scopes failed: ${sErr.message}` });
    }
    const [decorated] = await decorateBuyers(admin, [buyer]);
    return res.status(201).json(decorated);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

// Validate a buyer payload. On create, name/phone/email/title are required.
// On PATCH (requireRequired=false), only supplied fields are validated.
export function validateBuyer(body, { requireRequired }) {
  const out = {};

  const want = (k) => k in body;

  if (requireRequired || want("name")) {
    const name = body.name == null ? "" : String(body.name).trim();
    if (!name) return { error: "name is required" };
    out.name = name;
  }
  if (requireRequired || want("phone")) {
    const phone = body.phone == null ? "" : String(body.phone).trim();
    if (!phone) return { error: "phone is required" };
    if (!PHONE_RE.test(phone)) return { error: "phone must be formatted (xxx) xxx-xxxx" };
    out.phone = phone;
  }
  if (requireRequired || want("email")) {
    const email = body.email == null ? "" : String(body.email).trim();
    if (!email) return { error: "email is required" };
    if (!EMAIL_RE.test(email)) return { error: "email is not a valid address" };
    out.email = email;
  }
  if (requireRequired || want("title")) {
    const title = body.title == null ? "" : String(body.title).trim();
    if (!title) return { error: "title is required" };
    out.title = title;
  }

  if (want("is_manager")) {
    out.is_manager = typeof body.is_manager === "boolean"
      ? body.is_manager : (body.is_manager === "true" || body.is_manager === 1);
  } else if (requireRequired) {
    out.is_manager = false;
  }

  if (want("reports_to_buyer_id")) {
    const r = body.reports_to_buyer_id;
    if (r == null || r === "") {
      out.reports_to_buyer_id = null;
    } else if (!UUID_RE.test(String(r))) {
      return { error: "reports_to_buyer_id must be a valid UUID" };
    } else {
      out.reports_to_buyer_id = r;
    }
  } else if (requireRequired) {
    out.reports_to_buyer_id = null;
  }

  if (want("sort_order")) {
    if (body.sort_order == null || body.sort_order === "") {
      out.sort_order = 0;
    } else {
      const n = typeof body.sort_order === "number" ? body.sort_order : parseInt(body.sort_order, 10);
      if (!Number.isInteger(n) || n < 0) return { error: "sort_order must be a non-negative integer" };
      out.sort_order = n;
    }
  } else if (requireRequired) {
    out.sort_order = 0;
  }

  if (want("is_active")) {
    out.is_active = typeof body.is_active === "boolean"
      ? body.is_active : (body.is_active === "true" || body.is_active === 1);
  } else if (requireRequired) {
    out.is_active = true;
  }

  return { data: out };
}

// reports_to_buyer_id must be a buyer on the same customer, with is_manager=true,
// and not the buyer itself (selfId, when editing). Returns {error} or {}.
export async function isValidManagerReport(admin, customerId, reportsToId, selfId) {
  if (selfId && reportsToId === selfId) {
    return { error: "A buyer cannot report to themselves" };
  }
  const { data } = await admin
    .from("customer_buyers")
    .select("id, customer_id, is_manager")
    .eq("id", reportsToId)
    .maybeSingle();
  if (!data) return { error: "reports_to buyer not found" };
  if (data.customer_id !== customerId) return { error: "reports_to buyer must belong to the same customer" };
  if (!data.is_manager) return { error: "reports_to buyer must be a management buyer" };
  return {};
}
