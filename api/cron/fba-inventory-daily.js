// api/cron/fba-inventory-daily
//
// Tangerine P12a-5 — Daily FBA inventory mirror.
//
// Runs daily at 04:00 UTC (Vercel cron in vercel.json). For each active
// fba_seller_accounts row:
//   1. Decrypt LWA creds + refresh access_token.
//   2. SpApiClient.getInventorySummaries() walked paginated by nextToken.
//   3. Upsert fba_inventory_snapshots rows (snapshot_at = run started_at).
//   4. Drop + rebuild inventory_layers source_kind='fba_inbound' at the
//      account's fba_location_id (T10-4 drop-and-rebuild pattern).
//   5. Bump fba_seller_accounts.last_inventory_sync_at.
//
// Per-account error isolation — one bad account does NOT block others.
// Failure surfaces in `accounts[*].ok = false` plus an `error_count` tally.

import { createClient } from "@supabase/supabase-js";
import { mirrorFbaInventory } from "../_lib/marketplaces/fba/mirror-inventory.js";

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
    const out = await mirrorFbaInventory({ adminClient: admin });
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
