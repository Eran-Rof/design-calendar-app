// api/internal/walmart/sync-settlements
//
// Tangerine P12b-4 — Manual trigger for the Walmart settlement
// reconciliation. The weekly cron at /api/cron/walmart-settlements-weekly
// runs at 06:30 UTC on Wednesdays; this handler lets the operator pull
// settlements on demand from the Tangerine Walmart Status admin panel.
//
// POST /api/internal/walmart/sync-settlements
//   body: {
//     walmart_seller_account_id?: <uuid>,    // restrict to a single seller
//     since_days_ago?: <number>,             // override the 30-day default lookback
//     since?: <ISO timestamp>,               // override sinceDaysAgo entirely
//   }
//
// Returns the syncWalmartSettlements summary verbatim.

import { createClient } from "@supabase/supabase-js";
import { syncWalmartSettlements } from "../../../_lib/marketplaces/walmart/sync-settlements.js";

export const config = { maxDuration: 300 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

/**
 * Parse + validate the body. Exported for unit tests.
 */
export function validateBody(body) {
  if (body == null) return { data: { onlyAccountId: null, sinceDaysAgo: 30, sinceOverride: null } };
  if (typeof body !== "object") return { error: "Body must be a JSON object" };
  const out = { onlyAccountId: null, sinceDaysAgo: 30, sinceOverride: null };
  if (body.walmart_seller_account_id != null) {
    if (typeof body.walmart_seller_account_id !== "string" || !UUID_RE.test(body.walmart_seller_account_id)) {
      return { error: "walmart_seller_account_id must be a uuid" };
    }
    out.onlyAccountId = body.walmart_seller_account_id;
  }
  if (body.since_days_ago != null) {
    const n = Number(body.since_days_ago);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0 || n > 365) {
      return { error: "since_days_ago must be a positive integer ≤ 365" };
    }
    out.sinceDaysAgo = n;
  }
  if (body.since != null) {
    if (typeof body.since !== "string" || body.since.length === 0) {
      return { error: "since must be an ISO timestamp string" };
    }
    out.sinceOverride = body.since;
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

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: "Server not configured" });
  }
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { return res.status(400).json({ error: "Invalid JSON" }); }
  }
  const v = validateBody(body || {});
  if (v.error) return res.status(400).json({ error: v.error });

  try {
    const out = await syncWalmartSettlements({
      adminClient: admin,
      sinceDaysAgo: v.data.sinceDaysAgo,
      onlyAccountId: v.data.onlyAccountId,
      sinceOverride: v.data.sinceOverride,
    });
    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
