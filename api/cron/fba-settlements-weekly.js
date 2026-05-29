// api/cron/fba-settlements-weekly
//
// Tangerine P12a-4 — Weekly Amazon FBA settlement reconciliation cron.
//
// Schedule (vercel.json): 06:00 UTC every Wednesday. Amazon FBA pays every
// 14 days; checking weekly catches new settlements quickly without
// overlapping a daily walk that returns nothing 6 days out of 7.
//
// For each active fba_seller_accounts row:
//   1. Decrypt LWA creds.
//   2. Refresh LWA access token.
//   3. listFinancialEventGroups({postedAfter: now - 60 days}) → walk
//      NextToken pages.
//   4. Upsert into fba_settlements (idempotent by
//      (fba_seller_account_id, financial_event_group_id)).
//   5. For Closed settlements with no je_id, post the bank ↔ clearing JE
//      via gl_post_journal_entry and stamp fba_settlements.je_id.
//   6. Best-effort match a bank_transactions row by (entity, net amount,
//      posted_date ±5 days). On match, stamp bank_transaction_id and flip
//      the bank row to status='matched'.
//   7. Update fba_seller_accounts.last_settlement_sync_at.
//
// Per-account try/catch — one failing account doesn't sink the rest.

import { createClient } from "@supabase/supabase-js";
import { syncFbaSettlements } from "../_lib/marketplaces/fba/sync-settlements.js";

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
  if (!process.env.FBA_TOKEN_ENC_KEY) {
    return res.status(200).json({
      ok: true,
      skipped: "FBA not configured (FBA_TOKEN_ENC_KEY missing)",
    });
  }
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  let onlyFbaSellerAccountId = null;
  let sinceOverride = null;
  let sinceDaysAgo = 60;
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    onlyFbaSellerAccountId = url.searchParams.get("fba_seller_account_id");
    sinceOverride = url.searchParams.get("since");
    const d = url.searchParams.get("since_days_ago");
    if (d != null && /^\d+$/.test(d)) sinceDaysAgo = Number(d);
  } catch { /* fallback */ }

  try {
    const out = await syncFbaSettlements({
      adminClient: admin,
      sinceDaysAgo,
      onlyFbaSellerAccountId,
      sinceOverride,
    });
    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
