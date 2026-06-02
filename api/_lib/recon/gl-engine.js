// api/_lib/recon/gl-engine.js
//
// Tangerine P9-5 — General-Ledger reconciliation engine (LAGGING indicator).
// Architecture: docs/tangerine/P9-parallel-run-architecture.md §3.5 + §4.3.
// Schema:       supabase/migrations/20260629800000_p9_chunk1_recon_schema.sql
//
// Compares period-end GL movement on the Tangerine side vs the cumulative
// movement of the Xoro summary JEs that T10-5 posts daily
// (api/_lib/xoro-mirror/summary-je.js). One `recon_runs` row + N
// `recon_variances` rows per (gl_account_id, source_tag) group that
// disagrees.
//
// GL is the LAGGING indicator. Per arch §4.3 — if AP / AR / Cash /
// Inventory are all clean for the same period but GL drifts, the most
// likely cause is a standalone JE that was posted directly into one
// system but not the other. The engine reads the latest recon_runs for
// the other 4 domains in the same (entity, period) window and, when all
// 4 are status='clean', auto-tags GL variances with
// notes='missing_standalone_je' so the operator triage queue surfaces
// the right hypothesis up front.
//
// Operator-confirmed decisions:
//   D2  thresholds  $5/row  +  $25/domain  (lagging indicator — wider
//       tolerance than AP/AR per arch §2, locked by operator)
//   D7  source_tag-aware grouping. journal_entry_lines has no `source`
//       column of its own, so the engine groups by je.source
//       ('xoro_mirror' for the T10-5 summary JEs; 'shopify' / 'fba' /
//       'walmart' / 'faire' / 'manual' for the Tangerine-truth side)
//   D11 replay_of_id supports retroactive re-comparison
//
// Pure module. The caller passes a configured supabase admin client.
// Returns:
//   {
//     recon_run_id:        uuid,
//     status:              'clean' | 'variance' | 'error',
//     rows_compared:       int,                   // distinct (gl_account, source_tag) groups
//     variances_found:     int,                   // |variance| >= per-row threshold
//     total_variance_cents:bigint,                // SUM(|variance|) across all over-rows
//     totals_jsonb:        { ... }                // written to recon_runs.totals_jsonb
//     errors:              [{ scope, reason }],
//   }
//
// The engine never throws on row-level data issues; it captures them in
// `errors` so the run still completes with status='variance' (or 'error'
// when the run itself can't proceed — e.g. recon_runs INSERT failed).

const GL_THRESHOLDS = Object.freeze({
  // $5 per row → 500 cents. Operator-locked (D2 GL row threshold).
  per_row_cents: 500,
  // $25 per domain → 2500 cents. Operator-locked (D2 GL domain threshold).
  per_domain_cents: 2500,
});

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const VALID_CADENCES = new Set(["weekly", "manual", "replay"]);

// The 4 non-GL sub-ledger domains the engine consults to decide whether
// to auto-tag a GL variance as missing_standalone_je. Order is alphabetical
// for stable test fixtures; the engine doesn't depend on it.
const SUBLEDGER_DOMAINS = Object.freeze(["ap", "ar", "cash", "inventory"]);

const MISSING_STANDALONE_NOTE = "missing_standalone_je";

/**
 * Convert a NUMERIC-ish dollar amount to integer cents. Tolerates null,
 * undefined, "$1,234.56", numeric strings, and number primitives.
 * Returns 0 for unparseable values.
 */
export function dollarsToCents(v) {
  if (v == null) return 0;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return 0;
    return Math.round(v * 100);
  }
  if (typeof v === "string") {
    const cleaned = v.replace(/[$,\s]/g, "").trim();
    if (!cleaned) return 0;
    const n = Number(cleaned);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * 100);
  }
  return 0;
}

/**
 * Build the stable group key for matching. Format: '<gl_account_id>::<source_tag>'.
 * source_tag null → 'manual_or_legacy' bucket so it groups but doesn't
 * collide with explicit channel tags.
 */
export function buildGroupKey(gl_account_id, source_tag) {
  const g = gl_account_id || "";
  const s = source_tag || "manual_or_legacy";
  return `${g}::${s}`;
}

