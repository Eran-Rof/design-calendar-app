// api/internal/three-way-match/resolve
//
// 3-Way Match module — POST { match_id, resolution, reason } to accept a
// variance, dispute a bill, or re-open a resolved exception.
//
// T11: a non-empty reason is REQUIRED for accept/dispute; the
// resolve_ap_bill_match RPC sets the audit context (set_audit_context) so the
// row_changes trigger records actor + reason in the same transaction. Actor
// resolves from the X-Auth-User-Id header the frontend interceptor injects.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../_lib/auth.js";

export const config = { maxDuration: 15 };

const RESOLUTIONS = ["accepted", "disputed", "open"];

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token, X-Entity-ID, X-Auth-User-Id");
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const auth = authenticateInternalCaller(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, KEY, { auth: { persistSession: false } });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }
  const matchId = (body?.match_id || "").toString().trim();
  const resolution = (body?.resolution || "").toString().trim();
  const reason = (body?.reason || "").toString().trim();
  if (!matchId) return res.status(400).json({ error: "match_id required" });
  if (!RESOLUTIONS.includes(resolution)) {
    return res.status(400).json({ error: `resolution must be one of ${RESOLUTIONS.join(", ")}` });
  }
  if (resolution !== "open" && !reason) {
    return res.status(400).json({ error: "A reason is required to accept or dispute (T11)." });
  }

  const actor = (req.headers?.["x-auth-user-id"] || "").toString().trim() || "internal";
  const { data, error } = await admin.rpc("resolve_ap_bill_match", {
    p_match_id: matchId,
    p_resolution: resolution,
    p_reason: reason || null,
    p_actor_name: actor,
  });
  if (error) {
    const msg = error.message || String(error);
    const status = /not found/i.test(msg) ? 404 : /reason|resolution must/i.test(msg) ? 400 : 500;
    return res.status(status).json({ error: msg });
  }
  return res.status(200).json(data);
}
