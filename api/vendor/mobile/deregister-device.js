// api/vendor/mobile/deregister-device
//
// POST or DELETE — remove a device registration. Call on logout.
//   body: { device_token? }   (if omitted, all devices for the caller
//                              are deregistered — e.g. "sign out
//                              everywhere")

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
  res.setHeader("Access-Control-Allow-Methods", "POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST" && req.method !== "DELETE") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const caller = await resolveVendorUser(admin, req.headers.authorization);
  if (!caller) return res.status(401).json({ error: "Authentication required" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const deviceToken = body?.device_token;

  let q = admin.from("mobile_sessions").delete().eq("vendor_user_id", caller.id);
  if (deviceToken) q = q.eq("device_token", deviceToken);
  const { error, count } = await q;
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ ok: true, removed: count ?? null, scope: deviceToken ? "device" : "all" });
}
