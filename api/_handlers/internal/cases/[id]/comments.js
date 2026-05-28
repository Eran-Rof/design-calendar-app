// api/internal/cases/:id/comments
//
// GET  — list comments for a case (ASC by created_at).
// POST — append a new comment.
//          body: { body (required), is_internal? (default true),
//                  author_user_id?, external_email? }
//
// Tangerine P7-9 (arch §6).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/**
 * Extract case id from req.query.id (dispatcher path param) or fall back to
 * walking req.url path segments — mirrors the disputes/[id]/messages.js
 * pattern.
 */
function getCaseId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const tail = parts.lastIndexOf("comments");
  return tail > 0 ? parts[tail - 1] : null;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const caseId = getCaseId(req);
  if (!caseId || !UUID_RE.test(caseId)) {
    return res.status(400).json({ error: "Invalid case id" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  // Confirm the case exists (avoids inserting orphan comments under a bogus FK).
  const { data: caseRow, error: caseErr } = await admin
    .from("cases")
    .select("id, entity_id")
    .eq("id", caseId)
    .maybeSingle();
  if (caseErr) return res.status(500).json({ error: caseErr.message });
  if (!caseRow) return res.status(404).json({ error: "Case not found" });

  if (req.method === "GET") {
    const { data, error } = await admin
      .from("case_comments")
      .select("id, case_id, author_user_id, body, is_internal, external_email, created_at")
      .eq("case_id", caseId)
      .order("created_at", { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data || []);
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ error: "Invalid JSON" }); }
    }
    const v = validateCommentInsert(body || {});
    if (v.error) return res.status(400).json({ error: v.error });

    const row = {
      case_id: caseId,
      author_user_id: v.data.author_user_id,
      body: v.data.body,
      is_internal: v.data.is_internal,
      external_email: v.data.external_email,
    };
    const { data: inserted, error: insErr } = await admin
      .from("case_comments")
      .insert(row)
      .select()
      .single();
    if (insErr) return res.status(500).json({ error: insErr.message });

    // Touch the parent case so updated_at + last activity bump.
    await admin
      .from("cases")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", caseId);

    return res.status(201).json(inserted);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

// ────────────────────────────────────────────────────────────────────────
// Validation — exported for unit tests.
// ────────────────────────────────────────────────────────────────────────

export function validateCommentInsert(body) {
  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (!text) return { error: "body is required" };
  if (text.length > 10000) return { error: "body must be ≤ 10000 chars" };

  const is_internal = body.is_internal === undefined ? true : Boolean(body.is_internal);

  if (body.author_user_id && !UUID_RE.test(body.author_user_id)) {
    return { error: "author_user_id must be a uuid" };
  }

  return {
    data: {
      body: text,
      is_internal,
      author_user_id: body.author_user_id || null,
      external_email: body.external_email ? String(body.external_email).trim() : null,
    },
  };
}
