// api/internal/hts-codes
//
// GET  — list hts_master rows for the default entity.
//        Query: ?q=<search>              — ILIKE over code/description/chapter
//               ?include_inactive=true   — include is_active=false rows (default: active only)
// POST — create a new HTS master row. Body: {
//          code (required, e.g. "6110.20.2090"),
//          description (required),
//          chapter?, heading?, duty_rate_pct?, notes?,
//          sort_order?, is_active?
//        }
//        NO auto-code: operator provides the real HTS code string.
//
// HTS Master — Tangerine operator-managed reference table for HTS codes.

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
      .from("hts_master")
      .select("id, entity_id, code, description, chapter, heading, duty_rate_pct, notes, is_active, sort_order, created_at, updated_at")
      .eq("entity_id", entityId)
      .order("sort_order", { ascending: true })
      .order("code", { ascending: true });

    if (!includeInactive) query = query.eq("is_active", true);
    if (q) {
      const esc = q.replace(/[,()]/g, " ");
      query = query.or(`code.ilike.%${esc}%,description.ilike.%${esc}%,chapter.ilike.%${esc}%`);
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
      .from("hts_master")
      .insert({ ...v.data, entity_id: entityId })
      .select()
      .single();

    if (error) {
      if (error.code === "23505") {
        return res.status(409).json({ error: `HTS code "${v.data.code}" already exists for this entity` });
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
  if (!body.code || !String(body.code).trim()) {
    return { error: "code is required (e.g. \"6110.20.2090\")" };
  }
  if (!body.description || !String(body.description).trim()) {
    return { error: "description is required" };
  }

  const out = {
    code:        String(body.code).trim(),
    description: String(body.description).trim(),
  };

  if (body.chapter != null && body.chapter !== "") {
    out.chapter = String(body.chapter).trim();
  }
  if (body.heading != null && body.heading !== "") {
    out.heading = String(body.heading).trim();
  }
  if (body.notes != null && body.notes !== "") {
    out.notes = String(body.notes).trim();
  }

  if (body.duty_rate_pct != null && body.duty_rate_pct !== "") {
    const d = Number(body.duty_rate_pct);
    if (!Number.isFinite(d) || d < 0) {
      return { error: "duty_rate_pct must be a non-negative number" };
    }
    out.duty_rate_pct = d;
  }

  let sortOrder = 0;
  if (body.sort_order != null && body.sort_order !== "") {
    sortOrder = typeof body.sort_order === "number" ? body.sort_order : parseInt(body.sort_order, 10);
    if (!Number.isInteger(sortOrder) || sortOrder < 0) {
      return { error: "sort_order must be a non-negative integer" };
    }
  }
  out.sort_order = sortOrder;

  out.is_active = body.is_active == null ? true :
    typeof body.is_active === "boolean" ? body.is_active :
      body.is_active === "true" || body.is_active === 1;

  return { data: out };
}
