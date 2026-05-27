// api/internal/style-fabric-codes/[id]
//
// GET    — fetch a single junction row.
// PATCH  — update role / yardage_per_unit / notes. style_id + fabric_code_id
//          are locked; recreate the row to change them.
// DELETE — hard delete the junction row.
//
// Tangerine P3 Chunk 11.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLE_VALUES = ["primary", "lining", "trim", "interlining", "accent", "other"];

const MUTABLE_FIELDS = new Set(["role", "yardage_per_unit", "notes"]);

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
      .from("style_fabric_codes")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Style-fabric link not found" });
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
      .from("style_fabric_codes")
      .update(v.data)
      .eq("id", id)
      .select()
      .single();
    if (error) {
      if (error.code === "23505") {
        return res.status(409).json({ error: "Another link with this (style, fabric, role) already exists" });
      }
      if (error.code === "PGRST116") return res.status(404).json({ error: "Style-fabric link not found" });
      return res.status(500).json({ error: error.message });
    }
    return res.status(200).json(data);
  }

  if (req.method === "DELETE") {
    const { data, error } = await admin
      .from("style_fabric_codes")
      .delete()
      .eq("id", id)
      .select()
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Style-fabric link not found" });
    return res.status(200).json({ deleted: true, id });
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

export function validatePatch(body) {
  for (const locked of ["style_id", "fabric_code_id", "entity_id"]) {
    if (Object.prototype.hasOwnProperty.call(body, locked)) {
      return { error: `${locked} is locked post-creation` };
    }
  }
  const out = {};
  for (const [k, raw] of Object.entries(body)) {
    if (!MUTABLE_FIELDS.has(k)) continue;
    out[k] = raw;
  }

  if (out.role != null) {
    if (!ROLE_VALUES.includes(out.role)) {
      return { error: `role must be one of ${ROLE_VALUES.join(", ")}` };
    }
  }
  if (Object.prototype.hasOwnProperty.call(out, "yardage_per_unit")) {
    if (out.yardage_per_unit === "" || out.yardage_per_unit == null) {
      out.yardage_per_unit = null;
    } else {
      const y = Number(out.yardage_per_unit);
      if (!Number.isFinite(y) || y < 0) {
        return { error: "yardage_per_unit must be a non-negative number" };
      }
      out.yardage_per_unit = y;
    }
  }
  if (Object.prototype.hasOwnProperty.call(out, "notes")) {
    if (out.notes === "" || out.notes == null) out.notes = null;
    else out.notes = String(out.notes).trim();
  }
  return { data: out };
}
