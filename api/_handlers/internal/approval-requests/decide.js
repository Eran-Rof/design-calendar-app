// api/internal/approval-requests/:id/decide
//
// POST — record approve / reject / request_changes on a step. Body:
//        { step_id, decision: 'approve'|'reject'|'request_changes', notes?, actor_user_id }
//
// Auto-finalizes the request when the last open step closes (approved) or
// the first reject lands (rejected).
//
// Tangerine P2 Chunk 2.

import { createClient } from "@supabase/supabase-js";
import { decide as decideLib, ApprovalsError } from "../../../_lib/approvals/index.js";

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

export default async function handler(req, res, params) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const id = params?.id;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
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

  try {
    const out = await decideLib(admin,
      { request_id: id, step_id: v.data.step_id, decision: v.data.decision, notes: v.data.notes },
      { actor_user_id: v.data.actor_user_id });
    return res.status(200).json(out);
  } catch (err) {
    if (err instanceof ApprovalsError) {
      const status = mapApprovalsErrorStatus(err.code);
      return res.status(status).json({ error: err.message, code: err.code });
    }
    return res.status(500).json({ error: err.message || String(err) });
  }
}

export function validateBody(body) {
  if (!body.step_id || !/^[0-9a-f-]{36}$/i.test(String(body.step_id))) {
    return { error: "step_id (uuid) is required" };
  }
  if (!["approve", "reject", "request_changes"].includes(body.decision)) {
    return { error: "decision must be approve|reject|request_changes" };
  }
  if (!body.actor_user_id || !/^[0-9a-f-]{36}$/i.test(String(body.actor_user_id))) {
    return { error: "actor_user_id (uuid) is required" };
  }
  return {
    data: {
      step_id: body.step_id,
      decision: body.decision,
      notes: body.notes ? String(body.notes).trim() : null,
      actor_user_id: body.actor_user_id,
    },
  };
}

function mapApprovalsErrorStatus(code) {
  switch (code) {
    case "request_not_found":
    case "step_not_found":
      return 404;
    case "request_not_pending":
    case "step_already_fulfilled":
    case "prior_steps_open":
    case "actor_role_mismatch":
      return 409;
    case "invalid_decision":
    case "missing_request_id":
    case "missing_step_id":
    case "missing_actor":
      return 400;
    default:
      return 500;
  }
}
