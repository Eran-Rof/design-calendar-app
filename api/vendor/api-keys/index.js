// api/vendor/api-keys
//
// GET  — list all non-revoked keys for the caller's vendor.
//        admin-only (role='primary' or 'admin'). Never returns key_hash.
//
// POST — create a new API key.
//        body: { name, scopes[], expires_at? }
//        Returns { id, name, key, key_prefix, scopes, expires_at, created_at }
//        where `key` is the RAW value — shown exactly once and never
//        retrievable again.

import { createClient } from "@supabase/supabase-js";
import { authenticateVendor, requireAdmin } from "../../_lib/vendor-auth.js";
import { generateApiKey, VALID_SCOPES } from "../../_lib/api-key.js";

export const config = { maxDuration: 15 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");
  if (req.method === "OPTIONS") return res.status(200).end();

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const authResult = await authenticateVendor(admin, req);
  if (!authResult.ok) return res.status(authResult.status).json({ error: authResult.error });
  const { auth } = authResult;
  if (!requireAdmin(auth)) return res.status(403).json({ error: "Admin role required" });

  if (req.method === "GET") {
    const { data, error } = await admin
      .from("vendor_api_keys")
      .select("id, name, key_prefix, scopes, created_at, last_used_at, expires_at, revoked_at, created_by")
      .eq("vendor_id", auth.vendor_id)
      .is("revoked_at", null)
      .order("created_at", { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data || []);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
    const { name, scopes, expires_at } = body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: "name is required" });
    if (!Array.isArray(scopes) || scopes.length === 0) return res.status(400).json({ error: "scopes must be a non-empty array" });
    const invalid = scopes.filter((s) => !VALID_SCOPES.includes(s));
    if (invalid.length) return res.status(400).json({ error: `Invalid scopes: ${invalid.join(", ")}. Allowed: ${VALID_SCOPES.join(", ")}` });
    if (expires_at && isNaN(Date.parse(expires_at))) return res.status(400).json({ error: "expires_at must be an ISO timestamp" });

    const { raw, keyPrefix, keyHash } = generateApiKey();
    const { data: row, error } = await admin.from("vendor_api_keys").insert({
      vendor_id: auth.vendor_id,
      name: String(name).trim(),
      scopes,
      key_prefix: keyPrefix,
      key_hash: keyHash,
      expires_at: expires_at || null,
      created_by: auth.vendor_user_id,
    }).select("id, name, key_prefix, scopes, created_at, expires_at").single();
    if (error) return res.status(500).json({ error: error.message });

    return res.status(201).json({ ...row, key: raw });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
