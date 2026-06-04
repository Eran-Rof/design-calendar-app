// api/cron/xoro-ap-sync.js
//
// Tangerine — nightly Xoro AP (vendor bill paid-status) sync.
//
// Automates the previously manual "Xoro AP sync" (api/_handlers/xoro-ap-sync.js):
// pulls bills from Xoro and updates our invoices table's paid/status/paid_at
// so vendor invoice payment status stays current without an operator clicking
// the button.
//
// Schedule (vercel.json): "30 2 * * *" — 02:30 UTC, i.e. an hour after the
// 01:30 UTC xoro-mirror-nightly so the mirrored data is settled first.
//
// Lookback: by default re-scans the last 30 days (date_from = today−30d UTC,
// date_to = now). The sync is idempotent — re-syncing the same bill only
// re-fires vendor notifications on a real transition — so the wide window is
// safe and catches late-posted or back-dated payments. Both can be overridden
// via ?date_from / ?date_to / ?po_number for ad-hoc replay.
//
// Auth:
//   - x-vercel-cron header set by Vercel for scheduled triggers.
//   - Authorization: Bearer <CRON_SECRET> for manual replay.
//   - If CRON_SECRET is unset (dev/staging), allow through (soft-open,
//     matching the other Tangerine crons).

import { runXoroApSync } from "../_lib/xoro-ap-sync.js";

export const config = { maxDuration: 300 };

const DEFAULT_LOOKBACK_DAYS = 30;

function isAuthorized(req) {
  if (req.headers && req.headers["x-vercel-cron"]) return true;
  const expected = process.env.CRON_SECRET;
  if (!expected) return true; // soft-open in dev
  const header = req.headers?.authorization || "";
  return typeof header === "string" && header === `Bearer ${expected}`;
}

// YYYY-MM-DD in UTC for a Date.
function ymdUTC(d) {
  return d.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-vercel-cron");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Rolling lookback window, overridable via query.
  const now = new Date();
  const from = new Date(now.getTime() - DEFAULT_LOOKBACK_DAYS * 86_400_000);
  let dateFrom = ymdUTC(from);
  let dateTo = ymdUTC(now);
  let poNumber = "";
  try {
    const url = new URL(req.url || "/", `https://${req.headers?.host || "localhost"}`);
    const qFrom = url.searchParams.get("date_from");
    const qTo = url.searchParams.get("date_to");
    const qPo = url.searchParams.get("po_number");
    if (qFrom) dateFrom = qFrom;
    if (qTo) dateTo = qTo;
    if (qPo) poNumber = qPo;
  } catch { /* fall back to defaults */ }

  const origin = `https://${req.headers?.host || ""}`;

  try {
    const result = await runXoroApSync({
      date_from: dateFrom,
      date_to: dateTo,
      po_number: poNumber,
      origin,
    });
    const status = result?.error === "Server not configured" ? 500 : 200;
    return res.status(status).json({
      started_at: now.toISOString(),
      finished_at: new Date().toISOString(),
      window: { date_from: dateFrom, date_to: dateTo, po_number: poNumber || null },
      ...result,
    });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
