// api/internal/api-keys
//
// Admin panel backend for the External / Partner API keys (M15).
//
// GET  — list external_api_keys for the default entity. NEVER returns key_hash
//        or any secret. By default returns all rows (active + revoked) so the
//        admin can see the full history; ?active_only=true filters to active.
//        Fields: id, label, key_prefix, scopes, is_active, created_at,
//        last_used_at.
// POST — create one key. Body: { label (required), scopes? (default ['read']) }.
//        Generates a "prefix.secret" key, stores ONLY key_prefix + sha-256
//        hash, and returns the FULL plaintext key EXACTLY ONCE in the response
//        (field: api_key). It is never retrievable again.
//
// Read-only external API → scopes are constrained to ['read'] in this build.
// Service-role writes (RLS anon-permissive in DB), ROF-entity scoped — mirrors
// the other Tangerine master handlers.

import { createClient } from "@supabase/supabase-js";
import { generateApiKey } from "../../../_lib/external/apiKeyAuth.js";

export const config = { maxDuration: 15 };

// Read-only API: only the 'read' scope is grantable today.
const ALLOWED_SCOPES = new Set(["read"]);

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

async function resolveDefaultEntityId(admin) {
  const { data, error } = await admin
    .from("entities")
    .select("id")
    .eq("code", "ROF")
    .maybeSingle();
  if (error || !data) return null;
  return data.id;
}

// Columns safe to expose — explicitly EXCLUDES key_hash.
const SAFE_COLS = "id, label, key_prefix, scopes, is_active, created_at, last_used_at";

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const entityId = await resolveDefaultEntityId(admin);
  if (!entityId) return res.status(500).json({ error: "Default entity (ROF) not found" });

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const activeOnly = url.searchParams.get("active_only") === "true";

    let query = admin
      .from("external_api_keys")
      .select(SAFE_COLS)
      .eq("entity_id", entityId)
      .order("created_at", { ascending: false });
    if (activeOnly) query = query.eq("is_active", true);

    const { data, error } = await query;
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

    // Mint the key — only prefix + hash are persisted.
    const { raw, keyPrefix, keyHash } = generateApiKey();

    const { data, error } = await admin
      .from("external_api_keys")
      .insert({
        entity_id: entityId,
        label: v.data.label,
        key_prefix: keyPrefix,
        key_hash: keyHash,
        scopes: v.data.scopes,
        is_active: true,
      })
      .select(SAFE_COLS)
      .single();
    if (error) {
      if (error.code === "23505") {
        return res.status(409).json({ error: "Key prefix collision; please retry" });
      }
      return res.status(500).json({ error: error.message });
    }

    // The plaintext key is returned EXACTLY ONCE here and never persisted.
    return res.status(201).json({ ...data, api_key: raw });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

export function validateCreate(body) {
  if (body == null || typeof body !== "object") {
    return { error: "Request body must be an object" };
  }
  if (!body.label || !String(body.label).trim()) {
    return { error: "label is required" };
  }
  let scopes = ["read"];
  if (body.scopes != null) {
    if (!Array.isArray(body.scopes)) return { error: "scopes must be an array" };
    scopes = body.scopes.map((s) => String(s).trim()).filter(Boolean);
    if (scopes.length === 0) scopes = ["read"];
    for (const s of scopes) {
      if (!ALLOWED_SCOPES.has(s)) {
        return { error: `unsupported scope "${s}" — this API is read-only (allowed: read)` };
      }
    }
  }
  return { data: { label: String(body.label).trim(), scopes } };
}
