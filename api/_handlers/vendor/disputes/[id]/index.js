// api/vendor/disputes/:id
//
// GET — full dispute + all messages; marks vendor as having viewed
// (updates disputes.last_viewed_by_vendor_at).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

async function resolveVendor(admin, authHeader) {
  const jwt = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!jwt) return null;
  try {
    const { data, error } = await admin.auth.getUser(jwt);
    if (error || !data?.user) return null;
    const { data: vu } = await admin.from("vendor_users").select("id, vendor_id").eq("auth_id", data.user.id).maybeSingle();
    return vu ? { ...vu, auth_id: data.user.id } : null;
  } catch { return null; }
}

function getId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("disputes");
  return idx >= 0 ? parts[idx + 1] : null;
}

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

  const caller = await resolveVendor(admin, req.headers.authorization);
  if (!caller) return res.status(401).json({ error: "Authentication required" });

  const id = getId(req);
  if (!id) return res.status(400).json({ error: "Missing dispute id" });

  const { data: dispute, error } = await admin
    .from("disputes").select("*").eq("id", id).eq("vendor_id", caller.vendor_id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!dispute) return res.status(404).json({ error: "Dispute not found" });

  const { data: messages, error: mErr } = await admin
    .from("dispute_messages").select("*").eq("dispute_id", id).order("created_at", { ascending: true });
  if (mErr) return res.status(500).json({ error: mErr.message });

  // Mark as viewed by vendor
  await admin.from("disputes").update({ last_viewed_by_vendor_at: new Date().toISOString() }).eq("id", id);

  return res.status(200).json({ dispute, messages: messages || [] });
}
