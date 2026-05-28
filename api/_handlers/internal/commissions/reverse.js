// api/internal/commissions/reverse
//
// POST. Body: { ar_invoice_id, reason, actor_user_id? }
// Calls the commissions_reverse_for_invoice RPC.
//
// Tangerine P7-5.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}
function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export function validateBody(body) {
  if (body == null || typeof body !== "object") return { error: "Body must be an object" };
  if (!body.ar_invoice_id || !UUID_RE.test(String(body.ar_invoice_id))) {
    return { error: "ar_invoice_id (uuid) is required" };
  }
  if (body.reason == null) return { error: "reason is required" };
  const reason = String(body.reason).trim();
  if (reason.length === 0) return { error: "reason must be non-empty" };
  if (reason.length > 500) return { error: "reason must be <= 500 chars" };
  const out = { ar_invoice_id: String(body.ar_invoice_id), reason, actor_user_id: null };
  if (body.actor_user_id != null && body.actor_user_id !== "") {
    if (!UUID_RE.test(String(body.actor_user_id))) return { error: "actor_user_id must be UUID" };
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

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }
  const v = validateBody(body || {});
  if (v.error) return res.status(400).json({ error: v.error });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data, error } = await admin.rpc("commissions_reverse_for_invoice", {
    p_ar_invoice_id: v.data.ar_invoice_id,
    p_reason:        v.data.reason,
    p_actor_user_id: v.data.actor_user_id,
  });
  if (error) {
    const msg = error.message || "RPC failed";
    if (/not found|reason is required|entity mismatch|missing/.test(msg)) {
      return res.status(409).json({ error: msg });
    }
    return res.status(500).json({ error: msg });
  }
  return res.status(200).json(data);
}
