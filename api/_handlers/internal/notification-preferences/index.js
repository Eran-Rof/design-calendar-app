// api/internal/notification-preferences
//
// GET — list this user's preferences. Query: ?user_id=<uuid>
// PUT — upsert one (user_id, kind, channel) preference row.
//       Body: { user_id, kind, channel, enabled }
//
// Tangerine P2 Chunk 4.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const userId = (url.searchParams.get("user_id") || "").trim();
    if (!userId || !/^[0-9a-f-]{36}$/i.test(userId)) {
      return res.status(400).json({ error: "user_id (uuid) is required" });
    }
    const { data, error } = await admin
      .from("notification_preferences")
      .select("*")
      .eq("user_id", userId)
      .order("kind", { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data || []);
  }

  if (req.method === "PUT") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    const v = validateUpsert(body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    const { data, error } = await admin
      .from("notification_preferences")
      .upsert(v.data, { onConflict: "user_id,kind,channel" })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  res.setHeader("Allow", "GET, PUT");
  return res.status(405).json({ error: "Method not allowed" });
}

export function validateUpsert(body) {
  if (!body.user_id || !/^[0-9a-f-]{36}$/i.test(body.user_id)) {
    return { error: "user_id (uuid) is required" };
  }
  if (!body.kind || !String(body.kind).trim()) {
    return { error: "kind is required" };
  }
  if (!["in_app", "email"].includes(body.channel)) {
    return { error: "channel must be in_app or email" };
  }
  if (typeof body.enabled !== "boolean") {
    return { error: "enabled must be a boolean" };
  }
  return {
    data: {
      user_id: body.user_id,
      kind: String(body.kind).trim(),
      channel: body.channel,
      enabled: body.enabled,
    },
  };
}