/**
 * Validate the runGlReconciliation arg bag. Returns { data } or { error }.
 * Exported for handler reuse.
 */
export function validateArgs(args) {
  const a = args && typeof args === "object" ? args : {};
  if (!a.entity_id || typeof a.entity_id !== "string") {
    return { error: "entity_id is required" };
  }
  if (!a.period_start || !ISO_DATE_RE.test(a.period_start)) {
    return { error: "period_start must be YYYY-MM-DD" };
  }
  if (!a.period_end || !ISO_DATE_RE.test(a.period_end)) {
    return { error: "period_end must be YYYY-MM-DD" };
  }
  if (a.period_end < a.period_start) {
    return { error: "period_end must be >= period_start" };
  }
  const cadence = a.cadence == null ? "weekly" : a.cadence;
  if (!VALID_CADENCES.has(cadence)) {
    return { error: `cadence must be one of ${[...VALID_CADENCES].join(",")}` };
  }
  if (a.replay_of_id != null && typeof a.replay_of_id !== "string") {
    return { error: "replay_of_id must be a uuid string when provided" };
  }
  return {
    data: {
      entity_id: a.entity_id,
      period_start: a.period_start,
      period_end: a.period_end,
      cadence,
      replay_of_id: a.replay_of_id || null,
    },
  };
}

/**
 * Pull GL-side movement for the period. Joins journal_entry_lines to
 * journal_entries so we can filter by je.entity_id, je.status='posted',
 * je.posting_date BETWEEN period bounds, and retain je.source for the
 * per-source grouping (D7).
 *
 * Returns rows shaped:
 *   { account_id, source, debit, credit }
 *
 * We deliberately request a wide column set and re-shape client-side so
 * the supabase double in tests can mirror the embedded-select pattern.
 */
async function fetchGlMovement({ admin, entity_id, period_start, period_end }) {
  const { data, error } = await admin
    .from("journal_entry_lines")
    .select(
      "account_id, debit, credit, journal_entries!inner(entity_id, status, posting_date, source)",
    )
    .eq("journal_entries.entity_id", entity_id)
    .eq("journal_entries.status", "posted")
    .gte("journal_entries.posting_date", period_start)
    .lte("journal_entries.posting_date", period_end);
  if (error) {
    return { error: `journal_entry_lines read failed: ${error.message}` };
  }
  const rows = (data || []).map((r) => {
    const je = r.journal_entries || {};
    return {
      account_id: r.account_id,
      source: je.source || null,
      debit: r.debit,
      credit: r.credit,
    };
  });
  return { rows };
}

/**
 * Bucket movement rows by (gl_account_id, source_tag) into a Map<key, {...}>.
 * Movement = SUM(debit) - SUM(credit) in cents. The matcher compares
 * movement-vs-movement so a debit-only side and a credit-only side
 * surface as variance even when totals individually balance.
 */
export function bucketByAccount(rows) {
  const map = new Map();
  for (const row of rows) {
    const debit_cents = dollarsToCents(row.debit);
    const credit_cents = dollarsToCents(row.credit);
    const key = buildGroupKey(row.account_id, row.source);
    if (!map.has(key)) {
      map.set(key, {
        gl_account_id: row.account_id,
        source_tag: row.source || null,
        movement_cents: 0,
        rows: [],
      });
    }
    const bucket = map.get(key);
    // Net movement = debit - credit. The signed cents represent which
    // way the account moved; the matcher compares Tangerine-net vs
    // Xoro-net per account.
    bucket.movement_cents += debit_cents - credit_cents;
    bucket.rows.push(row);
  }
  return map;
}

/**
 * Split a single bucket Map into two: (Tangerine-truth, Xoro-mirror).
 * 'xoro_mirror' rows go to the Xoro side; everything else to Tangerine.
 *
 * For matching purposes the source_tag dimension is dropped in the key:
 * we want "Tangerine-truth net for account X" compared against
 * "Xoro-mirror net for account X". The reported source_tag on the
 * variance reflects the *Tangerine* originating channel (so the
 * dashboard groups by where Tangerine thinks the movement came from).
 */
