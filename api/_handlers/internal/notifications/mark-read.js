// api/internal/notifications/:id/mark-read
//
// POST — flip an in_app dispatch to status='read'. Body: { user_id }.
//
// Tangerine P2 Chunk 4.

import { createClient } from "@supabase/supabase-js";
import { markRead, NotificationsError } from "../../../_lib/notifications/index.js";

export const config = { maxDuration: 15 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export default async function handler(req, res, params) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const id = params?.id;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }
  const user_id = body?.user_id;
  if (!user_id || !/^[0-9a-f-]{36}$/i.test(user_id)) {
    return res.status(400).json({ error: "user_id (uuid) is required" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  try {
    const out = await markRead(admin, { dispatch_id: id, user_id });
    return res.status(200).json(out);
  } catch (err) {
    if (err instanceof NotificationsError) {
      const status = err.code === "dispatch_not_found" ? 404 : 400;
      return res.status(status).json({ error: err.message, code: err.code });
    }
    return res.status(500).json({ error: err.message || String(err) });
  }
}
