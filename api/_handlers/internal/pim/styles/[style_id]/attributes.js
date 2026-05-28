// api/internal/pim/styles/:style_id/attributes
//
// PATCH — upsert ONE attribute value on a style.
//   Body: { attribute_key, value }
//   - attribute_key must match an existing product_attribute_definitions row,
//     scoped to either the style's category or entity-wide (category_id null).
//   - value is validated against the def's value_type before write
//     (enum members from options.options; finite Number; strict boolean;
//     ISO YYYY-MM-DD calendar date; text <= 10K chars).
//   - x-user-id header (if present + UUID) is stamped into updated_by_user_id.
//
// Tangerine P8-6 (M42 PIM).

import { createClient } from "@supabase/supabase-js";
import { validateValueAgainstDef } from "../../../../../_lib/pim/attributeValue.js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ATTR_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-User-Id");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export function validateBody(body) {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Body must be an object" };
  }
  const key = String(body.attribute_key ?? "").trim();
  if (!key) return { error: "attribute_key is required" };
  if (!ATTR_KEY_RE.test(key)) {
    return { error: "attribute_key must be snake_case (lowercase, digits, underscores; start with a letter)" };
  }
  if (!Object.prototype.hasOwnProperty.call(body, "value")) {
    return { error: "value is required" };
  }
  return { data: { attribute_key: key, value: body.value } };
}

function actorUserIdFromReq(req) {
  const v = req.headers?.["x-user-id"];
  if (typeof v !== "string") return null;
  return UUID_RE.test(v) ? v : null;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "PATCH") {
    res.setHeader("Allow", "PATCH");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const style_id = req.query?.style_id;
  if (!style_id || !UUID_RE.test(style_id)) {
    return res.status(400).json({ error: "Invalid style_id" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }
  const v = validateBody(body || {});
  if (v.error) return res.status(400).json({ error: v.error });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  // Look up the style to get entity_id + category_id.
  const { data: style, error: sErr } = await admin
    .from("style_master")
    .select("id, entity_id, category_id")
    .eq("id", style_id)
    .maybeSingle();
  if (sErr) return res.status(500).json({ error: sErr.message });
  if (!style) return res.status(404).json({ error: "Style not found" });

  // Find the attribute definition. Prefer category-scoped def; fall back to
  // entity-wide (category_id null).
  let defQ = admin
    .from("product_attribute_definitions")
    .select("id, category_id, attribute_key, value_type, options, is_required")
    .eq("entity_id", style.entity_id)
    .eq("attribute_key", v.data.attribute_key);
  if (style.category_id) {
    defQ = defQ.or(`category_id.is.null,category_id.eq.${style.category_id}`);
  } else {
    defQ = defQ.is("category_id", null);
  }
  const { data: defs, error: defErr } = await defQ;
  if (defErr) return res.status(500).json({ error: defErr.message });
  if (!defs || defs.length === 0) {
    return res.status(404).json({ error: `No attribute definition found for key '${v.data.attribute_key}'` });
  }
  // Pick the most specific def (category-scoped wins over entity-wide).
  const def = defs.find((d) => d.category_id != null) || defs[0];

  // Validate the incoming value against the def's value_type.
  const valChk = validateValueAgainstDef(def, v.data.value);
  if (valChk.error) return res.status(400).json({ error: valChk.error });

  const actor = actorUserIdFromReq(req);

  // Upsert by (style_id, attribute_key) — the table's unique constraint.
  const row = {
    entity_id: style.entity_id,
    style_id,
    attribute_key: v.data.attribute_key,
    value: valChk.data, // {value: <coerced>}
    updated_at: new Date().toISOString(),
    updated_by_user_id: actor,
  };
  const { data, error } = await admin
    .from("product_attributes")
    .upsert(row, { onConflict: "style_id,attribute_key" })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json(data);
}
