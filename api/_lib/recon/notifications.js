// api/_lib/recon/notifications.js
//
// Tangerine P9-8 — Recon variance notification helpers.
// Architecture: docs/tangerine/P9-parallel-run-architecture.md §3.6 (D10
// notification rules) + arch §3.4 (close pre-flight extension).
//
// Two rule shapes ship in this chunk:
//
//   Rule A — variance over threshold
//     Triggered when a recon_run completes with status='variance'.
//     Recipients: CEO (employees.role='ceo' → entity_users.role='ceo' or
//     'admin') + accountant role. Subject:
//       `Recon variance — {domain} {period_start} to {period_end} — ${total_variance}`
//     Body includes a link to InternalReconciliationDashboard with the
//     run pre-selected, plus the totals_jsonb summary.
//
//   Rule B — replay-detected retroactive edit
//     Stub. Triggered when a recon_run with cadence='replay' completes
//     with status='variance'. The full auto-detection lands in P9-9
//     (T10 mirror auto-replay). For now we just emit a more pointed
//     subject so the CEO sees "Replay caught retroactive variance" vs
//     the cadence='weekly' Rule A message.
//
// Idempotency:
//   - notifyReconVariance is keyed on (recon_run_id, kind). The
//     notification_events table has no unique constraint, so a caller
//     calling twice would create two events. The cron orchestrator only
//     calls once per engine-completion, so re-running the cron for the
//     same Monday WOULD emit a second event (same kind, same context_id).
//     That's correct behavior for re-runs (a replay should fire its own
//     notification). Operators who don't want duplicates can mute on
//     context_id at the dispatch worker level.
//
// Pure module. Caller injects the supabase admin client + an enqueue
// function (for test seam). Returns:
//   { emitted: boolean, event_id: uuid|null, skipped?: string }
//
// Never throws on resolution failures — captures them as `errors[]` so
// the cron orchestrator can keep going.

import { enqueue as defaultEnqueue } from "../notifications/index.js";

const VARIANCE_KIND_WEEKLY = "recon_variance_detected";
const VARIANCE_KIND_REPLAY = "recon_replay_variance_detected";

// Roles to fan-out to. 'admin' covers the CEO seat in entity_users; we
// also include 'accountant' so the bookkeeper sees parallel-run drift
// the same day the CEO does. Operator can extend by editing this set.
export const RECON_RECIPIENT_ROLES = Object.freeze(["admin", "accountant"]);

/**
 * Format cents as $X,XXX.XX with sign preserved. Used in the subject line.
 */
