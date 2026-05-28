// api/internal/commissions/settle
//
// POST. Body: { sales_rep_id, period_id, payment_method, paid_at, bank_account_id, actor_user_id? }
// Calls the commissions_settle_payout RPC.
//
// Tangerine P7-5.

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 15 };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PAYMENT_METHODS = ["check", "wire", "ach", "cash", "other"];

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

export function isISODate(s) {
  if (typeof s !== "string" || !ISO_DATE_RE.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return false;
  // Round-trip check rejects invalid days like 2026-02-30
  return d.toISOString().slice(0, 10) === s;
}

export function validateBody(body) {
  if (body == null || typeof body !== "object") return { error: "Body must be an object" };
  if (!body.sales_rep_id || !UUID_RE.test(String(body.sales_rep_id))) {
    return { error: "sales_rep_id (uuid) is required" };
  }
  if (!body.period_id || !UUID_RE.test(String(body.period_id))) {
    return { error: "period_id (uuid) is required" };
  }
  if (!body.payment_method || !PAYMENT_METHODS.includes(String(body.payment_method))) {
    return { error: `payment_method must be one of ${PAYMENT_METHODS.join(", ")}` };
  }
  if (!body.paid_at || !isISODate(String(body.paid_at))) {
    return { error: "paid_at must be ISO date YYYY-MM-DD" };
  }
  if (!body.bank_account_id || !UUID_RE.test(String(body.bank_account_id))) {
    return { error: "bank_account_id (uuid) is required" };
  }
  const out = {
    sales_rep_id:    String(body.sales_rep_id),
    period_id:       String(body.period_id),
    payment_method:  String(body.payment_method),
    paid_at:         String(body.paid_at),
    bank_account_id: String(body.bank_account_id),
    actor_user_id:   null,
  };
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

  const { data, error } = await admin.rpc("commissions_settle_payout", {
    p_sales_rep_id:    v.data.sales_rep_id,
    p_period_id:       v.data.period_id,
    p_payment_method:  v.data.payment_method,
    p_paid_at:         v.data.paid_at,
    p_bank_account_id: v.data.bank_account_id,
    p_actor_user_id:   v.data.actor_user_id,
  });
  if (error) {
    const msg = error.message || "RPC failed";
    if (/not found|payout already exists|no accrued rows|does not match|missing|entity mismatch|has no gl_account/.test(msg)) {
      return res.status(409).json({ error: msg });
    }
    return res.status(500).json({ error: msg });
  }
  return res.status(200).json(data);
}
