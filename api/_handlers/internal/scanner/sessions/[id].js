// api/internal/scanner/sessions/:id
//
// GET — fetch one session with its embedded events log (ordered by
//       server_received_at ascending — the order they actually arrived).
//
// Tangerine P3 Chunk 8 — M39 Mobile Scanner back-end.

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

  // Dispatcher merges path params into req.query (see api/dispatch.js).
  // PR #345: read req.query?.id, NOT req.params (we don't have Express).
  const id = req.query?.id;
  if (!id || !isUuid(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const { data: session, error } = await admin
      .from("scanner_sessions")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!session) return res.status(404).json({ error: "Session not found" });

    const { data: events, error: evErr } = await admin
      .from("scanner_events")
      .select("*")
      .eq("session_id", id)
      .order("server_received_at", { ascending: true });
    if (evErr) return res.status(500).json({ error: evErr.message });

    return res.status(200).json({ ...session, events: events || [] });
  }

  res.setHeader("Allow", "GET");
  return res.status(405).json({ error: "Method not allowed" });
}

export function isUuid(s) {
  return typeof s === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
