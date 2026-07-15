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

export function shouldAlert(summary, exposureThresholdCents = ALERT_EXPOSURE_CENTS) {
  if (!summary) return false;
  const exposure = Number(summary.exposure_cents || 0);
  const phantom = Number(summary.skus_phantom || 0);
  const negative = Number(summary.negative_skus || 0);
  return exposure >= exposureThresholdCents || phantom > 0 || negative > 0;
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

    if (!shouldAlert(summary)) return res.status(200).json(out);

    const msg =
      `inventory-onhand: ${summary.skus_divergent} SKU(s) diverge from the Xoro REST truth ` +
      `(${Number(summary.sum_abs_units || 0).toLocaleString()} units |Δ|, ${fmtUsd(summary.exposure_cents)} at cost); ` +
      `phantom-suspect ${summary.skus_phantom}, negative on-hand ${summary.negative_skus}, ` +
      `zero-cost on-hand ${summary.zero_cost_skus} SKU(s). ` +
      `REST snapshot ${summary.rest_snapshot_date || "n/a"}. ` +
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
