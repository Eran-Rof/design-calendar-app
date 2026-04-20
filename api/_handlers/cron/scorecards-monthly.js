// api/cron/scorecards-monthly.js
//
// Monthly scorecard generation. Runs on the 1st of each month via
// vercel.json crons; computes scorecards for the previous calendar
// month across all active vendors.
//
// For each vendor:
//   - Calls compute_vendor_scorecard() SQL function (upserts a
//     vendor_scorecards row for the period).
//   - If on_time_delivery_pct < 80% OR invoice_accuracy_pct < 85%,
//     fires a vendor_flagged_scorecard notification to the internal team.
//
// Auth: CRON_SECRET Bearer header (Vercel cron attaches it
// automatically). If env var is unset, endpoint is open (for dry-runs).

import { createClient } from "@supabase/supabase-js";

export const config = { maxDuration: 300 };

const ON_TIME_THRESHOLD = 80;
const ACCURACY_THRESHOLD = 85;

function previousMonth() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)); // day 0 = last day of prev month
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const expectedSecret = process.env.CRON_SECRET;
  if (expectedSecret && req.headers.authorization !== `Bearer ${expectedSecret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // Allow override via query for back-fill runs
  const url = new URL(req.url, `https://${req.headers.host}`);
  const overrideStart = url.searchParams.get("period_start");
  const overrideEnd   = url.searchParams.get("period_end");
  const { start, end } = overrideStart && overrideEnd
    ? { start: overrideStart, end: overrideEnd }
    : previousMonth();

  const result = {
    started_at: new Date().toISOString(),
    period: { start, end },
    thresholds: { on_time_pct: ON_TIME_THRESHOLD, accuracy_pct: ACCURACY_THRESHOLD },
    vendors_processed: 0,
    vendors_skipped_no_data: 0,
    vendors_flagged: 0,
    notifications_sent: 0,
    errors: [],
    flagged: [],
  };

  const { data: vendors, error } = await admin
    .from("vendors")
    .select("id, name")
    .is("deleted_at", null);
  if (error) return res.status(500).json({ error: error.message });

  const origin = `https://${req.headers.host}`;

  for (const v of vendors || []) {
    try {
      const { data: scorecardId, error: rpcErr } = await admin.rpc("compute_vendor_scorecard", {
        p_vendor_id: v.id,
        p_period_start: start,
        p_period_end: end,
      });
      if (rpcErr) { result.errors.push({ vendor: v.name, error: rpcErr.message }); continue; }

      const { data: sc } = await admin
        .from("vendor_scorecards")
        .select("on_time_delivery_pct, invoice_accuracy_pct, po_count, composite_score")
        .eq("id", scorecardId)
        .maybeSingle();
      if (!sc || sc.po_count === 0) { result.vendors_skipped_no_data++; continue; }

      result.vendors_processed++;

      const underperforming =
        (sc.on_time_delivery_pct != null && Number(sc.on_time_delivery_pct) < ON_TIME_THRESHOLD) ||
        (sc.invoice_accuracy_pct != null && Number(sc.invoice_accuracy_pct) < ACCURACY_THRESHOLD);

      if (underperforming) {
        result.vendors_flagged++;
        result.flagged.push({
          vendor_id: v.id, vendor_name: v.name,
          on_time_delivery_pct: sc.on_time_delivery_pct,
          invoice_accuracy_pct: sc.invoice_accuracy_pct,
          composite_score: sc.composite_score,
        });

        try {
          const r = await fetch(`${origin}/api/send-notification`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              event_type: "vendor_flagged_scorecard",
              title: `${v.name} flagged for scorecard review`,
              body: `${start} → ${end}: on-time ${sc.on_time_delivery_pct ?? "—"}%, accuracy ${sc.invoice_accuracy_pct ?? "—"}%. Composite ${sc.composite_score ?? "—"}. Thresholds: on-time >= ${ON_TIME_THRESHOLD}%, accuracy >= ${ACCURACY_THRESHOLD}%.`,
              link: "/",
              metadata: { vendor_id: v.id, period_start: start, period_end: end },
              recipient: { internal_id: "scorecard_alerts" },
              dedupe_key: `scorecard_flagged_${v.id}_${start}`,
              email: false,
            }),
          });
          if (r.ok) result.notifications_sent++;
        } catch (err) {
          result.errors.push({ vendor: v.name, error: `notify failed: ${err?.message || err}` });
        }
      }
    } catch (err) {
      result.errors.push({ vendor: v.name, error: err?.message || String(err) });
    }
  }

  result.finished_at = new Date().toISOString();
  return res.status(200).json(result);
}