export function splitBuckets(allBuckets) {
  const tang = new Map();
  const xoro = new Map();
  for (const [k, b] of allBuckets) {
    if (b.source_tag === "xoro_mirror") xoro.set(k, b);
    else tang.set(k, b);
  }
  return { tang, xoro };
}

/**
 * Match Tangerine + Xoro buckets by gl_account_id and yield one variance
 * row per account where movement differs. The source_tag is collapsed
 * within the matching key so multiple operator-originated channels
 * (manual / shopify / fba / ...) sum together against the single
 * xoro_mirror summary line.
 */
export function matchBuckets(tangBuckets, xoroBuckets) {
  function acctKey(b) {
    return b.gl_account_id || "";
  }

  const tangSum = new Map();
  for (const b of tangBuckets.values()) {
    const k = acctKey(b);
    if (!tangSum.has(k)) {
      tangSum.set(k, {
        gl_account_id: b.gl_account_id,
        source_tag: b.source_tag,
        movement_cents: 0,
      });
    }
    const t = tangSum.get(k);
    t.movement_cents += b.movement_cents;
    // Prefer the non-xoro_mirror, non-null tag for display (originating
    // channel). If multiple channels contribute we keep the first
    // non-mirror non-null tag — operator can drill into the JE list.
    if (b.source_tag && b.source_tag !== "xoro_mirror" && !t.source_tag) {
      t.source_tag = b.source_tag;
    }
  }

  const xoroSum = new Map();
  for (const b of xoroBuckets.values()) {
    const k = acctKey(b);
    if (!xoroSum.has(k)) {
      xoroSum.set(k, {
        gl_account_id: b.gl_account_id,
        source_tag: b.source_tag,
        movement_cents: 0,
      });
    }
    xoroSum.get(k).movement_cents += b.movement_cents;
  }

  const variances = [];
  const seen = new Set();
  for (const [k, t] of tangSum) {
    seen.add(k);
    const x = xoroSum.get(k);
    const xoro_cents = x ? x.movement_cents : 0;
    const variance_cents = t.movement_cents - xoro_cents;
    variances.push({
      gl_account_id: t.gl_account_id,
      source_tag: t.source_tag,
      tangerine_amount_cents: t.movement_cents,
      xoro_amount_cents: xoro_cents,
      variance_amount_cents: variance_cents,
    });
  }
  // Xoro-only accounts (mirror posted to an account Tangerine never touched).
  for (const [k, x] of xoroSum) {
    if (seen.has(k)) continue;
    variances.push({
      gl_account_id: x.gl_account_id,
      source_tag: x.source_tag || "xoro_mirror",
      tangerine_amount_cents: 0,
      xoro_amount_cents: x.movement_cents,
      variance_amount_cents: -x.movement_cents,
    });
  }
  return variances;
}

/**
 * Apply the per-row + per-domain thresholds. Returns {variances_with_status, summary}.
 *   per-row:    |variance| <  $5   → status 'within'
 *               |variance| >= $5   → status 'over'
 *   per-domain: SUM(|over-variances|) >  $25 → run status 'variance'
 *               (all-within or sum below)   → run status 'clean'
 */
export function applyThresholds(variances, thresholds = GL_THRESHOLDS) {
  let total_variance_cents = 0;
  let over_count = 0;
  const out = variances.map((v) => {
    const abs = Math.abs(v.variance_amount_cents);
    const status = abs >= thresholds.per_row_cents ? "over" : "within";
    if (status === "over") {
      over_count += 1;
      total_variance_cents += abs;
    }
    return { ...v, status };
  });
  const run_status =
    total_variance_cents > thresholds.per_domain_cents ? "variance" : "clean";
  return {
    variances_with_status: out,
    summary: {
      rows_compared: out.length,
      variances_found: over_count,
      total_variance_cents,
      run_status,
      per_row_threshold_cents: thresholds.per_row_cents,
      per_domain_threshold_cents: thresholds.per_domain_cents,
    },
  };
}

/**
 * Look up the latest recon_runs row per sub-ledger domain for the same
 * (entity, period) window. Returns a Map<domain, status> covering the 4
 * non-GL domains. Missing rows are simply absent from the map (the
 * auto-categorization check is "all 4 present AND all status='clean'").
 *
 * The check is strict — both period_start AND period_end must match the
 * GL run's bounds. Operator-triggered ad-hoc reruns over a custom window
 * naturally won't trigger the auto-categorization unless the sibling
 * domains were also re-run on the same window.
 */
