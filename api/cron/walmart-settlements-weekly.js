// api/cron/walmart-settlements-weekly
//
// Tangerine P12b-4 — Weekly Walmart Marketplace settlement reconciliation
// cron.
//
// Schedule (vercel.json): 06:30 UTC Wednesday — after the FBA payouts
// cron at 06:00 UTC (when P12a-4 lands). Walmart pays weekly, typically
// crediting the merchant's bank account on the same weekday across each
// pay period; we run Wednesday morning so the prior week's settlement
// has had at least a couple business days to land in the bank feed and
// be matchable.
//
// For each active walmart_seller_accounts row:
//   1. Decrypt client_id + client_secret.
//   2. getWalmartAccessToken (client_credentials grant).
//   3. listSettlementReports({requestedFromDate: now - 30 days}).
//   4. Upsert into walmart_settlements (idempotent by
//      (walmart_seller_account_id, settlement_id)).
//   5. For new rows (no je_id) post the bank ↔ clearing JE via
//      gl_post_journal_entry and stamp walmart_settlements.je_id.
//   6. Best-effort link to the matching bank_transactions row.
//   7. Update walmart_seller_accounts.last_settlement_sync_at.
//
// Per-account try/catch — one failing account doesn't sink the rest.

import { createClient } from "@supabase/supabase-js";
import { syncWalmartSettlements } from "../_lib/marketplaces/walmart/sync-settlements.js";

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
  if (!process.env.WALMART_TOKEN_ENC_KEY) {
    return res.status(200).json({
      ok: true,
      skipped: "Walmart not configured (WALMART_TOKEN_ENC_KEY missing)",
    });
  }
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  let onlyAccountId = null;
  let sinceOverride = null;
  let sinceDaysAgo = 30;
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    onlyAccountId = url.searchParams.get("walmart_seller_account_id");
    sinceOverride = url.searchParams.get("since");
    const d = url.searchParams.get("since_days_ago");
    if (d != null && /^\d+$/.test(d)) sinceDaysAgo = Number(d);
  } catch { /* fallback */ }

  try {
    const out = await syncWalmartSettlements({
      adminClient: admin,
      sinceDaysAgo,
      onlyAccountId,
      sinceOverride,
    });
    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
