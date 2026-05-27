// api/internal/approval-requests/:id/cancel
//
// POST — cancel a pending request. Owner or admin only. Body: { actor_user_id }
//
// Tangerine P2 Chunk 2.

import { createClient } from "@supabase/supabase-js";
import { cancel as cancelLib, ApprovalsError } from "../../../_lib/approvals/index.js";

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
  const actor_user_id = body?.actor_user_id;
  if (!actor_user_id || !/^[0-9a-f-]{36}$/i.test(String(actor_user_id))) {
    return res.status(400).json({ error: "actor_user_id (uuid) is required" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  try {
    const out = await cancelLib(admin, { request_id: id }, { actor_user_id });
    return res.status(200).json(out);
  } catch (err) {
    if (err instanceof ApprovalsError) {
      const status = err.code === "request_not_found" ? 404
        : err.code === "request_not_pending" ? 409
        : err.code === "not_authorized" ? 403
        : 400;
      return res.status(status).json({ error: err.message, code: err.code });
    }
    return res.status(500).json({ error: err.message || String(err) });
  }
}
