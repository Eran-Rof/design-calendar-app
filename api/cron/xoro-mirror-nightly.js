// api/cron/xoro-mirror-nightly
//
// Cross-cutter T10-6 — Nightly Xoro Mirror orchestrator (arch §3, §6, §7).
//
// Runs daily at 01:30 UTC (=20:30 EST / 21:30 EDT) — roughly 30 min after the
// operator's 21:00 local nightly Xoro fetch finishes loading CSVs into the
// ip_* tables. Walks four sub-jobs in order:
//
//   1. AR mirror     (mirrorArForDate)
//   2. AP mirror     (mirrorApForDate)
//   3. Inventory rebuild (rebuildInventoryLayersForDate)
//   4. Daily summary JEs (postDailySummaryJes)  — only if 1-3 all succeeded
//
// Two hard guards run before any of that:
//
//   - Stale-Xoro guard: if MAX(xoro_sync_logs.completed_at WHERE status='complete')
//     is older than 25 hours, we skip every domain with status='skipped_stale_xoro'
//     and emit a 'xoro_mirror_stale_fetch_skip' notification. The mirror leg of
//     the orchestrator is never called.
//
//   - Entity guard: resolves the default 'ROF' entity. Missing entity → 500.
//
// Each domain insert into xoro_mirror_runs is idempotent via the UNIQUE
// (entity_id, domain, mirror_date) constraint — re-running for the same date
// updates the existing row rather than inserting a duplicate. (Today we always
// INSERT-then-UPDATE since the per-domain handlers own the row lifecycle.)
//
// Result shape:
//   {
//     mirror_date,
//     status: 'complete' | 'partial' | 'skipped_stale_xoro',
//     ar:        { rows_upserted, rows_unchanged, errors, run_id, status },
//     ap:        { ... }   (same shape)
//     inventory: { ... }
//     summary_jes: { posted: N, je_ids: [...], errors: [...] } | { skipped: '...' }
//     notification_emitted: true | false,
//     notification_event_id: <uuid> | null,
//   }
//
// Query params:
//   ?mirror_date=YYYY-MM-DD   override the auto-computed date (manual re-run)
//   ?entity_id=<uuid>         override the default ROF entity lookup
//
// Notes:
//   - We catch per-domain throws so one failure doesn't sink the rest. The
//     summary JE step is the ONLY one that's conditional on all-three-success.
//   - Notification kind is 'xoro_mirror_complete' on full success,
//     'xoro_mirror_partial_failure' otherwise (incl. one domain throwing).
//   - We import lib functions lazily so a missing T10-3/T10-4/T10-5 module
//     just lands as a per-domain failure rather than crashing the import.

import { createClient } from "@supabase/supabase-js";
import { mirrorArForDate } from "../_lib/xoro-mirror/ar.js";
import { enqueue as enqueueNotification } from "../_lib/notifications/index.js";

// AP, inventory, and summary-JE lib modules are owned by T10-3 / T10-4 / T10-5,
// which are open in parallel with this PR. We dynamic-import them so this
// orchestrator module loads even if those modules haven't landed yet — at
// runtime a missing module surfaces as a per-domain "failed" result rather
// than a module-load crash.
//
// Once T10-3/4/5 land, both Vercel deploys and vitest see real modules and
// these dynamic loads succeed silently.
async function loadMirrorAp() {
  const mod = await import("../_lib/xoro-mirror/ap.js");
  return mod.mirrorApForDate;
}
async function loadRebuildInventory() {
  const mod = await import("../_lib/xoro-mirror/inventory.js");
  return mod.rebuildInventoryLayersForDate;
}
async function loadPostDailySummaryJes() {
  const mod = await import("../_lib/xoro-mirror/summary-je.js");
  return mod.postDailySummaryJes;
}

export const config = { maxDuration: 300 };

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STALE_THRESHOLD_HOURS = 25;
const DOMAINS = ["ar", "ap", "inventory"];

