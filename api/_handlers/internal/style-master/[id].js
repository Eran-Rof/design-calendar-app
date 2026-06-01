// api/internal/style-master/[id]
//
// GET    — fetch a single style_master row with embedded fabric_codes join.
// PATCH  — update mutable fields. Body: any subset of mutable cols (style_code rejected).
// DELETE — soft-delete by setting deleted_at = now().
//
// Tangerine P1 Chunk 7 + Style Master Sweep 2026-05-30 + Fabric FK 2026-05-30 (#13).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

// New canonical six-letter set per operator (#12, 2026-05-30).
const GENDER_VALUES    = ["M", "B", "C", "G", "W", "U"];
const LIFECYCLE_VALUES = ["active", "phased_out", "discontinued", "core"];
const PLANNING_VALUES  = ["core", "seasonal", "fashion"];
const UUID_RE          = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MUTABLE_FIELDS = new Set([
  "style_name", "description", "category_id", "gender_code", "season", "design_year",
  "is_apparel", "launch_date", "lifecycle_status", "planning_class",
  "base_fabric_code_id", "group_name", "category_name", "sub_category_name", "brand_id", "attributes",
]);

const STYLE_SELECT = "id, style_code, style_name, description, category_id, gender_code, season, design_year, is_apparel, launch_date, lifecycle_status, planning_class, base_fabric_code_id, base_fabric_legacy, group_name, category_name, sub_category_name, brand_id, attributes, created_at, updated_at, deleted_at, base_fabric:fabric_codes!style_master_base_fabric_code_id_fkey(id, code, name)";

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
    const { data, error } = await admin
      .from("style_master")
      .select(STYLE_SELECT)
      .eq("id", id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Style not found" });
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
      .from("style_master")
      .update({ ...v.data, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select(STYLE_SELECT)
      .single();
    if (error) {
      if (error.code === "PGRST116") return res.status(404).json({ error: "Style not found" });
      if (error.code === "23503") {
        return res.status(400).json({ error: "base_fabric_code_id does not reference an existing fabric" });
      }
      return res.status(500).json({ error: error.message });
    }
    return res.status(200).json(data);
  }

  if (req.method === "DELETE") {
    const { data, error } = await admin
      .from("style_master")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id)
      .is("deleted_at", null)
      .select()
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Style not found or already deleted" });
    return res.status(200).json({ deleted: true, id });
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

export function validatePatch(body) {
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (!MUTABLE_FIELDS.has(k)) continue;
    out[k] = v;
  }
  if (out.gender_code != null && out.gender_code !== "" && !GENDER_VALUES.includes(out.gender_code)) {
    return { error: `gender_code must be one of ${GENDER_VALUES.join(", ")}` };
  }
  if (out.lifecycle_status != null && !LIFECYCLE_VALUES.includes(out.lifecycle_status)) {
    return { error: `lifecycle_status must be one of ${LIFECYCLE_VALUES.join(", ")}` };
  }
  if (out.planning_class != null && out.planning_class !== "" && !PLANNING_VALUES.includes(out.planning_class)) {
    return { error: `planning_class must be one of ${PLANNING_VALUES.join(", ")}` };
  }
  if (out.design_year != null && out.design_year !== "") {
    const y = parseInt(out.design_year, 10);
    if (!Number.isFinite(y) || y < 1990 || y > 2100) {
      return { error: "design_year must be between 1990 and 2100" };
    }
    out.design_year = y;
  }
  if (Object.prototype.hasOwnProperty.call(out, "base_fabric_code_id")) {
    if (out.base_fabric_code_id === "" || out.base_fabric_code_id === null) {
      out.base_fabric_code_id = null;
    } else if (!UUID_RE.test(String(out.base_fabric_code_id))) {
      return { error: "base_fabric_code_id must be a uuid (or null to clear)" };
    }
  }
  // Brand FK (Chunk J, item 4) — uuid or null.
  if (Object.prototype.hasOwnProperty.call(out, "brand_id")) {
    if (out.brand_id === "" || out.brand_id === null) {
      out.brand_id = null;
    } else if (!UUID_RE.test(String(out.brand_id))) {
      return { error: "brand_id must be a uuid (or null to clear)" };
    }
  }
  // Normalize empty strings to null for nullable text fields.
  for (const k of [
    "style_name", "gender_code", "season", "planning_class",
    "category_id", "group_name", "category_name", "sub_category_name",
  ]) {
    if (out[k] === "") out[k] = null;
    else if (typeof out[k] === "string" && ["group_name","category_name","sub_category_name","style_name","season"].includes(k)) {
      const trimmed = out[k].trim();
      out[k] = trimmed === "" ? null : trimmed;
    }
  }
  return { data: out };
}
