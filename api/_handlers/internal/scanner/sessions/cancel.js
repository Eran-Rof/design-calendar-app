// api/internal/scanner/sessions/:id/cancel
//
// POST — Cancel an open scanner session. Sets status='cancelled'.
//        The session and all its events remain in the DB for troubleshooting
//        — we don't hard-delete because scanner_events references the
//        session via FK ON DELETE CASCADE and we want the history.
//
// Returns 409 if the session is already submitted/cancelled.
//
// Tangerine P3 Chunk 8 — M39 Mobile Scanner back-end.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
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
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // PR #345: req.query?.id
  const id = req.query?.id;
  if (!id || !isUuid(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: session, error: sErr } = await admin
    .from("scanner_sessions")
    .select("id, status")
    .eq("id", id)
    .maybeSingle();
  if (sErr) return res.status(500).json({ error: sErr.message });
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (session.status !== "open") {
    return res.status(409).json({ error: `Cannot cancel ${session.status} session` });
  }

  const { data, error } = await admin
    .from("scanner_sessions")
    .update({ status: "cancelled" })
    .eq("id", id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json(data);
}

export function isUuid(s) {
  return typeof s === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
