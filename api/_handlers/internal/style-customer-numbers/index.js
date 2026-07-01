// api/internal/style-customer-numbers
//
// GET  — list rows for one style. ?style_id=<uuid> REQUIRED (or ?customer_id=
//        for the reverse view). Each row embeds the customer {id, name, code}.
// POST — create a mapping. Body: { style_id, customer_id, customer_style_number, notes? }
//
// One base style ⇄ each customer's own style number. See migration
// 20260873000000. Self-managing junction, mirrors style-fabric-codes.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SELECT = "id, style_id, customer_id, customer_style_number, notes, created_at, updated_at, customer:customers!style_customer_numbers_customer_id_fkey (id, name, code, customer_code), style:style_master!style_customer_numbers_style_id_fkey (id, style_code, style_name)";

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
  const { data, error } = await admin.from("entities").select("id").eq("code", "ROF").maybeSingle();
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
    const styleId = url.searchParams.get("style_id");
    const customerId = url.searchParams.get("customer_id");
    if (!styleId && !customerId) {
      return res.status(400).json({ error: "One of style_id or customer_id query param is required" });
    }
    if (styleId && !UUID_RE.test(styleId)) return res.status(400).json({ error: "style_id must be a uuid" });
    if (customerId && !UUID_RE.test(customerId)) return res.status(400).json({ error: "customer_id must be a uuid" });

    let query = admin.from("style_customer_numbers").select(SELECT).eq("entity_id", entityId)
      .order("created_at", { ascending: true });
    if (styleId) query = query.eq("style_id", styleId);
    if (customerId) query = query.eq("customer_id", customerId);

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
      .from("style_customer_numbers")
      .insert({ entity_id: entityId, ...v.data })
      .select(SELECT)
      .single();

    if (error) {
      if (error.code === "23505") return res.status(409).json({ error: "This customer already has a style number mapped for this style" });
      if (error.code === "23503") return res.status(400).json({ error: "Referenced style_id or customer_id does not exist" });
      return res.status(500).json({ error: error.message });
    }
    return res.status(201).json(data);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

export function validateInsert(body) {
  if (!body.style_id || !UUID_RE.test(String(body.style_id))) return { error: "style_id must be a uuid" };
  if (!body.customer_id || !UUID_RE.test(String(body.customer_id))) return { error: "customer_id must be a uuid" };
  if (!body.customer_style_number || !String(body.customer_style_number).trim()) {
    return { error: "customer_style_number is required" };
  }
  return {
    data: {
      style_id: String(body.style_id),
      customer_id: String(body.customer_id),
      customer_style_number: String(body.customer_style_number).trim(),
      notes: body.notes != null && String(body.notes).trim() !== "" ? String(body.notes).trim() : null,
    },
  };
}
