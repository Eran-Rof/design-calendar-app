// api/_lib/xoro-mirror/backfillJobs.js
//
// Durable queue for UNATTENDED Xoro mirror range backfills (table
// xoro_mirror_backfill_jobs, mig 20260953000000). The operator enqueues a
// [from, to] job and closes the tab; the worker cron (api/cron/
// xoro-mirror-backfill-worker) drains it a chunk at a time, reusing the proven
// per-date pipeline (runMirrorRange → runNightlyMirror) so every date posts with
// its own posting_date into its own period.
//
// Lifecycle: pending → running (claimed by a worker tick) → back to pending when
// the tick's time budget is spent with days left → … → complete (cursor past
// to) | failed (a hard error that would repeat). Resumable: cursor_date is the
// next unprocessed date, persisted after each committed chunk, so a crash
// resumes there. Idempotent underneath (summary JEs skip if already posted,
// mirror rows upsert).

import { runMirrorRange } from "../../cron/xoro-mirror-nightly.js";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function isoAddDays(iso, days) {
  return new Date(new Date(`${iso}T00:00:00Z`).getTime() + days * 86400000).toISOString().slice(0, 10);
}
function daysInclusive(from, to) {
  return Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86400000) + 1;
}
function emptyTotals() {
  return { ar_upserted: 0, ap_upserted: 0, inventory_upserted: 0, summary_jes_posted: 0 };
}

/** Insert a pending backfill job for [from, to]. Returns the row. */
export async function enqueueBackfillJob(admin, { entity_id, from, to, chunk_days = 30, created_by_user_id = null }) {
  if (!ISO.test(from || "") || !ISO.test(to || "")) throw new Error("enqueueBackfillJob: from/to must be YYYY-MM-DD");
  if (from > to) throw new Error(`enqueueBackfillJob: from (${from}) must be on or before to (${to})`);
  const { data, error } = await admin
    .from("xoro_mirror_backfill_jobs")
    .insert({
      entity_id,
      from_date: from,
      to_date: to,
      cursor_date: from,
      chunk_days,
      days_total: daysInclusive(from, to),
      status: "pending",
      created_by_user_id,
    })
    .select()
    .single();
  if (error) throw new Error(`enqueueBackfillJob: ${error.message}`);
  return data;
}

/**
 * Claim the oldest actionable job for this worker tick: a 'pending' job, or a
 * 'running' job whose heartbeat (updated_at) is older than staleMs (a crashed
 * worker — staleMs must exceed the function max duration so we never steal a job
 * from a still-running invocation). Optimistic lock via (status, updated_at) so
 * two overlapping ticks can't both claim the same job. Returns the claimed row
 * (status='running') or null.
 */
export async function claimNextJob(admin, { staleMs = 15 * 60 * 1000, now = () => new Date() } = {}) {
  const staleBefore = new Date(now().getTime() - staleMs).toISOString();
  const { data: cands, error } = await admin
    .from("xoro_mirror_backfill_jobs")
    .select("*")
    .in("status", ["pending", "running"])
    .order("created_at", { ascending: true })
    .limit(20);
  if (error) throw new Error(`claimNextJob: ${error.message}`);
  for (const j of cands || []) {
    if (j.status === "running" && j.updated_at && j.updated_at > staleBefore) continue; // live worker owns it
    const stamp = now().toISOString();
    const { data: claimed } = await admin
      .from("xoro_mirror_backfill_jobs")
      .update({ status: "running", updated_at: stamp, started_at: j.started_at || stamp })
      .eq("id", j.id)
      .eq("status", j.status)
      .eq("updated_at", j.updated_at)
      .select()
      .maybeSingle();
    if (claimed) return claimed;
    // lost the race → try the next candidate
  }
  return null;
}

/**
 * Process a claimed job's chunks until the time budget is spent or the range is
 * finished. Persists progress (cursor_date + rolling totals) after EACH chunk so
 * a crash resumes cleanly. When budget runs out with days remaining, the job is
 * released back to 'pending' so the next worker tick continues; when finished it
 * flips to 'complete'; a hard runMirrorRange error flips it to 'failed'.
 *
 * @param {object} admin
 * @param {object} job     a claimed ('running') job row
 * @param {object} [opts]
 *   @param {number}  [opts.budgetMs=240000]  per-tick work budget (< function maxDuration)
 *   @param {Function}[opts.nowMs]            () => ms, for tests
 *   @param {Function}[opts.runRange]         runMirrorRange override, for tests
 * @returns {Promise<{status, cursor, days_done}>}
 */
export async function advanceJob(admin, job, opts = {}) {
  const budgetMs = opts.budgetMs ?? 240000;
  const nowMs = opts.nowMs ?? (() => Date.now());
  const runRange = opts.runRange ?? runMirrorRange;
  const nowIso = () => new Date(nowMs()).toISOString();

  const to = job.to_date;
  const chunk = job.chunk_days || 30;
  let cursor = job.cursor_date;
  const totals = { ...emptyTotals(), ...(job.totals || {}) };
  let jeCount = job.je_count || 0;
  let daysDone = job.days_done || 0;
  const errors = Array.isArray(job.errors) ? [...job.errors] : [];

  const started = nowMs();
  while (cursor <= to && (nowMs() - started) < budgetMs) {
    const chunkEnd = isoAddDays(cursor, chunk - 1) > to ? to : isoAddDays(cursor, chunk - 1);
    let r;
    try {
      r = await runRange(admin, { from: cursor, to: chunkEnd, entity_id_override: job.entity_id, skipStaleGuard: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push({ from: cursor, to: chunkEnd, message: msg });
      await admin.from("xoro_mirror_backfill_jobs").update({
        status: "failed", last_error: msg, errors, totals, je_count: jeCount, days_done: daysDone, updated_at: nowIso(),
      }).eq("id", job.id);
      return { status: "failed", cursor, days_done: daysDone, error: msg };
    }
    const t = r.totals || {};
    totals.ar_upserted += t.ar_upserted || 0;
    totals.ap_upserted += t.ap_upserted || 0;
    totals.inventory_upserted += t.inventory_upserted || 0;
    totals.summary_jes_posted += t.summary_jes_posted || 0;
    jeCount += Array.isArray(r.je_ids) ? r.je_ids.length : (t.summary_jes_posted || 0);
    daysDone += r.days || 0;
    if (Array.isArray(r.errors)) for (const er of r.errors) errors.push(er);

    cursor = isoAddDays(chunkEnd, 1);
    const done = cursor > to;
    await admin.from("xoro_mirror_backfill_jobs").update({
      cursor_date: done ? to : cursor,
      days_done: daysDone,
      totals,
      je_count: jeCount,
      errors,
      status: done ? "complete" : "running",
      updated_at: nowIso(),
      ...(done ? { completed_at: nowIso() } : {}),
    }).eq("id", job.id);
    if (done) return { status: "complete", cursor: to, days_done: daysDone };
  }

  // Budget spent with days remaining → release for the next worker tick.
  await admin.from("xoro_mirror_backfill_jobs").update({ status: "pending", updated_at: nowIso() }).eq("id", job.id);
  return { status: "pending", cursor, days_done: daysDone };
}

export const __test = { isoAddDays, daysInclusive };