export function formatCents(cents) {
  const n = Number(cents || 0);
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  // Insert thousands separators in the whole part.
  const wholeStr = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${wholeStr}.${frac}`;
}

/**
 * Compose the email/in-app subject for Rule A or Rule B.
 */
export function buildSubject({ domain, period_start, period_end, total_variance_cents, cadence }) {
  const prefix = cadence === "replay" ? "Recon REPLAY variance" : "Recon variance";
  const dom = String(domain || "").toUpperCase();
  return `${prefix} — ${dom} ${period_start} to ${period_end} — ${formatCents(total_variance_cents)}`;
}

/**
 * Compose the body. Includes a relative dashboard link the operator can
 * paste into the browser (the in_app channel already deep-links by
 * context_id, but the email plain-text body needs a copy/paste URL).
 */
export function buildBody({ domain, period_start, period_end, total_variance_cents, recon_run_id, cadence, totals_jsonb }) {
  const link = `/tanda/InternalReconciliationDashboard?recon_run_id=${recon_run_id}`;
  const lines = [
    `A ${cadence} reconciliation run detected variance above threshold.`,
    "",
    `Domain:           ${String(domain || "").toUpperCase()}`,
    `Period:           ${period_start} → ${period_end}`,
    `Total variance:   ${formatCents(total_variance_cents)}`,
    `Recon run id:     ${recon_run_id}`,
    `Cadence:          ${cadence}`,
    "",
    `Open in dashboard: ${link}`,
  ];
  if (totals_jsonb && typeof totals_jsonb === "object") {
    const summaryKeys = ["rows_compared", "variances_found", "skipped_count"];
    const summary = [];
    for (const k of summaryKeys) {
      if (totals_jsonb[k] != null) summary.push(`  ${k}: ${totals_jsonb[k]}`);
    }
    if (summary.length > 0) {
      lines.push("", "Summary:", ...summary);
    }
  }
  return lines.join("\n");
}

/**
 * Decide whether a recon_run row qualifies for a notification.
 * Returns { fire: boolean, kind: string, reason?: string }.
 */
export function classifyRun(run) {
  if (!run || typeof run !== "object") {
    return { fire: false, reason: "no_run" };
  }
  if (run.status !== "variance" && run.status !== "error") {
    return { fire: false, reason: `status_${run.status || "unknown"}_not_actionable` };
  }
  if (run.cadence === "replay") {
    return { fire: true, kind: VARIANCE_KIND_REPLAY };
  }
  return { fire: true, kind: VARIANCE_KIND_WEEKLY };
}

/**
 * Main entrypoint. Reads the recon_run row (entity_id + period + status +
 * totals_jsonb + cadence), composes the message, and enqueues via M28.
 *
 * @param {Object}   args
 * @param {Object}   args.adminClient   service-role supabase client
 * @param {string}   args.reconRunId    uuid of the recon_runs row
 * @param {Function} [args.enqueue]     test seam (defaults to M28 enqueue)
 * @returns {Promise<{emitted, event_id, skipped?, errors?}>}
 */
export async function notifyReconVariance({ adminClient, reconRunId, enqueue = defaultEnqueue }) {
  const out = { emitted: false, event_id: null, errors: [] };

  if (!adminClient) {
    out.errors.push({ scope: "args", reason: "adminClient required" });
    return out;
  }
  if (!reconRunId || typeof reconRunId !== "string") {
    out.errors.push({ scope: "args", reason: "reconRunId required" });
    return out;
  }

  // 1. Read recon_runs row.
  let run;
  try {
    const { data, error } = await adminClient
      .from("recon_runs")
      .select("id, entity_id, domain, status, cadence, period_start, period_end, totals_jsonb, replay_of_id")
      .eq("id", reconRunId)
      .maybeSingle();
    if (error) {
      out.errors.push({ scope: "recon_runs_read", reason: error.message });
      return out;
    }
    if (!data) {
      out.skipped = "recon_run_not_found";
      return out;
    }
    run = data;
  } catch (err) {
    out.errors.push({ scope: "recon_runs_read", reason: err?.message || String(err) });
    return out;
  }

  // 2. Classify.
  const decision = classifyRun(run);
  if (!decision.fire) {
    out.skipped = decision.reason;
    return out;
  }

  // 3. Extract total_variance_cents from totals_jsonb (the engine
  //    populates this; default to 0 if missing so the notification
  //    still goes out — the operator wants to see the run id even if
  //    the totals are unreadable).
  const total_variance_cents = Number(
    run.totals_jsonb?.total_variance_cents ?? 0,
  );

  const subject = buildSubject({
    domain: run.domain,
    period_start: run.period_start,
    period_end: run.period_end,
    total_variance_cents,
    cadence: run.cadence,
  });
  const body = buildBody({
    domain: run.domain,
    period_start: run.period_start,
    period_end: run.period_end,
    total_variance_cents,
    recon_run_id: run.id,
    cadence: run.cadence,
    totals_jsonb: run.totals_jsonb,
  });

  // 4. Enqueue.
  try {
    const ev = await enqueue(adminClient, {
      entity_id: run.entity_id,
      kind: decision.kind,
      severity: "warn",
      subject,
      body,
      context_table: "recon_runs",
      context_id: run.id,
      payload: {
        domain: run.domain,
        period_start: run.period_start,
        period_end: run.period_end,
        cadence: run.cadence,
        status: run.status,
        total_variance_cents,
        recon_run_id: run.id,
        replay_of_id: run.replay_of_id || null,
        totals_jsonb: run.totals_jsonb || {},
      },
      recipient_roles: [...RECON_RECIPIENT_ROLES],
    });
    out.emitted = true;
    out.event_id = ev?.event_id || null;
    out.dispatch_count = ev?.dispatch_count || 0;
    out.kind = decision.kind;
    return out;
  } catch (err) {
    out.errors.push({ scope: "enqueue", reason: err?.message || String(err) });
    return out;
  }
}

export const __test_only__ = {
  VARIANCE_KIND_WEEKLY,
  VARIANCE_KIND_REPLAY,
};
