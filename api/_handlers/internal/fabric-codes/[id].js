// api/internal/fabric-codes/[id]
//
// GET    — fetch a single fabric_codes row.
// PATCH  — update mutable fields. `code` is locked post-creation; allows
//          name / composition_text / composition_json / fabric_weight_gsm /
//          country_of_origin_iso2 / care_instructions /
//          default_vendor_id / is_active.
// DELETE — hard delete. Returns 409 if any style_fabric_codes row references
//          this fabric (RESTRICT FK on junction).
//
// Tangerine P3 Chunk 11.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MUTABLE_FIELDS = new Set([
  "name", "composition_text", "composition_json", "fabric_weight_gsm",
  "country_of_origin_iso2", "care_instructions",
  "default_vendor_id", "is_active",
]);

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
      .from("fabric_codes")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Fabric code not found" });
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
      .from("fabric_codes")
      .update(v.data)
      .eq("id", id)
      .select()
      .single();
    if (error) {
      if (error.code === "PGRST116") return res.status(404).json({ error: "Fabric code not found" });
      return res.status(500).json({ error: error.message });
    }
    return res.status(200).json(data);
  }

  if (req.method === "DELETE") {
    // Block deletion if referenced by any style_fabric_codes row.
    const { count, error: refErr } = await admin
      .from("style_fabric_codes")
      .select("id", { count: "exact", head: true })
      .eq("fabric_code_id", id);
    if (refErr) return res.status(500).json({ error: refErr.message });
    if ((count ?? 0) > 0) {
      return res.status(409).json({ error: `Cannot delete: fabric is referenced by ${count} style assignment(s). Deactivate instead.` });
    }

    const { data, error } = await admin
      .from("fabric_codes")
      .delete()
      .eq("id", id)
      .select()
      .maybeSingle();
    if (error) {
      // 23503 = FK violation (race condition guard if a junction row was inserted between count + delete).
      if (error.code === "23503") {
        return res.status(409).json({ error: "Cannot delete: fabric is referenced by a style assignment. Deactivate instead." });
      }
      return res.status(500).json({ error: error.message });
    }
    if (!data) return res.status(404).json({ error: "Fabric code not found" });
    return res.status(200).json({ deleted: true, id });
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

export function validatePatch(body) {
  if (Object.prototype.hasOwnProperty.call(body, "code")) {
    return { error: "code is locked post-creation" };
  }
  if (Object.prototype.hasOwnProperty.call(body, "entity_id")) {
    return { error: "entity_id is locked" };
  }

  const out = {};
  for (const [k, raw] of Object.entries(body)) {
    if (!MUTABLE_FIELDS.has(k)) continue;
    out[k] = raw;
  }

  if (out.name != null) {
    const s = String(out.name).trim();
    if (!s) return { error: "name must not be empty" };
    out.name = s;
  }
  if (out.composition_text != null) {
    const s = String(out.composition_text).trim();
    if (!s) return { error: "composition_text must not be empty" };
    out.composition_text = s;
  }
  if (Object.prototype.hasOwnProperty.call(out, "composition_json")) {
    if (out.composition_json === "" || out.composition_json == null) {
      out.composition_json = null;
    } else if (typeof out.composition_json === "string") {
      try { out.composition_json = JSON.parse(out.composition_json); }
      catch { return { error: "composition_json must be valid JSON" }; }
    }
  }
  if (Object.prototype.hasOwnProperty.call(out, "fabric_weight_gsm")) {
    if (out.fabric_weight_gsm === "" || out.fabric_weight_gsm == null) {
      out.fabric_weight_gsm = null;
    } else {
      const w = Number(out.fabric_weight_gsm);
      if (!Number.isFinite(w) || w < 0) {
        return { error: "fabric_weight_gsm must be a non-negative number" };
      }
      out.fabric_weight_gsm = w;
    }
  }
  if (Object.prototype.hasOwnProperty.call(out, "country_of_origin_iso2")) {
    if (out.country_of_origin_iso2 === "" || out.country_of_origin_iso2 == null) {
      out.country_of_origin_iso2 = null;
    } else {
      const c = String(out.country_of_origin_iso2).trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(c)) {
        return { error: "country_of_origin_iso2 must be 2 letters (ISO 3166-1 alpha-2)" };
      }
      out.country_of_origin_iso2 = c;
    }
  }
  if (Object.prototype.hasOwnProperty.call(out, "care_instructions")) {
    if (out.care_instructions === "" || out.care_instructions == null) out.care_instructions = null;
    else out.care_instructions = String(out.care_instructions).trim();
  }
  if (Object.prototype.hasOwnProperty.call(out, "default_vendor_id")) {
    if (out.default_vendor_id === "" || out.default_vendor_id == null) {
      out.default_vendor_id = null;
    } else if (!UUID_RE.test(String(out.default_vendor_id))) {
      return { error: "default_vendor_id must be a uuid" };
    }
  }
  if (Object.prototype.hasOwnProperty.call(out, "is_active") && typeof out.is_active !== "boolean") {
    return { error: "is_active must be boolean" };
  }

  return { data: out };
}
