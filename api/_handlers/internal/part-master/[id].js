// api/internal/part-master/[id]
//
// GET    — fetch a single part_master row.
// PATCH  — update mutable fields. `code` and `entity_id` are LOCKED.
//          Mutable: name, part_type, uom, default_vendor_id,
//          default_unit_cost_cents, is_size_scaled, fabric_code_id, notes,
//          sort_order, is_active.
// DELETE — hard-delete (toggle is_active=false to retire instead).
//
// Tangerine — Manufacturing Part Master.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MUTABLE_FIELDS = new Set([
  "name", "part_type", "uom", "default_vendor_id", "default_unit_cost_cents",
  "is_size_scaled", "fabric_code_id", "notes", "sort_order", "is_active",
  "is_matrix", "size_scale_id",
]);
const LOCKED_FIELDS = new Set(["code", "entity_id", "id"]);

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

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const { data, error } = await admin
      .from("part_master")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Part not found" });
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
    v.data.updated_at = new Date().toISOString();
    const { data, error } = await admin
      .from("part_master")
      .update(v.data)
      .eq("id", id)
      .select()
      .single();
    if (error) {
      if (error.code === "PGRST116") return res.status(404).json({ error: "Part not found" });
      return res.status(500).json({ error: error.message });
    }
    return res.status(200).json(data);
  }

  if (req.method === "DELETE") {
    const { data, error } = await admin
      .from("part_master")
      .delete()
      .eq("id", id)
      .select("id")
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Part not found" });
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

  if ("name" in out) {
    if (out.name == null || String(out.name).trim() === "") {
      return { error: "name cannot be empty" };
    }
    out.name = String(out.name).trim();
  }

  if ("part_type" in out) {
    out.part_type = String(out.part_type).trim();
    if (!out.part_type) return { error: "part_type cannot be empty" };
  }

  if ("uom" in out) out.uom = String(out.uom).trim() || "each";
  if ("notes" in out) out.notes = out.notes ? String(out.notes).trim() || null : null;

  for (const fk of ["default_vendor_id", "fabric_code_id"]) {
    if (fk in out) {
      if (out[fk] == null || out[fk] === "") { out[fk] = null; }
      else if (!UUID_RE.test(String(out[fk]))) { return { error: `${fk} must be a uuid` }; }
    }
  }

  if ("default_unit_cost_cents" in out) {
    if (out.default_unit_cost_cents == null || out.default_unit_cost_cents === "") {
      out.default_unit_cost_cents = null;
    } else {
      const n = typeof out.default_unit_cost_cents === "number"
        ? out.default_unit_cost_cents : parseInt(out.default_unit_cost_cents, 10);
      if (!Number.isInteger(n) || n < 0) {
        return { error: "default_unit_cost_cents must be a non-negative integer (cents)" };
      }
      out.default_unit_cost_cents = n;
    }
  }

  if ("sort_order" in out) {
    if (out.sort_order == null || out.sort_order === "") {
      out.sort_order = 0;
    } else {
      const n = typeof out.sort_order === "number" ? out.sort_order : parseInt(out.sort_order, 10);
      if (!Number.isInteger(n) || n < 0) {
        return { error: "sort_order must be a non-negative integer" };
      }
      out.sort_order = n;
    }
  }

  for (const b of ["is_active", "is_size_scaled", "is_matrix"]) {
    if (b in out && typeof out[b] !== "boolean") {
      out[b] = out[b] === "true" || out[b] === 1;
    }
  }
  if ("size_scale_id" in out) {
    if (out.size_scale_id == null || out.size_scale_id === "") out.size_scale_id = null;
    else if (!UUID_RE.test(String(out.size_scale_id))) return { error: "size_scale_id must be a uuid" };
  }
  // A matrix part is implicitly size-scaled; a matrix part with no scale keeps null.
  if (out.is_matrix === true) out.is_size_scaled = true;
  if (out.is_matrix === false) out.size_scale_id = null;

  return { data: out };
}
