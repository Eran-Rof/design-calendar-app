// api/internal/crm/opportunities/:id/stage
//
// POST. Body: { stage, reason?, actor_user_id? }
// Calls the crm_opp_change_stage RPC which atomically:
//   - locks the opp row
//   - validates the new stage is in the enum + differs from current
//   - UPDATEs the opp (triggers in P8-1 touch stage_changed_at + log
//     stage_change activity)
//   - returns { opp_id, old_stage, new_stage, activity_id, reason }
//
// Maps RAISE EXCEPTION → 409 via the standard regex pattern.
//
// Tangerine P8-2 (arch §4).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAGE_VALUES = ["new", "qualified", "proposal", "won", "lost"];

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

/**
 * Resolve opp id from req.query.id (dispatcher path param) or fall back to
 * walking req.url path segments — mirrors the cases/[id]/comments.js pattern.
 */
function getOppId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const tail = parts.lastIndexOf("stage");
  return tail > 0 ? parts[tail - 1] : null;
}

export function validateBody(body) {
  if (body == null || typeof body !== "object") return { error: "Body must be an object" };
  const stage = body.stage ? String(body.stage).trim() : "";
  if (!stage) return { error: "stage is required" };
  if (!STAGE_VALUES.includes(stage)) {
    return { error: `stage must be one of ${STAGE_VALUES.join(", ")}` };
  }
  const out = { stage, reason: null, actor_user_id: null };
  if (body.reason != null && body.reason !== "") {
    const r = String(body.reason).trim();
    if (r.length > 2000) return { error: "reason must be ≤ 2000 chars" };
    out.reason = r;
  }
  if (body.actor_user_id != null && body.actor_user_id !== "") {
    if (!UUID_RE.test(String(body.actor_user_id))) {
      return { error: "actor_user_id must be a uuid" };
    }
    out.actor_user_id = String(body.actor_user_id);
  }
  return { data: out };
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const oppId = getOppId(req);
  if (!oppId || !UUID_RE.test(oppId)) {
    return res.status(400).json({ error: "Invalid opportunity id" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }
  const v = validateBody(body || {});
  if (v.error) return res.status(400).json({ error: v.error });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data, error } = await admin.rpc("crm_opp_change_stage", {
    p_opp_id:        oppId,
    p_new_stage:     v.data.stage,
    p_reason:        v.data.reason,
    p_actor_user_id: v.data.actor_user_id,
  });
  if (error) {
    const msg = error.message || "RPC failed";
    if (/opportunity not found|already in stage|must be one of|opp_id is required/i.test(msg)) {
      return res.status(409).json({ error: msg });
    }
    return res.status(500).json({ error: msg });
  }
  return res.status(200).json(data);
}
