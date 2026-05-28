// api/internal/gl-detail
//
// Tangerine P7-7 — GL Detail by Account × Period (drill from Trial Balance).
//
// GET — return ordered ACCRUAL journal_entry_lines for a single account in a
// date window, with running balance + JE drill ids, via RPC
// gl_detail(p_account_id, p_from, p_to).
//
// Query params:
//   account_id = UUID       (required)
//   from       = YYYY-MM-DD (required)
//   to         = YYYY-MM-DD (required)
//
// Response shape:
//   { account_id, from, to, rows: [{ posting_date, je_id, description,
//     debit_cents, credit_cents, running_balance_cents, source_module, source_id }] }

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 30 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export function isUuid(v) {
  return typeof v === "string" && UUID_RE.test(v);
}

export function isISODate(v) {
  if (typeof v !== "string" || !ISO_DATE_RE.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return Number.isFinite(d.getTime()) && d.toISOString().startsWith(v);
}

export function validateQuery(params) {
  const accountId = (params.get("account_id") || "").trim();
  const fromRaw = (params.get("from") || "").trim();
  const toRaw = (params.get("to") || "").trim();

  if (!accountId)         return { error: "account_id is required (UUID)" };
  if (!isUuid(accountId)) return { error: "account_id must be a UUID" };
  if (!fromRaw)           return { error: "from is required (YYYY-MM-DD)" };
  if (!toRaw)             return { error: "to is required (YYYY-MM-DD)" };
  if (!isISODate(fromRaw)) return { error: "from must be YYYY-MM-DD" };
  if (!isISODate(toRaw))   return { error: "to must be YYYY-MM-DD" };
  if (fromRaw > toRaw)     return { error: "from must be on or before to" };

  return { data: { account_id: accountId, from: fromRaw, to: toRaw } };
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const v = validateQuery(url.searchParams);
  if (v.error) return res.status(400).json({ error: v.error });

  try {
    const { data, error } = await admin.rpc("gl_detail", {
      p_account_id: v.data.account_id,
      p_from: v.data.from,
      p_to: v.data.to,
    });
    if (error) return res.status(500).json({ error: error.message });

    return res.status(200).json({
      account_id: v.data.account_id,
      from: v.data.from,
      to: v.data.to,
      rows: data || [],
    });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
