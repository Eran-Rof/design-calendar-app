// api/internal/hts-codes/[id]
//
// GET    — fetch a single hts_master row.
// PATCH  — update mutable fields. `code` and `entity_id` are LOCKED
//          post-creation. Mutable: description, chapter, heading,
//          duty_rate_pct, notes, is_active, sort_order.
// DELETE — hard-delete. No FK references to guard against (fabric_codes
//          uses hts_code as a free text field, not an FK).
//
// HTS Master — Tangerine operator-managed reference table for HTS codes.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MUTABLE_FIELDS = new Set(["description", "chapter", "heading", "duty_rate_pct", "notes", "is_active", "sort_order"]);
const LOCKED_FIELDS  = new Set(["code", "entity_id", "id"]);

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

  // Per feedback_dispatcher_query_not_params: always read path params from req.query.
  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const { data, error } = await admin
      .from("hts_master")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "HTS code not found" });
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
      .from("hts_master")
      .update(v.data)
      .eq("id", id)
      .select()
      .single();
    if (error) {
      if (error.code === "PGRST116") return res.status(404).json({ error: "HTS code not found" });
      return res.status(500).json({ error: error.message });
    }
    return res.status(200).json(data);
  }

  if (req.method === "DELETE") {
    const { data, error } = await admin
      .from("hts_master")
      .delete()
      .eq("id", id)
      .select("id")
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "HTS code not found" });
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

  if ("description" in out) {
    if (!out.description || String(out.description).trim() === "") {
      return { error: "description cannot be empty" };
    }
    out.description = String(out.description).trim();
  }
  if ("chapter" in out) {
    out.chapter = out.chapter != null && out.chapter !== "" ? String(out.chapter).trim() : null;
  }
  if ("heading" in out) {
    out.heading = out.heading != null && out.heading !== "" ? String(out.heading).trim() : null;
  }
  if ("notes" in out) {
    out.notes = out.notes != null && out.notes !== "" ? String(out.notes).trim() : null;
  }
  if ("duty_rate_pct" in out) {
    if (out.duty_rate_pct == null || out.duty_rate_pct === "") {
      out.duty_rate_pct = null;
    } else {
      const d = Number(out.duty_rate_pct);
      if (!Number.isFinite(d) || d < 0) {
        return { error: "duty_rate_pct must be a non-negative number" };
      }
      out.duty_rate_pct = d;
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
  if ("is_active" in out) {
    if (typeof out.is_active !== "boolean") {
      out.is_active = out.is_active === "true" || out.is_active === 1;
    }
  }

  return { data: out };
}
