// api/internal/costing/projects/:id/lines
//
// GET  — list lines for a project (sorted by sort_order)
// POST — bulk upsert: body { lines: [...] }. Rows with `id` are UPDATEd; rows
//        without `id` are INSERTed with project_id and sort_order from index.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../../_lib/auth.js";

export const config = { maxDuration: 20 };

const LINE_FIELDS = [
  "sort_order",
  "style_master_id", "style_code", "style_name", "description", "picture_url",
  "size_scale_id", "size_scale_label", "fabric_code", "fit", "color",
  "bottom_closure", "waist_type", "waste_type",
  "category_id", "sub_category_id", "style_state",
  "comment", "remarks",
  "target_qty", "target_cost", "sell_target", "sell_price",
  "priced_date", "fob_cost", "duty_rate", "freight", "insurance", "other_costs",
  "landed_cost", "margin_pct",
  "selected_vendor_quote_id",
  "ly_qty", "ly_unit_cost", "ly_total_margin", "ly_margin_pct",
  "t3_qty", "t3_unit_cost", "t3_total_cost", "t3_margin_pct",
  "comp_refreshed_at",
];

function getProjectId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("projects");
  return idx >= 0 ? parts[idx + 1] : null;
}

function pick(obj, fields) {
  const out = {};
  for (const f of fields) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, f)) out[f] = obj[f];
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token");
  if (req.method === "OPTIONS") return res.status(200).end();

  const __internalAuth = authenticateInternalCaller(req);
  if (!__internalAuth.ok) return res.status(__internalAuth.status).json({ error: __internalAuth.error });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const projectId = getProjectId(req);
  if (!projectId) return res.status(400).json({ error: "Missing project id" });

  if (req.method === "GET") {
    const { data, error } = await admin.from("costing_lines")
      .select("*").eq("project_id", projectId)
      .order("sort_order", { ascending: true }).range(0, 999);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data || []);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const lines = Array.isArray(body?.lines) ? body.lines : [];
    if (lines.length === 0) return res.status(400).json({ error: "lines must be non-empty" });

    // Inherit entity_id from the parent project (current_entity_id() DEFAULT
    // returns NULL under service_role, so the handler must inject it).
    const { data: project } = await admin.from("costing_projects")
      .select("entity_id").eq("id", projectId).maybeSingle();
    if (!project) return res.status(404).json({ error: "Project not found" });
    const parentEntityId = project.entity_id;

    const toInsert = [];
    const toUpdate = [];
    lines.forEach((l, idx) => {
      const fields = pick(l, LINE_FIELDS);
      if (fields.sort_order == null) fields.sort_order = idx;
      if (l.id) {
        toUpdate.push({ id: l.id, ...fields });
      } else {
        toInsert.push({ entity_id: parentEntityId, project_id: projectId, ...fields });
      }
    });

    const results = [];
    if (toInsert.length > 0) {
      const { data, error } = await admin.from("costing_lines").insert(toInsert).select("*");
      if (error) return res.status(500).json({ error: error.message });
      results.push(...(data || []));
    }
    for (const u of toUpdate) {
      const { id, ...patch } = u;
      const { data, error } = await admin.from("costing_lines")
        .update(patch).eq("id", id).eq("project_id", projectId)
        .select("*").maybeSingle();
      if (error) return res.status(500).json({ error: error.message });
      if (data) results.push(data);
    }

    return res.status(200).json(results);
  }

  return res.status(405).json({ error: "Method not allowed" });
}
