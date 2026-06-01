// api/internal/factors/[id]
//
// GET    — fetch a single factor_master row.
// PATCH  — update mutable fields. `code`, `entity_id`, `id` are LOCKED
//          post-creation. Mutable: name, contact_name, phone, email,
//          website, address, api_enabled, notes, is_active.
// DELETE — hard-delete.
//
// Chunk I — Factor / Insurance Master. Entity-scoped (ROF).

import { createClient } from "@supabase/supabase-js";
import { normalizeContactFields } from "./index.js";

export const config = { maxDuration: 15 };

const MUTABLE_FIELDS = new Set([
  "name", "contact_name", "phone", "email", "website",
  "address", "api_enabled", "notes", "is_active",
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
  if (!id) return res.status(400).json({ error: "Invalid id" });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const { data, error } = await admin
      .from("factor_master")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Factor not found" });
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
      .from("factor_master")
      .update(v.data)
      .eq("id", id)
      .select()
      .single();
    if (error) {
      if (error.code === "PGRST116") return res.status(404).json({ error: "Factor not found" });
      return res.status(500).json({ error: error.message });
    }
    return res.status(200).json(data);
  }

  if (req.method === "DELETE") {
    const { data, error } = await admin
      .from("factor_master")
      .delete()
      .eq("id", id)
      .select("id")
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Factor not found" });
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

  if ("name" in body) {
    if (body.name == null || String(body.name).trim() === "") {
      return { error: "name cannot be empty" };
    }
    out.name = String(body.name).trim();
  }

  if ("email" in body && body.email != null && String(body.email).trim() !== "") {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(body.email).trim())) {
      return { error: "email is not a valid address" };
    }
  }

  // Coerce the optional contact / address / api_enabled fields.
  const contactBody = {};
  for (const f of Object.keys(body)) {
    if (MUTABLE_FIELDS.has(f) && f !== "name" && f !== "is_active") contactBody[f] = body[f];
  }
  const r = normalizeContactFields(contactBody, out);
  if (r && r.error) return { error: r.error };

  if ("is_active" in body) {
    out.is_active = typeof body.is_active === "boolean"
      ? body.is_active
      : body.is_active === "true" || body.is_active === 1;
  }

  return { data: out };
}
