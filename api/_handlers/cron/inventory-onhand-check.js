// api/_handlers/cron/inventory-onhand-check.js
//
// Daily (07:30 UTC): the Inventory On-Hand Accuracy monitor. READ-ONLY over
// inventory data — it MEASURES the divergence between the LIVE on-hand
// (inventory_layers) and the authoritative Xoro REST by-size feed
// (tangerine_size_onhand), and records the summary. It NEVER "fixes" stock,
// re-enables a sync, or mutates a layer; the actual fix needs the Xoro cutover
// (see memory HANDOVER_2026_07_02_inventory_onhand).
//
// Each run:
//   1. calls inventory_onhand_accuracy_snapshot_write() — a cheap SQL
//      aggregate that both returns the summary and appends today's row to the
//      diagnostic trend table inventory_onhand_accuracy_snapshot (one row/day,
//      upserted), so the Inventory Accuracy panel can chart whether things are
//      improving or worsening.
//   2. if divergence crosses a threshold (material $ exposure at cost, any
//      phantom-suspect, or any negative on-hand), writes ONE breadcrumb to
//      app_errors (source='cron') so the daily app-errors digest surfaces it.
//      Silent otherwise. This is an alert, NOT a remediation.
//      EXCEPTION: while the REST baseline (tangerine_size_onhand) is stale — its
//      by-size ingest is paused until the Xoro cutover, so the snapshot freezes
//      while live layers keep moving — the $-exposure / phantom email is
//      suppressed (it would fire every business day against a frozen photo).
//      Negative on-hand still breaks through. The trend row is written either
//      way, so the Inventory Accuracy panel keeps charting the divergence.
//
// app_errors.source is CHECK-constrained to ('api','client','cron'); the
// 'inventory-onhand' token rides route/message/context for digest fingerprinting.

import { createClient } from "@supabase/supabase-js";
import { captureError } from "../../_lib/errorCapture.js";
import { fetchFeedFreshness } from "../../_lib/dataFreshness.js";

export const config = { maxDuration: 60 };

// Alert when the $ exposure at cost crosses this (cents). Default $50k. Also
// always alerts on any phantom-suspect or negative on-hand regardless of $.
const ALERT_EXPOSURE_CENTS = Number(process.env.INV_ONHAND_ALERT_EXPOSURE_CENTS || 5000000);

// The REST by-size truth (tangerine_size_onhand) is only refreshed by the
// by-size ingest, which stays paused until the Xoro cutover. Once its snapshot
// is older than this many days, the $-exposure and phantom-suspect signals are
// just the LIVE layers measured against a frozen photo — they grow mechanically
// as real trading moves the layers while the reference stands still, so the
// recurring divergence email is noise, not an actionable regression. When the
// baseline is stale we suppress that email (the daily trend row is still
// recorded for the Inventory Accuracy panel) but STILL alert on negative
// on-hand, which is a real data bug independent of REST freshness.
const BASELINE_STALE_DAYS = Number(process.env.INV_ONHAND_BASELINE_STALE_DAYS || 2);

// Days between the REST snapshot date and the summary's server-side generated_at
// (falls back to the local clock only if generated_at is absent). Returns false
// — never "stale" — when there is no baseline at all, so a missing feed still
// surfaces through the normal path.
export function isBaselineStale(summary, maxAgeDays = BASELINE_STALE_DAYS) {
  const snap = summary?.rest_snapshot_date;
  if (!snap) return false;
  const snapMs = Date.parse(`${snap}T00:00:00Z`);
  const refMs = summary?.generated_at ? Date.parse(summary.generated_at) : Date.now();
  if (Number.isNaN(snapMs) || Number.isNaN(refMs)) return false;
  return (refMs - snapMs) / 86400000 > maxAgeDays;
}

