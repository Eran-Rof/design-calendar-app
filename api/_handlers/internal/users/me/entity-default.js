// api/internal/users/me/entity-default
//
// Tangerine P10-2b — Entity-switcher API: mark which entity_users row the
// caller wants flagged is_default=true. The partial unique index
// entity_users_one_default_per_user (P10-1) guarantees at most one default
// per auth_id, so we explicitly clear the prior default first, then set
// the new one.
//
// PUT /api/internal/users/me/entity-default
//   body: { entity_id: <uuid> }
//
//   • 401 — no Bearer token
//   • 400 — missing entity_id / unparseable body
//   • 403 — caller has no entity_users row for entity_id
//   • 200 — the updated entity_users row { entity_id, role, is_default: true }
//
// Implementation: two sequential UPDATEs scoped to the caller's auth_id.
// We do NOT wrap them in a Postgres transaction (the supabase-js client
// can't begin one client-side); the partial unique index makes the order
// matter — clear-then-set is safe because in-between either zero or the
// pre-existing default row is flagged true. A racing concurrent call from
// the same user could trip the partial unique index, but that's the
// correct behavior (last-write-wins for a single auth principal).

import { createClient } from "@supabase/supabase-js";
import { authenticateCaller } from "../../../../_lib/auth.js";

export const config = { maxDuration: 10 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

/**
 * Pure validator for the default-set body. Exported for unit tests.
 *
 * @param {unknown} body
 * @returns {{data?: {entity_id: string}, error?: string}}
 */
export function validateDefaultBody(body) {
  if (!body || typeof body !== "object") {
    return { error: "Body must be a JSON object" };
  }
  const { entity_id } = body;
  if (typeof entity_id !== "string" || entity_id.length === 0) {
    return { error: "entity_id is required" };
  }
  if (!UUID_RE.test(entity_id)) {
    return { error: "entity_id must be a uuid" };
  }
  return { data: { entity_id } };
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "PUT") {
    res.setHeader("Allow", "PUT");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const auth = await authenticateCaller(req, admin);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }
  const v = validateDefaultBody(body || {});
  if (v.error) return res.status(400).json({ error: v.error });

  // Membership check first — 403 if the caller isn't actually a member.
  const { data: member, error: memberErr } = await admin
    .from("entity_users")
    .select("entity_id")
    .eq("auth_id", auth.authId)
    .eq("entity_id", v.data.entity_id)
    .maybeSingle();
  if (memberErr) return res.status(500).json({ error: memberErr.message });
  if (!member) {
    return res.status(403).json({ error: "Caller is not a member of the requested entity" });
  }

  // 1) Clear every existing default for this user. Safe to re-run.
  const clear = await admin
    .from("entity_users")
    .update({ is_default: false })
    .eq("auth_id", auth.authId)
    .eq("is_default", true);
  if (clear.error) return res.status(500).json({ error: clear.error.message });

  // 2) Flag the requested entity as the new default. Returns the row.
  const { data: updated, error: setErr } = await admin
    .from("entity_users")
    .update({ is_default: true })
    .eq("auth_id", auth.authId)
    .eq("entity_id", v.data.entity_id)
    .select("entity_id, role, is_default")
    .single();
  if (setErr) return res.status(500).json({ error: setErr.message });

  return res.status(200).json(updated);
}
