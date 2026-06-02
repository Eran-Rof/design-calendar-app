// api/internal/pim/attribute-defs
//
// GET  — list product_attribute_definitions. Filter:
//        ?category_id=<uuid>   exact match (omit → all defs for the entity)
// POST — create a new attribute definition. Body:
//        { category_id?, attribute_key, label, value_type,
//          options?, is_required?, sort_order? }
//        value_type must be one of enum|number|text|boolean|date.
//        If value_type==='enum', options.options must be a non-empty array
//        of strings.
//
// Tangerine P8-6 (M42 PIM).

import { createClient } from "@supabase/supabase-js";
import { VALUE_TYPES, validateOptionsForType } from "../../../../_lib/pim/attributeValue.js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ATTR_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export function parseListQuery(params) {
  const out = { category_id: null };
  const c = params.get("category_id");
  if (c != null && c !== "") {
    if (!UUID_RE.test(c)) return { error: "category_id must be a UUID" };
    out.category_id = c;
  }
  return { data: out };
}

export function validateCreate(body) {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Body must be an object" };
  }
  const out = {};

  // category_id is OPTIONAL per the schema (the column is nullable —
  // entity-wide defs exist), but if present must be a UUID.
  if (Object.prototype.hasOwnProperty.call(body, "category_id")) {
    const c = body.category_id;
    if (c == null || c === "") out.category_id = null;
    else if (typeof c !== "string" || !UUID_RE.test(c)) {
      return { error: "category_id must be a UUID" };
    } else out.category_id = c;
  } else {
    out.category_id = null;
  }

  const key = String(body.attribute_key ?? "").trim();
  if (!key) return { error: "attribute_key is required" };
  if (!ATTR_KEY_RE.test(key)) {
    return { error: "attribute_key must be snake_case (lowercase, digits, underscores; start with a letter)" };
  }
  out.attribute_key = key;

  const label = String(body.label ?? "").trim();
  if (!label) return { error: "label is required" };
  if (label.length > 120) return { error: "label must be <= 120 chars" };
  out.label = label;

  const vt = String(body.value_type ?? "").trim();
  if (!VALUE_TYPES.includes(vt)) {
    return { error: `value_type must be one of ${VALUE_TYPES.join(", ")}` };
  }
  out.value_type = vt;

  const opts = validateOptionsForType(vt, body.options ?? null);
  if (opts.error) return { error: opts.error };
  out.options = opts.data.options == null
    ? null
    : (vt === "enum" ? { options: opts.data.options } : opts.data.options);

  if (Object.prototype.hasOwnProperty.call(body, "is_required")) {
    if (typeof body.is_required !== "boolean") return { error: "is_required must be boolean" };
    out.is_required = body.is_required;
  } else {
    out.is_required = false;
  }

  if (Object.prototype.hasOwnProperty.call(body, "sort_order")) {
    const n = Number(body.sort_order);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      return { error: "sort_order must be an integer" };
    }
    out.sort_order = n;
  } else {
    out.sort_order = 0;
  }

  return { data: out };
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: entity } = await admin
    .from("entities")
    .select("id")
    .eq("code", "ROF")
    .maybeSingle();
  if (!entity) return res.status(500).json({ error: "Default entity (ROF) not found" });

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const v = parseListQuery(url.searchParams);
    if (v.error) return res.status(400).json({ error: v.error });

    let q = admin
      .from("product_attribute_definitions")
      .select("id, category_id, attribute_key, label, value_type, options, is_required, sort_order, created_at")
      .eq("entity_id", entity.id)
      .order("sort_order", { ascending: true })
      .order("attribute_key", { ascending: true });
    if (v.data.category_id) q = q.eq("category_id", v.data.category_id);

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data || []);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    const v = validateCreate(body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    const row = { ...v.data, entity_id: entity.id };
    const { data, error } = await admin
      .from("product_attribute_definitions")
      .insert(row)
      .select()
      .single();
    if (error) {
      if (error.code === "23505") {
        return res.status(409).json({ error: "An attribute definition with this key already exists for this category" });
      }
      return res.status(500).json({ error: error.message });
    }
    return res.status(201).json(data);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
