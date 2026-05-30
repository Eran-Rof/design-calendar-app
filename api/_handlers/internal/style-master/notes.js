// api/internal/style-master/notes
//
// Append-only operator notes log for a single style_master row.
//
// GET  /api/internal/style-master/notes?style_id=<uuid>
//      → returns notes newest-first.
// POST /api/internal/style-master/notes
//      Body: { style_id, note_text, created_by?, created_by_email? }
//      → inserts a row and returns it.
//
// created_by is the auth.users.id of the operator; created_by_email is a
// snapshot of their email so the UI can display it without joining auth.users
// (which the anon Supabase key cannot read). The client passes these from
// localStorage (`tangerine.auth_user_id`) + the MS Graph email captured at
// sign-in; if either is missing we still accept the note but tag it
// "(unknown)" in the UI.
//
// Style Master Sweep 2026-05-30 — operator ask #6.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f-]{36}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  if (req.method === "GET") {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const styleId = (url.searchParams.get("style_id") || "").trim();
    if (!UUID_RE.test(styleId)) {
      return res.status(400).json({ error: "style_id query param is required (uuid)" });
    }
    const { data, error } = await admin
      .from("style_notes")
      .select("id, style_id, note_text, created_by, created_by_email, created_at")
      .eq("style_id", styleId)
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data || []);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    body = body || {};

    const styleId = String(body.style_id || "").trim();
    if (!UUID_RE.test(styleId)) {
      return res.status(400).json({ error: "style_id is required (uuid)" });
    }
    const noteText = String(body.note_text || "").trim();
    if (!noteText) {
      return res.status(400).json({ error: "note_text is required" });
    }
    if (noteText.length > 4000) {
      return res.status(422).json({ error: "note_text must be ≤4000 chars" });
    }

    let createdBy = null;
    if (body.created_by != null && String(body.created_by).trim() !== "") {
      const raw = String(body.created_by).trim();
      if (!UUID_RE.test(raw)) {
        return res.status(400).json({ error: "created_by must be a uuid" });
      }
      createdBy = raw;
    }
    let createdByEmail = null;
    if (body.created_by_email != null && String(body.created_by_email).trim() !== "") {
      const raw = String(body.created_by_email).trim();
      if (raw.length > 320) {
        return res.status(422).json({ error: "created_by_email must be ≤320 chars" });
      }
      createdByEmail = raw;
    }

    // Ensure the style exists (and bubble up a clean 404 if not).
    const { data: parent, error: parentErr } = await admin
      .from("style_master")
      .select("id")
      .eq("id", styleId)
      .maybeSingle();
    if (parentErr) return res.status(500).json({ error: parentErr.message });
    if (!parent) return res.status(404).json({ error: "Style not found" });

    const { data, error } = await admin
      .from("style_notes")
      .insert({
        style_id: styleId,
        note_text: noteText,
        created_by: createdBy,
        created_by_email: createdByEmail,
      })
      .select("id, style_id, note_text, created_by, created_by_email, created_at")
      .single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json(data);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
