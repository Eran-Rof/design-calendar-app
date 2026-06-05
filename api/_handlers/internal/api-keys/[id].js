// api/internal/api-keys/[id]
//
// GET    — fetch a single external_api_keys row (NEVER returns key_hash).
// PATCH  — revoke (set is_active=false) or re-activate. Body: { is_active }.
//          label is also editable. key_prefix / key_hash / entity_id are LOCKED.
// DELETE — revoke (soft): sets is_active=false. We do NOT hard-delete so the
//          audit trail (label, prefix, last_used_at) survives. The secret was
//          never stored, so a revoked key can never be used again.
//
// Tangerine M15 — External / Partner API key admin. Service-role; path param
// read from req.query.id per the dispatcher contract.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_COLS = "id, label, key_prefix, scopes, is_active, created_at, last_used_at";

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  // Dispatcher passes path params on req.query.
  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const { data, error } = await admin
      .from("external_api_keys")
      .select(SAFE_COLS)
      .eq("id", id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "API key not found" });
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
      .from("external_api_keys")
      .update(v.data)
      .eq("id", id)
      .select(SAFE_COLS)
      .single();
    if (error) {
      if (error.code === "PGRST116") return res.status(404).json({ error: "API key not found" });
      return res.status(500).json({ error: error.message });
    }
    return res.status(200).json(data);
  }

  if (req.method === "DELETE") {
    // Soft-revoke — keep the row for audit; secret was never stored anyway.
    const { data, error } = await admin
      .from("external_api_keys")
      .update({ is_active: false })
      .eq("id", id)
      .select("id")
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "API key not found" });
    return res.status(200).json({ revoked: true, id });
  }

  res.setHeader("Allow", "GET, PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

const MUTABLE_FIELDS = new Set(["label", "is_active"]);
const LOCKED_FIELDS = new Set(["id", "entity_id", "key_prefix", "key_hash", "scopes", "created_at"]);

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
  if ("label" in out) {
    if (out.label == null || String(out.label).trim() === "") {
      return { error: "label cannot be empty" };
    }
    out.label = String(out.label).trim();
  }
  if ("is_active" in out && typeof out.is_active !== "boolean") {
    out.is_active = out.is_active === "true" || out.is_active === 1;
  }
  return { data: out };
}
