// api/internal/style-master
//
// GET  — list all style_master rows for the default entity. Returns soft-active
//        rows by default; ?include_deleted=true returns everything.
//        Query params: ?q=<search> matches style_code/description; ?limit=N (default 200)
// POST — create a new style. Body: { style_code, description, category_id?, gender_code?,
//        season?, design_year?, is_apparel?, planning_class?, lifecycle_status?, base_fabric?, attributes? }
//
// Tangerine P1 Chunk 7. Adheres to api/_handlers/internal/entities/index.js shape.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const GENDER_VALUES     = ["M", "WMS", "B", "C", "G", "U"];
const LIFECYCLE_VALUES  = ["active", "phased_out", "discontinued", "core"];
const PLANNING_VALUES   = ["core", "seasonal", "fashion"];

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
    const includeDeleted = url.searchParams.get("include_deleted") === "true";
    const q = (url.searchParams.get("q") || "").trim();
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "200", 10) || 200, 500);

    let query = admin
      .from("style_master")
      .select("id, style_code, description, category_id, gender_code, season, design_year, is_apparel, launch_date, lifecycle_status, planning_class, base_fabric, attributes, created_at, updated_at, deleted_at")
      .eq("entity_id", entityId)
      .order("style_code", { ascending: true })
      .limit(limit);

    if (!includeDeleted) query = query.is("deleted_at", null);
    if (q) query = query.or(`style_code.ilike.%${q}%,description.ilike.%${q}%`);

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

    const row = {
      entity_id: entityId,
      style_code: v.data.style_code.toUpperCase(),
      description: v.data.description,
      category_id: v.data.category_id || null,
      gender_code: v.data.gender_code || null,
      season: v.data.season || null,
      design_year: v.data.design_year || null,
      is_apparel: v.data.is_apparel !== false,
      launch_date: v.data.launch_date || null,
      lifecycle_status: v.data.lifecycle_status || "active",
      planning_class: v.data.planning_class || null,
      base_fabric: v.data.base_fabric || null,
      attributes: v.data.attributes || {},
    };

    const { data, error } = await admin
      .from("style_master")
      .insert(row)
      .select()
      .single();

    if (error) {
      if (error.code === "23505") {
        return res.status(409).json({ error: `style_code '${row.style_code}' already exists for this entity` });
      }
      return res.status(500).json({ error: error.message });
    }
    return res.status(201).json(data);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

export function validateInsert(body) {
  if (!body.style_code || !String(body.style_code).trim()) {
    return { error: "style_code is required" };
  }
  if (!body.description || !String(body.description).trim()) {
    return { error: "description is required" };
  }
  if (body.gender_code && !GENDER_VALUES.includes(body.gender_code)) {
    return { error: `gender_code must be one of ${GENDER_VALUES.join(", ")}` };
  }
  if (body.lifecycle_status && !LIFECYCLE_VALUES.includes(body.lifecycle_status)) {
    return { error: `lifecycle_status must be one of ${LIFECYCLE_VALUES.join(", ")}` };
  }
  if (body.planning_class && !PLANNING_VALUES.includes(body.planning_class)) {
    return { error: `planning_class must be one of ${PLANNING_VALUES.join(", ")}` };
  }
  if (body.design_year != null) {
    const y = parseInt(body.design_year, 10);
    if (!Number.isFinite(y) || y < 1990 || y > 2100) {
      return { error: "design_year must be between 1990 and 2100" };
    }
    body.design_year = y;
  }
  return { data: body };
}
