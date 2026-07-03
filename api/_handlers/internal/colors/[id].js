// api/internal/colors/[id]
//
// GET    — fetch a single color_master row.
// PATCH  — update mutable fields (name, code, hex, sort_order, is_active).
//          `entity_id` / `id` are LOCKED.
// DELETE — hard-delete. Rejected (409) if any style still references this color
//          in style_master.attributes.color_ids (a JSON array of color ids — no
//          FK, so we check the array membership to avoid orphaning a style's
//          declared colors). Retire with is_active=false instead in that case.
//
// Tangerine — Color Master.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MUTABLE_FIELDS = new Set(["name", "code", "hex", "hex_b", "sort_order", "is_active", "nrf_code", "nrf_name"]);
const LOCKED_FIELDS = new Set(["entity_id", "id"]);

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

  // Per feedback_dispatcher_query_not_params: read path params from req.query.
  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const { data, error } = await admin
      .from("color_master")
      .select("id, name, code, hex, hex_b, sort_order, is_active, nrf_code, nrf_name")
      .eq("id", id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Color not found" });
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
      .from("color_master")
      .update(v.data)
      .eq("id", id)
      .select("id, name, code, hex, hex_b, sort_order, is_active, nrf_code, nrf_name")
      .single();
    if (error) {
      if (error.code === "PGRST116") return res.status(404).json({ error: "Color not found" });
      if (error.code === "23505") return res.status(409).json({ error: "A color with this name already exists" });
      return res.status(500).json({ error: error.message });
    }
    return res.status(200).json(data);
  }

  if (req.method === "DELETE") {
    const { data: row, error: getErr } = await admin
      .from("color_master")
      .select("id")
      .eq("id", id)
      .maybeSingle();
    if (getErr) return res.status(500).json({ error: getErr.message });
    if (!row) return res.status(404).json({ error: "Color not found" });

    // Block if any style declares this color in attributes.color_ids (JSON
    // array — no FK exists). jsonb containment: attributes @> {"color_ids":[id]}
    // is true when the style's color_ids array includes this id.
    const { count, error: refErr } = await admin
      .from("style_master")
      .select("id", { count: "exact", head: true })
      .contains("attributes", { color_ids: [id] });
    if (refErr) return res.status(500).json({ error: refErr.message });
    if ((count || 0) > 0) {
      return res.status(409).json({
        error: "Color is still used by one or more styles. Remove it from those styles first, or toggle Active off to retire it.",
        references: { styles: count },
      });
    }

    const { data, error } = await admin
      .from("color_master")
      .delete()
      .eq("id", id)
      .select("id")
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Color not found" });
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
      return { error: `${f} is locked and cannot be updated` };
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
  if ("code" in out) {
    out.code = out.code != null && String(out.code).trim() !== "" ? String(out.code).trim() : null;
  }
  if ("hex" in out) {
    if (out.hex == null || String(out.hex).trim() === "") {
      out.hex = null;
    } else {
      const h = String(out.hex).trim().replace(/^#/, "");
      if (!/^[0-9a-fA-F]{6}$/.test(h)) return { error: "hex must be a 6-digit #RRGGBB value" };
      out.hex = `#${h.toLowerCase()}`;
    }
  }
  if ("hex_b" in out) {
    if (out.hex_b == null || String(out.hex_b).trim() === "") {
      out.hex_b = null;
    } else {
      const h = String(out.hex_b).trim().replace(/^#/, "");
      if (!/^[0-9a-fA-F]{6}$/.test(h)) return { error: "hex_b must be a 6-digit #RRGGBB value" };
      out.hex_b = `#${h.toLowerCase()}`;
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
