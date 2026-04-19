// api/vendor/api-keys/:id/logs
//
// GET — last 200 request log entries for a specific API key.
// admin-only (role='primary' or 'admin').
// Fields: endpoint, method, status_code, created_at, ip_address, duration_ms, error_message.

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
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

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

  // Verify the key belongs to this vendor before returning logs
  const { data: keyRow } = await admin
    .from("vendor_api_keys").select("id, vendor_id").eq("id", id).maybeSingle();
  if (!keyRow || keyRow.vendor_id !== auth.vendor_id) return res.status(404).json({ error: "Not found" });

  const { data, error } = await admin
    .from("vendor_api_logs")
    .select("id, endpoint, method, status_code, ip_address, duration_ms, error_message, created_at")
    .eq("api_key_id", id)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json(data || []);
}
