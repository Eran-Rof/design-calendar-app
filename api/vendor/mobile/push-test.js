// api/vendor/mobile/push-test
//
// POST — enqueue a test push for every device registered to the
// caller. The actual delivery happens in the push delivery cron;
// response returns the number of queue entries written.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 10 };

async function resolveVendorUser(admin, authHeader) {
  const jwt = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!jwt) return null;
  try {
    const { data, error } = await admin.auth.getUser(jwt);
    if (error || !data?.user) return null;
    const { data: vu } = await admin.from("vendor_users").select("id, vendor_id, display_name").eq("auth_id", data.user.id).maybeSingle();
    return vu ? { ...vu, auth_id: data.user.id, email: data.user.email } : null;
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

  const { data: sessions } = await admin
    .from("mobile_sessions")
    .select("id, platform, device_token")
    .eq("vendor_user_id", caller.id);
  if (!sessions || sessions.length === 0) return res.status(200).json({ ok: true, queued: 0, note: "No registered devices" });

  const rows = sessions.map((s) => ({
    vendor_user_id: caller.id,
    mobile_session_id: s.id,
    title: "Test notification",
    body: `Hi ${caller.display_name || "there"} — your vendor portal push notifications are working on ${s.platform}.`,
    data: { type: "push_test", entity_id: null, deep_link: "vendor://home" },
    status: "queued",
  }));
  const { error } = await admin.from("push_notifications").insert(rows);
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ ok: true, queued: rows.length });
}
