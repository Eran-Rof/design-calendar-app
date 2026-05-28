// api/internal/bank-transactions/:id/create-je
//
// POST. Body: { target_gl_account_id, actor_user_id?, memo? }
// Calls bank_create_je_for_transaction RPC.
//
// Tangerine P6-5.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };
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
  if (!body.target_gl_account_id || !UUID_RE.test(String(body.target_gl_account_id))) {
    return { error: "target_gl_account_id (uuid) is required" };
  }
  const out = {
    target_gl_account_id: String(body.target_gl_account_id),
    actor_user_id: null,
    memo: null,
  };
  if (body.actor_user_id != null && body.actor_user_id !== "") {
    if (!UUID_RE.test(String(body.actor_user_id))) return { error: "actor_user_id must be UUID" };
    out.actor_user_id = String(body.actor_user_id);
  }
  if (body.memo != null) {
    const m = String(body.memo).trim();
    if (m.length > 500) return { error: "memo must be <= 500 chars" };
    if (m.length > 0) out.memo = m;
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
  const id = req.query?.id;
  if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: "Invalid id" });
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }
  const v = validateBody(body || {});
  if (v.error) return res.status(400).json({ error: v.error });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });
  const { data, error } = await admin.rpc("bank_create_je_for_transaction", {
    p_bank_transaction_id: id,
    p_target_gl_account_id: v.data.target_gl_account_id,
    p_actor_user_id: v.data.actor_user_id,
    p_memo: v.data.memo,
  });
  if (error) {
    const msg = error.message || "RPC failed";
    if (/must be unmatched|pending|not found|zero-amount/.test(msg)) {
      return res.status(409).json({ error: msg });
    }
    return res.status(500).json({ error: msg });
  }
  return res.status(200).json(data);
}