export function shouldAlert(summary, exposureThresholdCents = ALERT_EXPOSURE_CENTS, opts = {}) {
  if (!summary) return false;
  // Negative on-hand is a real data bug regardless of REST freshness — always alert.
  if (Number(summary.negative_skus || 0) > 0) return true;
  // Stale baseline → the divergence signal isn't actionable; suppress the email.
  const stale = opts.baselineStale ?? isBaselineStale(summary);
  if (stale) return false;
  const exposure = Number(summary.exposure_cents || 0);
  const phantom = Number(summary.skus_phantom || 0);
  return exposure >= exposureThresholdCents || phantom > 0;
}

function fmtUsd(cents) {
  const n = Number(cents || 0) / 100;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !KEY) return res.status(500).json({ error: "Supabase admin not configured" });
  const admin = createClient(SB_URL, KEY, { auth: { persistSession: false } });

  const out = { ok: true, alerted: false, freshness_alerted: false };
  try {
    // Data-freshness gate: alert (once) if ANY key feed's newest row is older
    // than its threshold — a feed can freeze silently (e.g. a reader still
    // pointing at an orphaned table) while the mirror status stays green.
    try {
      const fresh = await fetchFeedFreshness(admin);
      out.freshness = fresh;
      if (fresh.any_stale) {
        const stale = fresh.feeds.filter((f) => f.stale);
        await captureError({
          source: "cron",
          route: "/api/cron/inventory-onhand-check",
          message: `data-freshness: ${stale.length} feed(s) STALE — ` +
            stale.map((f) => `${f.label} (${f.latest ?? "no rows"}${f.age_hours != null ? `, ${f.age_hours}h` : ""} > ${f.max_age_hours}h)`).join("; "),
          context: { kind: "data-freshness", stale: stale.map((f) => f.key), freshness: fresh },
        });
        out.freshness_alerted = true;
      }
    } catch (fe) {
      // Non-fatal — freshness is a supplementary gate; don't sink the accuracy run.
      out.freshness_error = fe?.message || String(fe);
    }

    // Compute the summary AND persist today's trend row in one cheap call.
    const { data, error } = await admin.rpc("inventory_onhand_accuracy_snapshot_write");
    if (error) throw new Error(`accuracy summary rpc failed: ${error.message}`);
    const summary = data || {};
    out.summary = summary;

    // Suppress the recurring $-divergence email while the REST baseline is
    // frozen (by-size ingest paused until the Xoro cutover) — the trend row is
    // already persisted above, so the Inventory Accuracy panel keeps charting it.
    // Negative on-hand still breaks through (shouldAlert handles that).
    const baselineStale = isBaselineStale(summary);
    out.baseline_stale = baselineStale;
    if (!shouldAlert(summary, ALERT_EXPOSURE_CENTS, { baselineStale })) {
      if (baselineStale) out.suppressed_reason = "baseline_stale";
      return res.status(200).json(out);
    }

    const msg =
      `inventory-onhand: ${summary.skus_divergent} SKU(s) diverge from the Xoro REST truth ` +
      `(${Number(summary.sum_abs_units || 0).toLocaleString()} units |Δ|, ${fmtUsd(summary.exposure_cents)} at cost); ` +
      `phantom-suspect ${summary.skus_phantom}, negative on-hand ${summary.negative_skus}, ` +
      `zero-cost on-hand ${summary.zero_cost_skus} SKU(s). ` +
      `REST snapshot ${summary.rest_snapshot_date || "n/a"}${baselineStale ? " (STALE baseline)" : ""}. ` +
      `Root cause needs the Xoro cutover — this is a measurement, not a fix. ` +
      `Drill: Tangerine → Inventory → Inventory Accuracy.`;

    await captureError({
      source: "cron",
      route: "/api/cron/inventory-onhand-check",
      message: msg,
      context: { kind: "inventory-onhand", summary },
    });
    out.alerted = true;
    return res.status(200).json(out);
  } catch (e) {
    await captureError({
      source: "cron",
      route: "/api/cron/inventory-onhand-check",
      message: e?.message || String(e),
      stack: e?.stack,
      context: { kind: "inventory-onhand" },
    });
    return res.status(500).json({ ...out, ok: false, error: e?.message || String(e) });
  }
}
