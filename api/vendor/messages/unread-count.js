// api/vendor/messages/unread-count.js
//
// GET — { count } of unread messages from the internal team across all
// POs belonging to the caller's vendor. Polled by the vendor UI every
// 60s alongside the notification bell.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 10 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const jwt = req.headers.authorization && req.headers.authorization.startsWith("Bearer ")
    ? req.headers.authorization.slice(7) : null;
  if (!jwt) return res.status(401).json({ error: "Authentication required" });
  const { data: userRes, error: authErr } = await admin.auth.getUser(jwt);
  if (authErr || !userRes?.user) return res.status(401).json({ error: "Invalid or expired token" });

  const { data: vu } = await admin.from("vendor_users").select("vendor_id").eq("auth_id", userRes.user.id).maybeSingle();
  if (!vu) return res.status(403).json({ error: "Not linked to a vendor" });

  // Get this vendor's PO uuids
  const { data: pos } = await admin.from("tanda_pos").select("uuid_id").eq("vendor_id", vu.vendor_id);
  const poIds = (pos || []).map((p) => p.uuid_id);
  if (poIds.length === 0) return res.status(200).json({ count: 0 });

  const { count, error } = await admin
    .from("po_messages")
    .select("*", { count: "exact", head: true })
    .in("po_id", poIds)
    .eq("sender_type", "internal")
    .eq("read_by_vendor", false);
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ count: count || 0 });
}
