// api/vendor/api-keys/:id
//
// DELETE — soft-delete (revoke) an API key owned by the caller's vendor.
// admin-only (role='primary' or 'admin').

import { createClient } from "@supabase/supabase-js";
import { authenticateVendor, requireAdmin } from "../../../_lib/vendor-auth.js";

export const config = { maxDuration: 10 };

function getId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("api-keys");
  return idx >= 0 ? parts[idx + 1] : null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "DELETE") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const authResult = await authenticateVendor(admin, req);
  if (!authResult.ok) return res.status(authResult.status).json({ error: authResult.error });
  const { auth } = authResult;
  if (!requireAdmin(auth)) return res.status(403).json({ error: "Admin role required" });

  const id = getId(req);
  if (!id) return res.status(400).json({ error: "Missing key id" });

  const { data: existing } = await admin
    .from("vendor_api_keys").select("id, vendor_id, revoked_at").eq("id", id).maybeSingle();
  if (!existing || existing.vendor_id !== auth.vendor_id) return res.status(404).json({ error: "Not found" });
  if (existing.revoked_at) return res.status(200).json({ ok: true, already_revoked: true });

  const { error } = await admin
    .from("vendor_api_keys")
    .update({ revoked_at: new Date().toISOString(), revoked_by: auth.vendor_user_id })
    .eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true });
}
