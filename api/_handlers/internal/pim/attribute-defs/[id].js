// api/internal/pim/attribute-defs/:id
//
// GET    — return one product_attribute_definitions row.
// PATCH  — update mutable fields. Body subset of
//          { label, value_type, options, is_required, sort_order }.
//          attribute_key + category_id are intentionally immutable — operators
//          must create a new def + migrate values rather than rename one.
// DELETE — HARD delete with the in-use safety guard: if any
//          product_attributes row references this (category_id, attribute_key),
//          we return 409 with the in-use count and refuse.  The schema has
//          no `is_active` column on this table so soft-delete isn't an
//          option here.
//
// Tangerine P8-6 (M42 PIM).

import { createClient } from "@supabase/supabase-js";
import { VALUE_TYPES, validateOptionsForType } from "../../../../_lib/pim/attributeValue.js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export function validatePatch(body) {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Body must be an object" };
  }
  const out = {};

  // attribute_key + category_id are immutable; silently ignore them if sent
  // (operators sometimes echo whole row back). Better than 400-ing legit edits.

  if (Object.prototype.hasOwnProperty.call(body, "label")) {
    const s = String(body.label ?? "").trim();
    if (!s) return { error: "label cannot be empty" };
    if (s.length > 120) return { error: "label must be <= 120 chars" };
    out.label = s;
  }

  // value_type + options together (if either provided, both must be coherent).
  const has_vt = Object.prototype.hasOwnProperty.call(body, "value_type");
  const has_opts = Object.prototype.hasOwnProperty.call(body, "options");
  if (has_vt) {
    const vt = String(body.value_type ?? "").trim();
    if (!VALUE_TYPES.includes(vt)) {
      return { error: `value_type must be one of ${VALUE_TYPES.join(", ")}` };
    }
    out.value_type = vt;
    const opts = validateOptionsForType(vt, has_opts ? body.options : null);
    if (opts.error) return { error: opts.error };
    out.options = opts.data.options == null
      ? null
      : (vt === "enum" ? { options: opts.data.options } : opts.data.options);
  } else if (has_opts) {
    // Options-only edit — accept the new value as a plain JSONB blob; the
    // existing value_type stays. If caller wants to retype an enum, they
    // must send both fields.
    if (body.options == null) out.options = null;
    else if (typeof body.options !== "object" || Array.isArray(body.options)) {
      return { error: "options must be an object or null" };
    } else out.options = body.options;
  }

  if (Object.prototype.hasOwnProperty.call(body, "is_required")) {
    if (typeof body.is_required !== "boolean") return { error: "is_required must be boolean" };
    out.is_required = body.is_required;
  }

  if (Object.prototype.hasOwnProperty.call(body, "sort_order")) {
    const n = Number(body.sort_order);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      return { error: "sort_order must be an integer" };
    }
    out.sort_order = n;
  }

  if (Object.keys(out).length === 0) return { error: "No fields to update" };
  return { data: out };
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: "Invalid id" });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const { data, error } = await admin
      .from("product_attribute_definitions")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Attribute definition not found" });
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

    const { data, error } = await admin
      .from("product_attribute_definitions")
      .update(v.data)
      .eq("id", id)
      .select()
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Attribute definition not found" });
    return res.status(200).json(data);
  }

  if (req.method === "DELETE") {
    // Look up the def so we know its (attribute_key, category_id) for the
    // in-use check.
    const { data: def, error: defErr } = await admin
      .from("product_attribute_definitions")
      .select("id, attribute_key, category_id, entity_id")
      .eq("id", id)
      .maybeSingle();
    if (defErr) return res.status(500).json({ error: defErr.message });
    if (!def) return res.status(404).json({ error: "Attribute definition not found" });

    // Count product_attributes rows that use this attribute_key on a
    // style whose category matches the def (or on any style if def is
    // entity-wide, i.e. category_id == null).
    let countQ = admin
      .from("product_attributes")
      .select("id", { count: "exact", head: true })
      .eq("entity_id", def.entity_id)
      .eq("attribute_key", def.attribute_key);
    if (def.category_id) {
      // Filter to styles in the same category. We embed style_master via
      // PostgREST FK.  style_master has category_id.
      countQ = countQ.eq("style_master.category_id", def.category_id);
    }
    const { count, error: cntErr } = await countQ;
    if (cntErr) return res.status(500).json({ error: cntErr.message });
    if ((count || 0) > 0) {
      return res.status(409).json({
        error: "Attribute definition is in use by one or more styles; reassign or clear values before deleting",
        in_use_count: count,
      });
    }

    const { error: delErr } = await admin
      .from("product_attribute_definitions")
      .delete()
      .eq("id", id);
    if (delErr) return res.status(500).json({ error: delErr.message });
    return res.status(200).json({ deleted: true, id });
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
