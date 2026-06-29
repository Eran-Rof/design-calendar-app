// api/internal/fabric-mills/[id]
//
// GET    — fetch a single fabric_mill_master row.
// PATCH  — update mutable fields. `code` and `entity_id` are LOCKED
//          post-creation. Mutable: name, country_code, contact_name,
//          contact_email, website, notes, sort_order, is_active.
// DELETE — hard-delete (no reference check needed for now).
//
// Tangerine — Fabric Mill Master.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MUTABLE_FIELDS = new Set(["name", "country_code", "contact_name", "contact_email", "website", "notes", "sort_order", "is_active", "contacts"]);

// Up to `max` contacts, each {name,email,phone,title} (strings only). Blank
// rows dropped; truncated beyond `max`. Mirrors the index.js sanitizer.
function sanitizeContacts(raw, max) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return { error: "contacts must be an array" };
  const keys = ["name", "email", "phone", "title"];
  const out = [];
  for (const c of raw) {
    if (c == null || typeof c !== "object") continue;
    const row = {};
    for (const k of keys) {
      const val = c[k];
      if (val != null && String(val).trim() !== "") row[k] = String(val).trim();
    }
    if (Object.keys(row).length) out.push(row);
    if (out.length >= max) break;
  }
  return out;
}
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
      .from("fabric_mill_master")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Fabric mill not found" });
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
      .from("fabric_mill_master")
      .update(v.data)
      .eq("id", id)
      .select()
      .single();
    if (error) {
      if (error.code === "PGRST116") return res.status(404).json({ error: "Fabric mill not found" });
      return res.status(500).json({ error: error.message });
    }
    return res.status(200).json(data);
  }

  if (req.method === "DELETE") {
    const { data, error } = await admin
      .from("fabric_mill_master")
      .delete()
      .eq("id", id)
      .select("id")
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Fabric mill not found" });
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

  if ("country_code"  in out) out.country_code  = out.country_code  ? String(out.country_code).trim()  || null : null;
  if ("contact_name"  in out) out.contact_name  = out.contact_name  ? String(out.contact_name).trim()  || null : null;
  if ("contact_email" in out) out.contact_email = out.contact_email ? String(out.contact_email).trim() || null : null;
  if ("website"       in out) out.website       = out.website       ? String(out.website).trim()       || null : null;
  if ("notes"         in out) out.notes         = out.notes         ? String(out.notes).trim()         || null : null;

  if ("contacts" in out) {
    const c = sanitizeContacts(out.contacts, 5);
    if (c && c.error) return { error: c.error };
    out.contacts = c;
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
