// api/vendor/mobile/register-device
//
// POST — upsert a MobileSession for the caller's vendor_user.
//   body: { device_token, platform: 'ios' | 'android', app_version? }
// Unique on device_token — re-registering the same token updates the
// last_active_at (and re-attaches to the current vendor_user if a
// different one registered the same token).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 10 };

async function resolveVendorUser(admin, authHeader) {
  const jwt = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!jwt) return null;
  try {
    const { data, error } = await admin.auth.getUser(jwt);
    if (error || !data?.user) return null;
    const { data: vu } = await admin.from("vendor_users").select("id, vendor_id").eq("auth_id", data.user.id).maybeSingle();
    return vu ? { ...vu, auth_id: data.user.id } : null;
  } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const caller = await resolveVendorUser(admin, req.headers.authorization);
  if (!caller) return res.status(401).json({ error: "Authentication required" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  const { device_token, platform, app_version } = body || {};
  if (!device_token || !String(device_token).trim()) return res.status(400).json({ error: "device_token is required" });
  if (!["ios", "android"].includes(platform)) return res.status(400).json({ error: "platform must be ios or android" });

  const { data, error } = await admin.from("mobile_sessions").upsert({
    vendor_user_id: caller.id,
    device_token: String(device_token).trim(),
    platform,
    app_version: app_version || null,
    last_active_at: new Date().toISOString(),
  }, { onConflict: "device_token" }).select("id, device_token, platform, app_version, last_active_at").single();
  if (error) return res.status(500).json({ error: error.message });

  return res.status(201).json(data);
}
