// api/cron/walmart-returns-daily
//
// Tangerine P12b-5 — Walmart returns sync cron.
//
// Runs daily at 05:00 UTC (≈ 00:00 EST / 01:00 EDT) — after the FBA
// returns cron (later) and after the Walmart orders ingest cron at
// 03:30 UTC so the parent walmart_orders rows are in place before we
// try to back-link return → order.
//
// For each active walmart_seller_accounts row:
//   1. Decrypt client_id + client_secret.
//   2. getWalmartAccessToken (client_credentials grant).
//   3. Build WalmartClient.
//   4. listReturns last 30 days.
//   5. For each return: upsert walmart_returns by return_order_id, then
//      post AR credit memo + (when SKU resolves) inventory restock JE.
//   6. Stamp walmart_returns.je_id + ar_credit_memo_id.
//
// Per-account try/catch — one failing account NEVER breaks the others.
// Per-return try/catch — one failing return is captured in
// account.return_errors without aborting the rest.
//
// Manual re-run:
//   POST /api/internal/walmart/sync-returns
//   body: { walmart_seller_account_id, since? }
//
// Tangerine P12b-5.

import { createClient } from "@supabase/supabase-js";
import { runWalmartReturnsSync } from "../_lib/marketplaces/walmart/sync-returns.js";

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: "Server not configured" });
  }
  const admin = createClient(SB_URL, SERVICE_KEY, {
    auth: { persistSession: false },
  });
  try {
    const out = await runWalmartReturnsSync(admin);
    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    return res
      .status(500)
      .json({ error: e instanceof Error ? e.message : String(e) });
  }
}
