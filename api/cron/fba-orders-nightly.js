// api/cron/fba-orders-nightly
//
// Tangerine P12a-2 — Nightly FBA orders ingest.
//
// Runs daily at 03:00 UTC (Vercel cron in vercel.json). For each active
// fba_seller_accounts row:
//   1. Decrypt LWA creds
//   2. Refresh LWA access_token
//   3. SpApiClient.listOrders(lastUpdatedAfter = max(last_orders_sync_at, now - 14d))
//   4. Upsert fba_orders + fba_order_items
//   5. Bump fba_seller_accounts.last_orders_sync_at
//
// Per-account error isolation — one account's bad refresh token does NOT
// prevent the rest from syncing. Failure is reported in the response
// `accounts[*].ok = false` shape.
//
// AR-invoice JE posting (1115 Marketplace Receivable Clearing → revenue)
// is intentionally NOT done here. That ships in P12a-3.

import { createClient } from "@supabase/supabase-js";
import { ingestAllAccounts } from "../_lib/marketplaces/fba/ingest-orders.js";

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
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  try {
    const out = await ingestAllAccounts(admin);
    const okCount = out.accounts.filter((a) => a.ok).length;
    const errCount = out.accounts.length - okCount;
    return res.status(200).json({
      ok: true,
      ...out,
      ok_count: okCount,
      error_count: errCount,
    });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
