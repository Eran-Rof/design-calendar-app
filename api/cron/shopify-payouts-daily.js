// api/cron/shopify-payouts-daily
//
// Tangerine P11-9 — Daily Shopify Payments payout reconciliation cron.
//
// Schedule (vercel.json): 06:00 UTC daily — gives the night's orders time
// to settle and Shopify Payments to publish the previous day's payout.
//
// For each active shopify_stores row:
//   1. Decrypt access_token.
//   2. listPayouts({since: now - 30 days}).
//   3. Upsert into shopify_payouts (idempotent by
//      (shopify_store_id, shopify_payout_id)).
//   4. For new rows (no je_id) post the bank ↔ clearing JE via
//      gl_post_journal_entry and stamp shopify_payouts.je_id.
//   5. Update shopify_stores.updated_at as the cursor proxy.
//
// Per-store try/catch — one failing store doesn't sink the rest.

import { createClient } from "@supabase/supabase-js";
import { syncShopifyPayouts } from "../_lib/shopify/sync-payouts.js";

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
  if (!process.env.SHOPIFY_TOKEN_ENC_KEY) {
    return res.status(200).json({
      ok: true,
      skipped: "Shopify not configured (SHOPIFY_TOKEN_ENC_KEY missing)",
    });
  }
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  let onlyShopifyStoreId = null;
  let sinceOverride = null;
  let sinceDaysAgo = 30;
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    onlyShopifyStoreId = url.searchParams.get("shopify_store_id");
    sinceOverride = url.searchParams.get("since");
    const d = url.searchParams.get("since_days_ago");
    if (d != null && /^\d+$/.test(d)) sinceDaysAgo = Number(d);
  } catch { /* fallback */ }

  try {
    const out = await syncShopifyPayouts({
      adminClient: admin,
      sinceDaysAgo,
      onlyShopifyStoreId,
      sinceOverride,
    });
    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