/**
 * Compute today's business date in YYYY-MM-DD.
 *
 * Today we use UTC because the operator's TZ_OFFSET env var isn't wired yet.
 * 01:30 UTC cron → "today" UTC is the date the operator's 21:00 fetch covered
 * (since 01:30 UTC is still the same calendar day as 21:00 EST the prior
 * evening — wait, no, it's actually the NEXT day in UTC.) For day N's fetch
 * landing at ~21:00 local on day N, the mirror at 01:30 UTC on day N+1
 * (UTC) should produce summary JEs dated day N. So we subtract 1 day.
 *
 * If the operator passes ?mirror_date=, that overrides this entirely.
 */
export function defaultMirrorDate(now = new Date()) {
  // Subtract 1 day to get yesterday-UTC = the business day the Xoro fetch
  // covered (it ran at ~21:00 local yesterday).
  const d = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

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

  let mirror_date = null;
  let entity_id_override = null;
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    mirror_date = url.searchParams.get("mirror_date");
    entity_id_override = url.searchParams.get("entity_id");
  } catch { /* fall through */ }

  if (mirror_date && !ISO_DATE_RE.test(mirror_date)) {
    return res.status(400).json({ error: "mirror_date must be YYYY-MM-DD" });
  }

  try {
    const out = await runNightlyMirror(admin, {
      mirror_date: mirror_date || defaultMirrorDate(),
      entity_id_override,
    });
    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Orchestrator. Exposed for testability — vitest tests import this directly
 * and pass a mocked supabase.
 *
 * @param {Object} supabase  service-role client
 * @param {Object} opts
 * @param {string} opts.mirror_date   ISO YYYY-MM-DD
 * @param {string|null} [opts.entity_id_override]
 * @param {boolean} [opts.skipStaleGuard]      bypass the stale-fetch guard (backfills)
 * @param {boolean} [opts.suppressNotification] skip the per-run notification (range emits one)
 * @param {Object} [opts.deps]        injection point for tests (mirrorAr, mirrorAp, ...)
 */
export async function runNightlyMirror(supabase, opts = {}) {
  const mirror_date = opts.mirror_date || defaultMirrorDate();
  if (!ISO_DATE_RE.test(mirror_date)) {
    throw new Error(`runNightlyMirror: mirror_date '${mirror_date}' is not YYYY-MM-DD`);
  }

  // Resolve dynamic-loaded modules lazily (T10-3/4/5 deps). If a load fails
  // because the module hasn't landed, we surface a thrown function so the
  // per-domain handler records 'uncaught' + continues with the next domain.
  const failingLoader = (label, err) => async () => {
    throw new Error(`${label} module not available: ${err instanceof Error ? err.message : String(err)}`);
  };
  let depMirrorAp, depRebuildInventory, depPostSummary;
  try { depMirrorAp = await loadMirrorAp(); }
  catch (e) { depMirrorAp = failingLoader("mirrorApForDate", e); }
  try { depRebuildInventory = await loadRebuildInventory(); }
  catch (e) { depRebuildInventory = failingLoader("rebuildInventoryLayersForDate", e); }
  try { depPostSummary = await loadPostDailySummaryJes(); }
  catch (e) { depPostSummary = failingLoader("postDailySummaryJes", e); }

  const deps = {
    mirrorAr: mirrorArForDate,
    mirrorAp: depMirrorAp,
    rebuildInventory: depRebuildInventory,
    postSummary: depPostSummary,
    enqueue: enqueueNotification,
    ...(opts.deps || {}),
  };

  // Resolve entity. Default to ROF unless overridden.
  let entity;
  if (opts.entity_id_override) {
    const { data, error } = await supabase
      .from("entities")
      .select("id, code")
      .eq("id", opts.entity_id_override)
      .maybeSingle();
    if (error || !data) {
      throw new Error(`entity_id ${opts.entity_id_override} not found`);
    }
    entity = data;
  } else {
    const { data, error } = await supabase
      .from("entities")
      .select("id, code")
      .eq("code", "ROF")
      .maybeSingle();
    if (error || !data) {
      throw new Error("Default entity (ROF) not found");
    }
    entity = data;
  }

  // --- Guard: stale Xoro fetch ---
  // Skipped for an explicit backfill (opts.skipStaleGuard): a range re-mirror of
  // historical dates intentionally works off already-loaded data, so the "is the
  // live fetch fresh?" check doesn't apply and would otherwise skip every date.
  if (!opts.skipStaleGuard) {
    const stale = await isXoroFetchStale(supabase);
    if (stale.stale) {
      return await skipStaleXoroFetch(supabase, {
        entity_id: entity.id,
        mirror_date,
        last_completed_at: stale.last_completed_at,
        hours_since: stale.hours_since,
        enqueue: deps.enqueue,
      });
    }
  }

  // --- Run the four domains in order ---
  const out = {
    mirror_date,
    status: "complete",
    ar: null, ap: null, inventory: null, summary_jes: null,
    notification_emitted: false,
    notification_event_id: null,
  };

  out.ar        = await runDomain(supabase, entity, mirror_date, "ar",        deps.mirrorAr);
  out.ap        = await runDomain(supabase, entity, mirror_date, "ap",        deps.mirrorAp);
  out.inventory = await runDomain(supabase, entity, mirror_date, "inventory", deps.rebuildInventory);

  const allOk = [out.ar, out.ap, out.inventory].every((d) => d && d.status === "complete");
  if (allOk) {
    out.summary_jes = await runSummaryJe(supabase, entity, mirror_date, deps.postSummary);
    if (out.summary_jes && out.summary_jes.status === "failed") {
      out.status = "partial";
    }
  } else {
    out.status = "partial";
    out.summary_jes = { skipped: "one_or_more_domains_failed" };
  }

  // --- Emit notification ---
  // Suppressed inside a range backfill (opts.suppressNotification): runMirrorRange
  // emits ONE summary rather than one per date.
  if (opts.suppressNotification) return out;
  const kind = out.status === "complete"
    ? "xoro_mirror_complete"
    : "xoro_mirror_partial_failure";
  const severity = out.status === "complete" ? "info" : "warn";
  const subject = out.status === "complete"
    ? `Xoro mirror complete — ${mirror_date}`
    : `Xoro mirror PARTIAL — ${mirror_date}`;
  const body = composeNotificationBody(out);

  try {
    const ev = await deps.enqueue(supabase, {
      entity_id: entity.id,
      kind,
      severity,
      subject,
      body,
      context_table: "xoro_mirror_runs",
      context_id: null,
      payload: {
        mirror_date,
        status: out.status,
        ar: summarizeDomain(out.ar),
        ap: summarizeDomain(out.ap),
        inventory: summarizeDomain(out.inventory),
        summary_jes: out.summary_jes,
      },
      recipient_roles: ["admin", "accounting"],
    });
    out.notification_emitted = true;
    out.notification_event_id = ev?.event_id || null;
  } catch (e) {
    // Don't fail the orchestrator just because the notification fanout broke.
    out.notification_emitted = false;
    out.notification_error = e instanceof Error ? e.message : String(e);
  }

  return out;
}

/**
 * Returns { stale: boolean, last_completed_at: string|null, hours_since: number|null }.
 *
 * "Stale" means MAX(completed_at WHERE status='complete') is more than 25h
 * in the past (or no successful row exists at all).
 */
export async function isXoroFetchStale(supabase, nowMs = Date.now()) {
  const { data, error } = await supabase
    .from("xoro_sync_logs")
    .select("completed_at")
    .eq("status", "complete")
    .not("completed_at", "is", null)
    .order("completed_at", { ascending: false })
    .limit(1);
  if (error) {
    // Treat "can't read sync log" as stale — operator gets a notification
    // and can investigate. Better than silently mirroring stale data.
    return { stale: true, last_completed_at: null, hours_since: null, read_error: error.message };
  }
  const row = (data || [])[0];
  if (!row || !row.completed_at) {
    return { stale: true, last_completed_at: null, hours_since: null };
  }
  const lastMs = new Date(row.completed_at).getTime();
  if (!Number.isFinite(lastMs)) {
    return { stale: true, last_completed_at: row.completed_at, hours_since: null };
  }
  const hours_since = (nowMs - lastMs) / (1000 * 60 * 60);
  return {
    stale: hours_since > STALE_THRESHOLD_HOURS,
    last_completed_at: row.completed_at,
    hours_since,
  };
}

/**
 * Insert a 'skipped_stale_xoro' xoro_mirror_runs row for each domain + emit
 * a single 'xoro_mirror_stale_fetch_skip' notification. Never calls any
 * mirror function.
 */
async function skipStaleXoroFetch(supabase, ctx) {
  const { entity_id, mirror_date, last_completed_at, hours_since, enqueue } = ctx;
  const out = {
    mirror_date,
    status: "skipped_stale_xoro",
    ar: null, ap: null, inventory: null, summary_jes: { skipped: "stale_xoro" },
    notification_emitted: false,
    notification_event_id: null,
    last_xoro_fetch_at: last_completed_at,
    hours_since_last_fetch: hours_since,
  };

  for (const domain of DOMAINS) {
    const summary = { status: "skipped_stale_xoro", rows_upserted: 0, rows_unchanged: 0, errors: [] };
    const inserted = await insertSkipRunRow(supabase, { entity_id, domain, mirror_date, last_completed_at, hours_since });
    out[domain] = { ...summary, run_id: inserted?.id || null };
  }

  try {
    const subject = `Xoro mirror SKIPPED — stale fetch (${mirror_date})`;
    const body = last_completed_at
      ? `The most recent successful Xoro fetch completed at ${last_completed_at}` +
        (Number.isFinite(hours_since) ? ` (${hours_since.toFixed(1)}h ago, threshold ${STALE_THRESHOLD_HOURS}h).` : ".") +
        ` All four mirror domains were skipped for ${mirror_date}. ` +
        `Re-run the Xoro fetch and trigger the mirror manually from the Shadow Mirror Status panel.`
      : `No successful Xoro fetch found in xoro_sync_logs. ` +
        `All four mirror domains were skipped for ${mirror_date}. ` +
        `Verify the nightly fetch job is running.`;
    const ev = await enqueue(supabase, {
      entity_id,
      kind: "xoro_mirror_stale_fetch_skip",
      severity: "warn",
      subject,
      body,
      context_table: "xoro_mirror_runs",
      context_id: null,
      payload: {
        mirror_date,
        last_xoro_fetch_at: last_completed_at,
        hours_since_last_fetch: hours_since,
        threshold_hours: STALE_THRESHOLD_HOURS,
      },
      recipient_roles: ["admin", "accounting"],
    });
    out.notification_emitted = true;
    out.notification_event_id = ev?.event_id || null;
  } catch (e) {
    out.notification_emitted = false;
    out.notification_error = e instanceof Error ? e.message : String(e);
  }

  return out;
}

async function insertSkipRunRow(supabase, { entity_id, domain, mirror_date, last_completed_at, hours_since }) {
  const errors = [{
    kind: "skipped_stale_xoro",
    last_xoro_fetch_at: last_completed_at,
    hours_since_last_fetch: hours_since,
    threshold_hours: STALE_THRESHOLD_HOURS,
  }];
  const { data, error } = await supabase
    .from("xoro_mirror_runs")
    .insert({
      entity_id, domain, mirror_date,
      status: "skipped_stale_xoro",
      errors,
      completed_at: new Date().toISOString(),
    })
    .select("id")
    .maybeSingle();
  if (error) {
    // Most likely a unique-violation from a prior skip earlier today —
    // safe to ignore.
    return null;
  }
  return data;
}

/**
 * Run one mirror domain end-to-end:
 *   - Insert xoro_mirror_runs row with status='running'
 *   - Call the mirror function
 *   - Update the row with row counts + status='complete'/'failed'
 *
 * Per-domain throws are caught and turned into status='failed' + error
 * row. The orchestrator continues to the next domain.
 */
async function runDomain(supabase, entity, mirror_date, domain, mirrorFn) {
  const result = {
    domain,
    status: "running",
    rows_upserted: 0,
    rows_unchanged: 0,
    rows_deleted: 0,
    rows_skipped_manual_conflict: 0,
    errors: [],
    run_id: null,
  };

  // Open the run row.
  const { data: runRow, error: runErr } = await supabase
    .from("xoro_mirror_runs")
    .insert({
      entity_id: entity.id,
      domain,
      mirror_date,
      status: "running",
    })
    .select("id")
    .maybeSingle();
  if (runErr || !runRow) {
    result.status = "failed";
    result.errors.push({
      kind: "run_row_open_failed",
      message: runErr?.message || "no row returned",
    });
    return result;
  }
  result.run_id = runRow.id;

  let summary;
  try {
    summary = await mirrorFn(supabase, entity.id, mirror_date);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await supabase
      .from("xoro_mirror_runs")
      .update({
        status: "failed",
        completed_at: new Date().toISOString(),
        errors: [{ kind: "uncaught", message }],
      })
      .eq("id", runRow.id);
    result.status = "failed";
    result.errors.push({ kind: "uncaught", message });
    return result;
  }

  // Normalize summary shape across the three domains.
  const rows_upserted              = Number(summary?.rows_upserted              ?? 0);
  const rows_unchanged             = Number(summary?.rows_unchanged             ?? 0);
  const rows_deleted               = Number(summary?.rows_deleted               ?? 0);
  const rows_skipped_manual_conflict = Number(summary?.rows_skipped_manual_conflict ?? 0);
  const errors                     = Array.isArray(summary?.errors) ? summary.errors : [];

  await supabase
    .from("xoro_mirror_runs")
    .update({
      status: "complete",
      rows_upserted,
      rows_unchanged,
      rows_deleted,
      errors,
      completed_at: new Date().toISOString(),
    })
    .eq("id", runRow.id);

  result.status = "complete";
  result.rows_upserted = rows_upserted;
  result.rows_unchanged = rows_unchanged;
  result.rows_deleted = rows_deleted;
  result.rows_skipped_manual_conflict = rows_skipped_manual_conflict;
  result.errors = errors;
  return result;
}

/**
 * Run the daily summary JE poster. Inserts a separate xoro_mirror_runs row
 * with domain='summary_je' so the run history shows the final step.
 */
async function runSummaryJe(supabase, entity, mirror_date, postSummary) {
  const { data: runRow, error: runErr } = await supabase
    .from("xoro_mirror_runs")
    .insert({
      entity_id: entity.id,
      domain: "summary_je",
      mirror_date,
      status: "running",
    })
    .select("id")
    .maybeSingle();
  if (runErr || !runRow) {
    return {
      status: "failed",
      run_id: null,
      errors: [{ kind: "run_row_open_failed", message: runErr?.message || "no row returned" }],
    };
  }

  let summary;
  try {
    summary = await postSummary(supabase, entity.id, mirror_date);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await supabase
      .from("xoro_mirror_runs")
      .update({
        status: "failed",
        completed_at: new Date().toISOString(),
        errors: [{ kind: "uncaught", message }],
      })
      .eq("id", runRow.id);
    return { status: "failed", run_id: runRow.id, errors: [{ kind: "uncaught", message }] };
  }

  const je_ids = Array.isArray(summary?.je_ids) ? summary.je_ids : [];
  const posted = Number(summary?.posted ?? je_ids.length);
  const errors = Array.isArray(summary?.errors) ? summary.errors : [];

  await supabase
    .from("xoro_mirror_runs")
    .update({
      status: "complete",
      rows_upserted: posted,
      je_id: je_ids[0] || null,
      errors,
      completed_at: new Date().toISOString(),
    })
    .eq("id", runRow.id);

  return {
    status: "complete",
    run_id: runRow.id,
    posted,
    je_ids,
    errors,
  };
}

function summarizeDomain(d) {
  if (!d) return null;
  return {
    status: d.status,
    rows_upserted: d.rows_upserted || 0,
    rows_unchanged: d.rows_unchanged || 0,
    rows_deleted: d.rows_deleted || 0,
    rows_skipped_manual_conflict: d.rows_skipped_manual_conflict || 0,
    error_count: Array.isArray(d.errors) ? d.errors.length : 0,
    run_id: d.run_id || null,
  };
}

// ── Range backfill — "run in one shot" over [from, to] ───────────────────────
//
// Loops the proven per-date runNightlyMirror over every date in the inclusive
// range, so each date's AR/AP/inventory mirror + summary JE post with that
// date's own posting_date into its own period (the per-date logic + idempotency
// are unchanged — this just drives them across a span). The stale-fetch guard is
// bypassed (an explicit historical backfill) and per-date notifications are
// suppressed; the caller gets one aggregate result. Re-running a range is safe
// (summary JEs skip already-posted dates; mirrors upsert idempotently).

export const MAX_RANGE_DAYS = 45; // one call; split larger backfills to stay under the function time limit

/** Inclusive list of YYYY-MM-DD dates from `from`..`to` (UTC, DST-safe). */
export function enumerateDates(from, to) {
  const out = [];
  const start = new Date(`${from}T00:00:00Z`).getTime();
  const end = new Date(`${to}T00:00:00Z`).getTime();
  for (let t = start; t <= end; t += 24 * 60 * 60 * 1000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Mirror a DATE RANGE in one invocation.
 *
 * @param {Object} supabase  service-role client
 * @param {Object} opts
 * @param {string} opts.from  ISO YYYY-MM-DD (inclusive)
 * @param {string} opts.to    ISO YYYY-MM-DD (inclusive)
 * @param {string|null} [opts.entity_id_override]
 * @param {boolean} [opts.skipStaleGuard=true]  default true — a backfill mirrors historical dates
 * @param {Object} [opts.deps]  test injection, forwarded to runNightlyMirror
 * @returns aggregate { from, to, days, status, totals, je_ids, per_date, errors }
 */
export async function runMirrorRange(supabase, opts = {}) {
  const { from, to } = opts;
  if (!ISO_DATE_RE.test(from || "") || !ISO_DATE_RE.test(to || "")) {
    throw new Error("runMirrorRange: from and to must be YYYY-MM-DD");
  }
  if (from > to) throw new Error(`runMirrorRange: from (${from}) must be on or before to (${to})`);
  const dates = enumerateDates(from, to);
  if (dates.length > MAX_RANGE_DAYS) {
    throw new Error(`runMirrorRange: range spans ${dates.length} days (max ${MAX_RANGE_DAYS}) — split it into smaller backfills`);
  }

  const out = {
    from, to, days: dates.length,
    status: "complete",
    totals: { ar_upserted: 0, ap_upserted: 0, inventory_upserted: 0, summary_jes_posted: 0 },
    je_ids: [],
    per_date: [],
    errors: [],
  };

  for (const mirror_date of dates) {
    let r;
    try {
      r = await runNightlyMirror(supabase, {
        mirror_date,
        entity_id_override: opts.entity_id_override || null,
        skipStaleGuard: opts.skipStaleGuard !== false, // default TRUE for backfills
        suppressNotification: true,
        deps: opts.deps,
      });
    } catch (e) {
      out.status = "partial";
      out.errors.push({ mirror_date, message: e instanceof Error ? e.message : String(e) });
      out.per_date.push({ mirror_date, status: "failed" });
      continue;
    }
    out.totals.ar_upserted += r.ar?.rows_upserted || 0;
    out.totals.ap_upserted += r.ap?.rows_upserted || 0;
    out.totals.inventory_upserted += r.inventory?.rows_upserted || 0;
    const jes = (r.summary_jes && Array.isArray(r.summary_jes.je_ids)) ? r.summary_jes.je_ids : [];
    out.totals.summary_jes_posted += (r.summary_jes && r.summary_jes.posted) || jes.length || 0;
    for (const id of jes) if (id) out.je_ids.push(id);
    if (r.status !== "complete") out.status = "partial";
    out.per_date.push({
      mirror_date,
      status: r.status,
      ar: summarizeDomain(r.ar),
      ap: summarizeDomain(r.ap),
      inventory: summarizeDomain(r.inventory),
      summary_jes: r.summary_jes,
    });
  }

  return out;
}

function composeNotificationBody(out) {
  const lines = [`Mirror date: ${out.mirror_date}`, `Overall status: ${out.status}`, ""];
  for (const dom of DOMAINS) {
    const d = out[dom];
    if (!d) { lines.push(`${dom.toUpperCase()}: (not run)`); continue; }
    const errs = Array.isArray(d.errors) ? d.errors.length : 0;
    lines.push(`${dom.toUpperCase()}: ${d.status} — ` +
      `upserted=${d.rows_upserted || 0}, unchanged=${d.rows_unchanged || 0}, ` +
      `deleted=${d.rows_deleted || 0}, errors=${errs}`);
  }
  if (out.summary_jes) {
    if (out.summary_jes.skipped) {
      lines.push(`Summary JE: skipped (${out.summary_jes.skipped})`);
    } else {
      lines.push(`Summary JE: posted=${out.summary_jes.posted || 0}, errors=${(out.summary_jes.errors || []).length}`);
    }
  }
  return lines.join("\n");
}
