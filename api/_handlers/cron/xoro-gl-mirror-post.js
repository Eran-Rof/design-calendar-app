// api/_handlers/cron/xoro-gl-mirror-post.js
//
// Nightly (08:30 UTC, Mon-Fri): the Xoro GL mirror incremental poster.
//
// Posts every staged xoro_gl_transactions txn NOT already mirrored for the
// CURRENT OPEN MONTH, one balanced xoro_gl_mirror JE per Xoro TxnId, through the
// T11-audited posting engine (gl_post_journal_entry, audit_source='cron'). All
// the posting + hard-guard logic lives in ONE reviewed place — the SQL function
// xoro_gl_mirror_post_open_month() (migration 20269000000000). This handler is a
// thin, idempotent driver: call the RPC, surface the outcome, and — when a hard
// guard ABORTS the run (period_not_open / stale_feed / unmapped_or_unbalanced /
// missing_8001) or a bounded-chunk BACKLOG remains — write ONE app_errors
// 'cron' breadcrumb so the daily app-errors digest surfaces it (same pattern as
// inventory-onhand-check). A clean run (posted / noop) is silent.
//
// WHY A CRON, WHY 08:30 UTC Mon-Fri
//   The GL staging feed lands nightly via rof_xoro_project/scripts/rest_gl_sync.py
//   -> POST /api/xoro/sync-gl. The Xoro-facing crons finish early
//   (ar-payload-ingest 01:00, xoro-mirror-nightly 01:30, xoro-ap-sync 02:30 UTC);
//   08:30 leaves a wide margin so staging is fresh before we post. Weekdays only
//   (1-5) — matches the Xoro fetch cadence; the stale_feed guard covers a missed
//   day. maxDuration 60s == the service_role SQL budget; the SQL function posts a
//   bounded chunk (p_max_txns) and reports any remainder for the next run.
//
// Idempotent: the SQL function's candidate set excludes already-mirrored TxnIds,
// so re-invoking (or a manual ?month=YYYY-MM backfill) never double-posts.
//
// Query params (optional): ?month=YYYY-MM (target a specific OPEN month),
//   ?max_txns=N (chunk size), ?stale_hours=N (feed-freshness threshold).

import { createClient } from "@supabase/supabase-js";
import { captureError } from "../../_lib/errorCapture.js";

export const config = { maxDuration: 60 };

const MONTH_RE = /^\d{4}-\d{2}$/;
const DEFAULT_MAX_TXNS = 600;
const DEFAULT_STALE_HOURS = 30;

// Decide whether this run warrants an app_errors breadcrumb, and craft its
// message. Pure — unit-tested without any IO.
//   - a guard ABORT (status 'aborted') always alerts (the GL is not advancing).
//   - a successful post that leaves a BACKLOG (remaining > 0) alerts so a growing
//     unmirrored pile is visible even though this chunk succeeded.
//   - posted-clean / noop are silent (return { alert:false }).
export function decideAlert(summary) {
  if (!summary || typeof summary !== "object") {
    return { alert: true, message: "xoro-gl-mirror-post: RPC returned no summary object" };
  }
  const month = summary.month || "(unknown month)";
  if (summary.status === "aborted") {
    const g = summary.guard || {};
    const bits = [`reason=${g.reason || "unknown"}`];
    if (g.detail !== undefined) bits.push(`detail=${typeof g.detail === "object" ? JSON.stringify(g.detail) : g.detail}`);
    if (g.bad_txn_count) bits.push(`bad_txns=${g.bad_txn_count}`);
    if (summary.staging_age_hours != null) bits.push(`staging_age=${summary.staging_age_hours}h`);
    return {
      alert: true,
      message:
        `xoro-gl-mirror-post: run ABORTED for ${month} (${bits.join(", ")}). ` +
        `The Xoro GL mirror is NOT advancing — July-style revenue gap risk. ` +
        `Fixes: period_not_open => expected right after close; stale_feed => check ` +
        `rest_gl_sync.py / /api/xoro/sync-gl; unmapped_or_unbalanced => curate ` +
        `xoro_account_map (scripts/build-xoro-account-map.mjs) then it self-heals next run. ` +
        `Drill: Tangerine -> Accounting -> Income Statement.`,
    };
  }
  const remaining = Number(summary.remaining || 0);
  if (summary.status === "posted" && remaining > 0) {
    return {
      alert: true,
      message:
        `xoro-gl-mirror-post: posted ${summary.posted} JE(s) for ${month} but ${remaining} ` +
        `txn(s) REMAIN (bounded chunk of ${DEFAULT_MAX_TXNS}). Backlog will clear over the next ` +
        `run(s); if it grows, raise max_txns or investigate the feed.`,
    };
  }
  return { alert: false };
}

function parseParams(req) {
  const out = { month: null, max_txns: DEFAULT_MAX_TXNS, stale_hours: DEFAULT_STALE_HOURS };
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const m = url.searchParams.get("month");
    if (m && MONTH_RE.test(m)) out.month = m;
    const mt = Number(url.searchParams.get("max_txns"));
    if (Number.isFinite(mt) && mt > 0 && mt <= 5000) out.max_txns = Math.trunc(mt);
    const sh = Number(url.searchParams.get("stale_hours"));
    if (Number.isFinite(sh) && sh > 0 && sh <= 720) out.stale_hours = Math.trunc(sh);
  } catch { /* defaults */ }
  return out;
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !KEY) return res.status(500).json({ error: "Supabase admin not configured" });
  const admin = createClient(SB_URL, KEY, { auth: { persistSession: false } });

  const { month, max_txns, stale_hours } = parseParams(req);
  const out = { ok: true, alerted: false };

  try {
    const { data, error } = await admin.rpc("xoro_gl_mirror_post_open_month", {
      p_month: month,
      p_max_txns: max_txns,
      p_stale_hours: stale_hours,
    });
    if (error) throw new Error(`xoro_gl_mirror_post_open_month rpc failed: ${error.message}`);
    const summary = data || {};
    out.summary = summary;

    const { alert, message } = decideAlert(summary);
    if (alert) {
      await captureError({
        source: "cron",
        route: "/api/cron/xoro-gl-mirror-post",
        message,
        context: { kind: "xoro-gl-mirror-post", summary },
      });
      out.alerted = true;
    }
    return res.status(200).json(out);
  } catch (e) {
    await captureError({
      source: "cron",
      route: "/api/cron/xoro-gl-mirror-post",
      message: e?.message || String(e),
      stack: e?.stack,
      context: { kind: "xoro-gl-mirror-post" },
    });
    return res.status(500).json({ ...out, ok: false, error: e?.message || String(e) });
  }
}
