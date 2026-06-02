// api/cron/fba-returns-daily
//
// Tangerine P12a-6 — Daily FBA returns sync.
//
// Runs at 04:30 UTC (vercel.json cron). For each active fba_seller_accounts
// row:
//   1. Decrypt LWA creds → refresh access_token
//   2. SpApiClient.listReturnRequests(createdAfter = max(last_returns_sync_at,
//      now - 30 days))
//   3. Upsert fba_returns by return_request_id
//   4. Post restock JE (Resellable) or writeoff JE (Defective/Disposed)
//   5. If refund_amount_cents > 0 and parent fba_order has ar_invoice_id,
//      post the credit-memo JE + create the ar_invoices credit memo row.
//   6. Bump last_returns_sync_at on the account.
//
// Per-account error isolation — one account's failure does NOT prevent the
// rest from syncing. Failure surfaces in accounts[*].ok = false.

import { createClient } from "@supabase/supabase-js";
import { syncAllAccountsReturns } from "../_lib/marketplaces/fba/sync-returns.js";

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
    const out = await syncAllAccountsReturns(admin);
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
