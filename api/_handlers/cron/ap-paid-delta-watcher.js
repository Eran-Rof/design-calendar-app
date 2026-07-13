// api/_handlers/cron/ap-paid-delta-watcher.js
//
// Nightly (06:30 UTC — after the 06:00 subledger tie-out, so tonight's
// tie-out report reflects yesterday's watcher postings and tomorrow's
// reflects tonight's): AP AmountPaid delta-watcher.
//
// Register-comparison mode (see api/_lib/ap-paid-watcher.js for why the
// live Xoro bill feed can't drive this): compares the latest imported
// Bills-register + Payments staging against posted GL state, posts payment
// and relief increments exactly the way the #1668 backfill did (same
// accounts, same journal_types, SOURCE dates), and alerts on anomalies.
// Idempotent — a re-run posts nothing new.
//
// Manual trigger after importing a fresh register/payments export:
//   curl -X POST https://apps.ringoffire.com/api/cron/ap-paid-delta-watcher \
//        -H "Authorization: Bearer $CRON_SECRET"
//   (?dry_run=1 for a no-write preview.)
//
// Anomalies → ONE bell+email notification (roles admin + accounting, same
// pattern as subledger-tieout) AND a captureError row so the daily
// app-errors digest carries them; app_errors.source must be 'cron' (DB
// CHECK) with context.kind='ap_paid_watcher'.

import { createClient } from "@supabase/supabase-js";
import { enqueue as enqueueNotification } from "../../_lib/notifications/index.js";
import { captureError } from "../../_lib/errorCapture.js";
import { runApPaidWatcher } from "../../_lib/ap-paid-watcher.js";

export const config = { maxDuration: 300 };

function isAuthorized(req) {
  if (req.headers && req.headers["x-vercel-cron"]) return true;
  const expected = process.env.CRON_SECRET;
  if (!expected) return true; // soft-open in dev, matching the other crons
  const header = req.headers?.authorization || "";
  return typeof header === "string" && header === `Bearer ${expected}`;
}

const usd = (cents) => `$${((cents || 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function anomalyLine(a) {
  switch (a.type) {
    case "paid_decreased":
      return `• ${a.bill_number} (${a.vendor_name}): Amount Paid DECREASED — register ${usd(a.register_cents)} vs reconciled ${usd(a.baseline_cents)}`;
    case "total_changed":
      return `• ${a.bill_number} (${a.vendor_name}): register bill total changed — now ${usd(a.register_cents)} vs reconciled ${usd(a.processed_cents)} (run post-bills-register \`deltas\`)`;
    case "header_drift_repaired":
      return `• ${a.bill_number} (${a.vendor_name}): frozen invoice header was rewritten to ${usd(a.was_cents)} by another process — AUTO-REPAIRED back to the register total ${usd(a.register_cents)} (no JE; the GL was never wrong). Find and stop the writer.`;
    case "relief_decreased":
      return `• ${a.bill_number} (${a.vendor_name}): discounts/credits/prepayments went DOWN (Δ5005 ${usd(a.d5005_cents)}, Δ1308 ${usd(a.d1308_cents)})`;
    case "new_bill":
      return `• ${a.bill_number} (${a.vendor_name}): ${a.reason}`;
    case "payment_unresolved":
      return `• payment ${a.payment_number} (${a.vendor_name}): ${usd(a.cents)} cash held — no vendor/GL account resolved`;
    case "vendor_cash_drift":
      return `• ${a.vendor_name}: register Amount Paid exceeds posted payment cash + residuals by ${usd(a.drift_cents)} (Payments export missing/incomplete?)`;
    default:
      return `• ${JSON.stringify(a)}`;
  }
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!isAuthorized(req)) return res.status(401).json({ error: "Unauthorized" });
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !KEY) return res.status(500).json({ error: "Supabase admin not configured" });
  const admin = createClient(SB_URL, KEY, { auth: { persistSession: false } });

  let dryRun = false;
  try {
    const url = new URL(req.url || "/", `https://${req.headers?.host || "localhost"}`);
    dryRun = ["1", "true"].includes(String(url.searchParams.get("dry_run") || ""));
  } catch { /* default */ }

  try {
    const out = await runApPaidWatcher(admin, { dryRun });

    if (!dryRun && (out.anomalies.length || out.errors.length)) {
      const lines = out.anomalies.slice(0, 30).map(anomalyLine);
      const body =
        `${out.anomalies.length} anomaly(ies) found by the AP AmountPaid delta watcher (register-comparison mode):\n\n` +
        lines.join("\n") +
        (out.anomalies.length > 30 ? `\n… and ${out.anomalies.length - 30} more.` : "") +
        (out.errors.length ? `\n\n${out.errors.length} posting error(s) — see app_errors / run details.` : "") +
        `\n\nThis run: ${out.payments_posted} payment JE(s) ${usd(out.payments_posted_cents)}, ${out.relief_posted} relief JE(s) ${usd(out.relief_posted_cents)}, ` +
        `${out.paid_delta_bills} bill(s) with Amount Paid up ${usd(out.paid_delta_cents)}` +
        (out.headers_repaired ? `, ${out.headers_repaired} corrupted invoice header(s) auto-repaired to register totals` : "") +
        (out.paid_delta_pending ? `, ${out.paid_delta_pending} paid delta(s) ${usd(out.paid_delta_pending_cents)} HELD until the vendor's cash drift clears` : "") +
        `.` +
        `\n\nApart from header repairs (subledger metadata only), anomalies are never auto-posted. Runbook: docs/tangerine/user-guide/13-accounts-payable.md (paid-delta watcher section).`;
      try {
        await enqueueNotification(admin, {
          entity_id: out.entity_id,
          kind: "ap_paid_watcher_anomaly",
          severity: "error",
          subject: `AP paid-delta watcher: ${out.anomalies.length} anomaly(ies)${out.errors.length ? ` + ${out.errors.length} error(s)` : ""}`,
          body,
          context_table: "ap_bill_register_import",
          context_id: null,
          payload: { anomalies: out.anomalies.slice(0, 50), errors: out.errors.slice(0, 50) },
          recipient_roles: ["admin", "accounting"],
        });
      } catch (e) {
        out.errors.push({ error: `notification enqueue failed: ${String(e?.message || e)}` });
      }
      await captureError({
        source: "cron",
        route: "/api/cron/ap-paid-delta-watcher",
        message: `ap_paid_watcher: ${out.anomalies.length} anomaly(ies) — ${out.anomalies.slice(0, 5).map((a) => `${a.type}:${a.bill_number || a.payment_number || a.vendor_name}`).join(", ")}${out.anomalies.length > 5 ? ", …" : ""}`,
        context: { kind: "ap_paid_watcher", anomalies: out.anomalies.slice(0, 50), errors: out.errors.slice(0, 50) },
      });
    }

    return res.status(200).json({ ok: true, ...out, anomaly_count: out.anomalies.length });
  } catch (e) {
    await captureError({
      source: "cron",
      route: "/api/cron/ap-paid-delta-watcher",
      message: e?.message || String(e),
      stack: e?.stack,
      context: { kind: "ap_paid_watcher" },
    });
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
