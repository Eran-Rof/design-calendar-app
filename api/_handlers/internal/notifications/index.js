// api/internal/notifications
//
// GET — list THIS user's notifications (events the user has dispatches for).
//       Query:
//         ?user_id=<uuid>           required for now (session-aware later)
//         ?channel=in_app|email     default in_app
//         ?status=pending|sent|read|failed (default sent,read)
//         ?limit=N (default 50, max 200)
//
// Tangerine P2 Chunk 4.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
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
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const url = new URL(req.url, `https://${req.headers.host}`);
  const userId = (url.searchParams.get("user_id") || "").trim();
  if (!userId || !/^[0-9a-f-]{36}$/i.test(userId)) {
    return res.status(400).json({ error: "user_id (uuid) is required" });
  }
  const channel = (url.searchParams.get("channel") || "in_app").trim();
  if (!["in_app", "email"].includes(channel)) {
    return res.status(400).json({ error: "channel must be in_app or email" });
  }
  const statusFilter = (url.searchParams.get("status") || "").trim();
  const statuses = statusFilter
    ? statusFilter.split(",").map((s) => s.trim()).filter(Boolean)
    : ["sent", "read"];
  let limit = parseInt(url.searchParams.get("limit") || "50", 10);
  if (Number.isNaN(limit) || limit < 1) limit = 50;
  if (limit > 200) limit = 200;

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data, error } = await admin
    .from("notification_dispatches")
    .select("*, event:notification_events(*)")
    .eq("recipient_user_id", userId)
    .eq("channel", channel)
    .in("status", statuses)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json(data || []);
}
