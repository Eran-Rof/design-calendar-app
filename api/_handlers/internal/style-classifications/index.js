// api/internal/style-classifications
//
// GET  — list style_classifications for the default entity (ROF), filtered
//        by ?kind=group|category|sub_category (optional — omit for all kinds).
//        Default is_active=true only; ?include_inactive=true returns all.
//        ?q=<search> ilike on name. Ordered kind, sort_order, name.
// POST — create one row. Body:
//          { kind (required: group|category|sub_category), name (required),
//            sort_order (>=0, optional, default 0), is_active (default true) }
//
// Chunk I — Group / Category / Sub-category Master. Entity-scoped (ROF).
// Mirrors the payment-terms handler shape (resolveDefaultEntityId + ROF scope).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const KINDS = new Set(["group", "category", "sub_category"]);

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
    const kind = (url.searchParams.get("kind") || "").trim();
    const q = (url.searchParams.get("q") || "").trim();

    if (kind && !KINDS.has(kind)) {
      return res.status(400).json({ error: "kind must be one of group, category, sub_category" });
    }

    let query = admin
      .from("style_classifications")
      .select("*")
      .eq("entity_id", entityId)
      .order("kind", { ascending: true })
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true });

    if (kind) query = query.eq("kind", kind);
    if (!includeInactive) query = query.eq("is_active", true);
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
      .from("style_classifications")
      .insert({ ...v.data, entity_id: entityId })
      .select()
      .single();
    if (error) {
      if (error.code === "23505") {
        return res.status(409).json({ error: `${v.data.kind} '${v.data.name}' already exists for this entity` });
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
  if (!body.kind || !KINDS.has(String(body.kind).trim())) {
    return { error: "kind is required and must be one of group, category, sub_category" };
  }
  if (!body.name || !String(body.name).trim()) {
    return { error: "name is required" };
  }

  let sortOrder = 0;
  if (body.sort_order != null && body.sort_order !== "") {
    sortOrder = typeof body.sort_order === "number" ? body.sort_order : parseInt(body.sort_order, 10);
    if (!Number.isInteger(sortOrder) || sortOrder < 0) {
      return { error: "sort_order must be a non-negative integer" };
    }
  }

  const isActive = body.is_active == null ? true :
    typeof body.is_active === "boolean" ? body.is_active :
      body.is_active === "true" || body.is_active === 1;

  return {
    data: {
      kind:       String(body.kind).trim(),
      name:       String(body.name).trim(),
      sort_order: sortOrder,
      is_active:  isActive,
    },
  };
}
