// api/internal/employee-titles
//
// GET  — list employee titles for the default entity, ordered by sort_order
//        then name. Query: ?q=<search> (ilike on name).
// POST — create one employee_titles row. Body:
//          { name (required), is_sales_role (bool, default false),
//            sort_order (>=0 int, optional, default 0) }
//
// P16 — Employee Title master. Mirrors the payment-terms handler shape
// (createClient + resolveDefaultEntityId + ROF scope, service-role writes,
// anon-read enforced in DB via RLS).

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
    .from("entities").select("id").eq("code", "ROF").maybeSingle();
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
    const q = (url.searchParams.get("q") || "").trim();

    let query = admin
      .from("employee_titles")
      .select("*")
      .eq("entity_id", entityId)
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true });

    if (q) {
      const esc = q.replace(/[,()]/g, " ");
      query = query.ilike("name", `%${esc}%`);
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

    const { data, error } = await admin
      .from("employee_titles")
      .insert({ ...v.data, entity_id: entityId })
      .select()
      .single();
    if (error) {
      if (error.code === "23505") {
        return res.status(409).json({ error: `title '${v.data.name}' already exists for this entity` });
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

  const isSalesRole = body.is_sales_role == null ? false :
    typeof body.is_sales_role === "boolean" ? body.is_sales_role :
      body.is_sales_role === "true" || body.is_sales_role === 1;

  let sortOrder = 0;
  if (body.sort_order != null && body.sort_order !== "") {
    sortOrder = typeof body.sort_order === "number" ? body.sort_order : parseInt(body.sort_order, 10);
    if (!Number.isInteger(sortOrder) || sortOrder < 0) {
      return { error: "sort_order must be a non-negative integer" };
    }
  }

  return {
    data: {
      name:          String(body.name).trim(),
      is_sales_role: isSalesRole,
      sort_order:    sortOrder,
    },
  };
}