export async function readSiblingDomainStatuses({ admin, entity_id, period_start, period_end }) {
  const out = new Map();
  for (const domain of SUBLEDGER_DOMAINS) {
    const { data, error } = await admin
      .from("recon_runs")
      .select("status, completed_at")
      .eq("entity_id", entity_id)
      .eq("domain", domain)
      .eq("period_start", period_start)
      .eq("period_end", period_end)
      .order("completed_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) continue;
    out.set(domain, data.status || null);
  }
  return out;
}

/**
 * Return true iff ALL 4 sub-ledger domains have a recon row in this
 * window AND every status is 'clean'. That's the trigger for tagging
 * over-threshold GL variances with notes='missing_standalone_je'.
 */
export function shouldFlagMissingStandaloneJe(siblingStatuses) {
  if (!(siblingStatuses instanceof Map)) return false;
  if (siblingStatuses.size !== SUBLEDGER_DOMAINS.length) return false;
  for (const domain of SUBLEDGER_DOMAINS) {
    if (siblingStatuses.get(domain) !== "clean") return false;
  }
  return true;
}

/**
 * Tag over-status variances with the missing_standalone_je note when the
 * 4 sub-ledger domains are all clean. Within-status rows aren't tagged —
 * they aren't surfaced in the queue and don't need a category hint.
 */
export function tagMissingStandaloneJe(variances_with_status, sibling_all_clean) {
  if (!sibling_all_clean) return variances_with_status;
  return variances_with_status.map((v) => {
    if (v.status !== "over") return v;
    return { ...v, notes: MISSING_STANDALONE_NOTE };
  });
}

/**
 * Insert N recon_variances rows in one batch. Only rows with non-zero
 * variance OR a non-within status are persisted — within-rows with $0
 * variance aren't interesting for the queue.
 */
async function persistVariances(admin, recon_run_id, variances_with_status) {
  const toInsert = variances_with_status
    .filter((v) => v.variance_amount_cents !== 0)
    .map((v) => ({
      recon_run_id,
      source_table: "journal_entry_lines",
      source_id: v.gl_account_id || "",
      source_tag: v.source_tag,
      tangerine_amount_cents: v.tangerine_amount_cents,
      xoro_amount_cents: v.xoro_amount_cents,
      variance_amount_cents: v.variance_amount_cents,
      status: v.status,
      notes: v.notes || null,
    }));
  if (toInsert.length === 0) return { inserted: 0, error: null };
  const { error } = await admin.from("recon_variances").insert(toInsert);
  if (error) return { inserted: 0, error: error.message };
  return { inserted: toInsert.length, error: null };
}

/**
 * Main entry point. See module header for the contract.
 */
export async function runGlReconciliation({
  admin,
  entity_id,
  period_start,
  period_end,
  cadence = "weekly",
  replay_of_id = null,
}) {
  const result = {
    recon_run_id: null,
    status: "error",
    rows_compared: 0,
    variances_found: 0,
    total_variance_cents: 0,
    totals_jsonb: {},
    errors: [],
  };

  const v = validateArgs({ entity_id, period_start, period_end, cadence, replay_of_id });
  if (v.error) {
    result.errors.push({ scope: "args", reason: v.error });
    return result;
  }
  const args = v.data;

  // 1. INSERT recon_runs row with status='running'.
  const todayIso = new Date().toISOString().slice(0, 10);
  let recon_run_id;
  try {
    const { data, error } = await admin
      .from("recon_runs")
      .insert({
        entity_id: args.entity_id,
        domain: "gl",
        run_date: todayIso,
        period_start: args.period_start,
        period_end: args.period_end,
        cadence: args.cadence,
        status: "running",
        started_at: new Date().toISOString(),
        replay_of_id: args.replay_of_id,
        totals_jsonb: {},
      })
      .select("id")
      .single();
    if (error) {
      result.errors.push({ scope: "recon_runs_insert", reason: error.message });
      return result;
    }
    recon_run_id = data.id;
    result.recon_run_id = recon_run_id;
  } catch (err) {
    result.errors.push({ scope: "recon_runs_insert", reason: err?.message || String(err) });
    return result;
  }

  // 2. Pull GL movement (both sides — Tangerine truth + xoro_mirror
  //    summary lines all live in the same journal_entry_lines table).
  const move = await fetchGlMovement({
    admin,
    entity_id: args.entity_id,
    period_start: args.period_start,
    period_end: args.period_end,
  });
  if (move.error) {
    result.errors.push({ scope: "gl_fetch", reason: move.error });
    await markRunErrored(admin, recon_run_id, result.errors);
    return result;
  }

  // 3. Bucket + split + match.
  const allBuckets = bucketByAccount(move.rows);
  const { tang, xoro } = splitBuckets(allBuckets);
  const variances = matchBuckets(tang, xoro);
  const { variances_with_status, summary } = applyThresholds(variances);

  // 4. Read sibling domain statuses and auto-tag missing_standalone_je
  //    on over-rows when AP/AR/Cash/Inventory are all clean.
  let siblingStatuses = new Map();
  let sibling_all_clean = false;
  try {
    siblingStatuses = await readSiblingDomainStatuses({
      admin,
      entity_id: args.entity_id,
      period_start: args.period_start,
      period_end: args.period_end,
    });
    sibling_all_clean = shouldFlagMissingStandaloneJe(siblingStatuses);
  } catch (err) {
    // Sibling lookup failure is a soft error — we still complete the
    // run and report the missing tag count as 0.
    result.errors.push({ scope: "sibling_lookup", reason: err?.message || String(err) });
  }
  const taggedVariances = tagMissingStandaloneJe(variances_with_status, sibling_all_clean);
  const missing_standalone_je_count = taggedVariances.filter(
    (vv) => vv.notes === MISSING_STANDALONE_NOTE,
  ).length;

  // 5. Persist variances.
  const persisted = await persistVariances(admin, recon_run_id, taggedVariances);
  if (persisted.error) {
    result.errors.push({ scope: "recon_variances_insert", reason: persisted.error });
    await markRunErrored(admin, recon_run_id, result.errors);
    return result;
  }

  // 6. Update recon_runs row with totals + final status.
  const sibling_statuses_jsonb = {};
  for (const [k, val] of siblingStatuses) sibling_statuses_jsonb[k] = val;

  const totals_jsonb = {
    rows_compared: summary.rows_compared,
    variances_found: summary.variances_found,
    total_variance_cents: summary.total_variance_cents,
    per_row_threshold_cents: summary.per_row_threshold_cents,
    per_domain_threshold_cents: summary.per_domain_threshold_cents,
    gl_lines_pulled: move.rows.length,
    missing_standalone_je_count,
    sibling_all_clean,
    sibling_statuses: sibling_statuses_jsonb,
    errors_count: result.errors.length,
  };
  try {
    const { error } = await admin
      .from("recon_runs")
      .update({
        status: summary.run_status,
        completed_at: new Date().toISOString(),
        totals_jsonb,
      })
      .eq("id", recon_run_id);
    if (error) {
      result.errors.push({ scope: "recon_runs_update", reason: error.message });
      // Don't return early — comparison + persistence already happened.
    }
  } catch (err) {
    result.errors.push({ scope: "recon_runs_update", reason: err?.message || String(err) });
  }

  result.status = summary.run_status;
  result.rows_compared = summary.rows_compared;
  result.variances_found = summary.variances_found;
  result.total_variance_cents = summary.total_variance_cents;
  result.totals_jsonb = totals_jsonb;
  return result;
}

async function markRunErrored(admin, recon_run_id, errors) {
  try {
    await admin
      .from("recon_runs")
      .update({
        status: "error",
        completed_at: new Date().toISOString(),
        totals_jsonb: { errors_count: errors.length, errors_sample: errors.slice(0, 5) },
      })
      .eq("id", recon_run_id);
  } catch {
    // best-effort — the caller already has the errors in result.errors.
  }
}

export const __test_only__ = {
  GL_THRESHOLDS,
  SUBLEDGER_DOMAINS,
  MISSING_STANDALONE_NOTE,
  fetchGlMovement,
  persistVariances,
  markRunErrored,
};
