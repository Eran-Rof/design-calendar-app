// api/internal/fba/sync-settlements
//
// Tangerine P12a-4 — Manual trigger for the FBA settlement reconciliation
// service. The weekly cron at /api/cron/fba-settlements-weekly runs at
// 06:00 UTC every Wednesday; this handler lets the operator pull
// settlements on demand from the FBA admin panel.
//
// POST /api/internal/fba/sync-settlements
//   body: {
//     fba_seller_account_id?: <uuid>,
//     since_days_ago?: <int>,
//     since?: <ISO timestamp>
//   }
//
// Returns the syncFbaSettlements summary verbatim.

import { createClient } from "@supabase/supabase-js";
import { syncFbaSettlements } from "../../../_lib/marketplaces/fba/sync-settlements.js";

export const config = { maxDuration: 300 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID");
}

/**
 * Parse + validate the body. Exported for unit tests.
 */
export function validateBody(body) {
  if (body == null) {
    return { data: { onlyFbaSellerAccountId: null, sinceDaysAgo: null, sinceOverride: null } };
  }
  if (typeof body !== "object") return { error: "Request body must be an object" };
  const out = { onlyFbaSellerAccountId: null, sinceDaysAgo: null, sinceOverride: null };
  if (body.fba_seller_account_id != null && body.fba_seller_account_id !== "") {
    if (typeof body.fba_seller_account_id !== "string" || !UUID_RE.test(body.fba_seller_account_id)) {
      return { error: "fba_seller_account_id must be a uuid" };
    }
    out.onlyFbaSellerAccountId = body.fba_seller_account_id;
  }
  if (body.since_days_ago != null && body.since_days_ago !== "") {
    const n = Number(body.since_days_ago);
    if (!Number.isInteger(n) || n <= 0 || n > 730) {
      return { error: "since_days_ago must be a positive integer ≤ 730" };
    }
    out.sinceDaysAgo = n;
  }
  if (body.since != null && body.since !== "") {
    if (typeof body.since !== "string" || !ISO_RE.test(body.since)) {
      return { error: "since must be ISO 8601 timestamp" };
    }
    out.sinceOverride = body.since;
  }
  return { data: out };
}

function clientOrNull() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
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

  const admin = clientOrNull();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  try {
    const args = { adminClient: admin };
    if (v.data.onlyFbaSellerAccountId) args.onlyFbaSellerAccountId = v.data.onlyFbaSellerAccountId;
    if (v.data.sinceDaysAgo)            args.sinceDaysAgo = v.data.sinceDaysAgo;
    if (v.data.sinceOverride)           args.sinceOverride = v.data.sinceOverride;
    const out = await syncFbaSettlements(args);
    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
