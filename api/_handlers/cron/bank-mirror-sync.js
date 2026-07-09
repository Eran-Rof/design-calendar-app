// api/_handlers/cron/bank-mirror-sync.js
//
// Nightly (05:30 UTC — before the 06:00 subledger tie-out so the tie-out
// sees fresh runs): keep the Xoro bank mirror current.
//
//   1. Upsert bank_transactions from the ap_payment_import register
//      (idempotent on payment_number; new register rows — e.g. after an
//      operator re-imports a fresher Payments export, or the AP nightly
//      flow stages new payments — flow straight through).
//   2. Re-run the auto-match (register JE linkage + amount/date window).
//      This is the pass that picks up AR-receipt JEs as that backfill
//      lands — matches only ever touch status='unmatched' rows.
//   3. Recompute bank_recon_runs for every mirror-managed month
//      (operator-owned source='manual' runs are never touched; months
//      Xoro reconciled — through RECONCILED_THROUGH — stay reconciled/
//      flagged, later months roll forward as in_progress).
//
// Xoro's REST API has no bank-transaction/payment endpoint under any
// private-app scope we hold (probed 2026-07-08 — see
// scripts/import-xoro-bank-history.mjs), so register staging is the feed
// until Plaid goes live (P6 Plaid plumbing is already wired:
// api/webhooks/plaid.js + api/cron/bank-feed-sync.js).
//
// Errors → captureError with source='cron' (app_errors CHECK constraint).

import { createClient } from "@supabase/supabase-js";
import { captureError } from "../../_lib/errorCapture.js";
import { runFullMirrorSync } from "../../_lib/bank-mirror/mirror.js";

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !KEY) return res.status(500).json({ error: "Supabase admin not configured" });
  const admin = createClient(SB_URL, KEY, { auth: { persistSession: false } });

  try {
    const out = await runFullMirrorSync(admin, {});
    return res.status(200).json({
      ok: true,
      accounts: out.accounts.length,
      txns_upserted: out.sync.upserted,
      zero_skipped: out.sync.skipped_zero,
      excluded: out.sync.excluded.length,
      matched_pass1: out.match.pass1,
      matched_pass2: out.match.pass2,
      unmatched: out.match.unmatched,
      recon: out.recon,
    });
  } catch (e) {
    await captureError({
      source: "cron",
      route: "/api/cron/bank-mirror-sync",
      message: e?.message || String(e),
      stack: e?.stack,
      context: { kind: "bank_mirror_sync" },
    });
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
