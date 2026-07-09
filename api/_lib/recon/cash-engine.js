// api/_lib/recon/cash-engine.js
//
// Tangerine P9-4 — Parallel-Run Cash reconciliation engine.
//
// Mirrors the P9-2 (AP) + P9-3 (AR) engines for the cash domain. Compares
// Tangerine `bank_transactions` (the P6 bank-feed: Plaid + manual + CSV
// entries) against the Xoro shadow side for an operator-supplied period
// window, writes one recon_runs row + N recon_variances rows per
// unmatched bank transaction, and finalizes the run with totals_jsonb
// summary + clean/variance status.
//
// ── Operator-confirmed decisions (per task spec) ────────────────────────
//   D1  cadence          : weekly default; manual + replay supported
//   D2  threshold        : $0.50 per row (50 cents) — LOCKED
//                          $3.00 per domain (300 cents ceiling) — LOCKED
//                          (very tight: cash matches need to be near-perfect)
//   D7  source_tag-aware : bank_transactions.source is one of
//                          ('plaid','csv_upload','manual'); for variance
//                          rollup we MAP plaid → 'plaid_sync',
//                          csv_upload → 'xoro_mirror' (legacy cash imports
//                          land here), manual → 'manual'. The mapping
//                          mirrors the T10 source enum the AP/AR engines
//                          use so dashboards can group by the same tag.
//   D11 replay support   : runs with cadence='replay' record replay_of_id
//                          on recon_runs, audit trail keeps both runs.
//
// ── Cash side limitations (read this before maintaining) ────────────────
// The Xoro side of Cash parity is the messiest of the five domains:
//
// 1. T10 (Xoro shadow mirror) does NOT currently expose a per-transaction
//    bank feed. There is no `bank_transactions` mirror — Xoro's cash
//    ledger lives inside its GL extract, which we don't reconcile at the
//    transaction grain.
//
// 2. The closest grain we DO have is the bank-feed itself: when CSV
//    bank imports were the legacy ingest path, those rows landed in
//    `bank_transactions` with source='csv_upload'. For parallel-run we
//    treat those `csv_upload` rows as the "Xoro side" (the historical
//    truth) and `plaid`/`manual` rows as the "Tangerine side" (the new
//    truth). Each side is bucketed by (bank_account_id, posted_date,
//    amount_cents) and matched within ±1 day to absorb posting-date
//    drift between feeds.
//
// 3. Until a richer Xoro cash feed exists, the engine ALSO compares
//    aggregated deposit totals from Xoro AR receipts
//    (ip_sales_history_wholesale net_amount summed per day) and
//    aggregated tanda_pos payments (xoro vendor bill cash) as a
//    secondary "sanity totals" check, recorded in totals_jsonb but NOT
//    written as recon_variances rows (the per-row threshold of $0.50 is
//    too tight to apply meaningfully to aggregated daily totals).
//
// 4. The engine handles the unmatched-bank-txn case as the primary
//    variance signal: any bank_transactions row inside the period that
//    can't be paired with an opposite-side row within ±1 day + same
//    bank_account + same absolute amount surfaces as a recon_variances
//    row. This is the cash-parity signal that's actionable today; the
//    daily-totals comparison is a "is anything dramatically off"
//    safety net.
//
// ── Period semantics ────────────────────────────────────────────────────
// period_start / period_end are inclusive ISO YYYY-MM-DD dates filtered
// on `bank_transactions.posted_date BETWEEN period_start AND period_end`.
// For ±1 day matching we still WIDEN the read by 1 day on each side so a
// Tangerine row posted on period_end can match an Xoro row posted on
// period_end + 1; only rows whose Tangerine-side posted_date is in
// [period_start, period_end] are evaluated, but their Xoro counterpart
// can land in [period_start-1, period_end+1].
//
// ── Matching rules ──────────────────────────────────────────────────────
// Key: (bank_account_id, ABS(amount_cents)).
// Tolerance: ±1 day on posted_date.
// Sign-aware: a $100 deposit on Tangerine matches a $100 deposit on
// Xoro, not a $100 withdrawal. We preserve sign by matching on
// amount_cents directly (not ABS).
//
// Greedy 1-to-1: each Xoro row consumes at most ONE Tangerine row and
// vice versa (so two same-day, same-amount Xoro rows can pair with two
// Tangerine rows, but a single Xoro can't double-cover two Tangerine
// rows). Ordering for greedy is by posted_date ASC then id ASC for
// determinism.
//
// ── Comparison output ───────────────────────────────────────────────────
// Per unmatched bank_transactions row we emit a recon_variances row:
//
//   source_table = 'bank_transactions'
//   source_id    = '<bank_transactions.id>'
//   source_tag   = mapped source (plaid_sync / xoro_mirror / manual)
//   tangerine_amount_cents = signed amount if Tangerine-side unmatched, else 0
//   xoro_amount_cents      = signed amount if Xoro-side unmatched, else 0
//   variance_amount_cents  = tangerine_amount_cents - xoro_amount_cents
//   status                 = 'within' if ABS <= per_row_threshold else 'over'
//
// ── Domain ceiling ──────────────────────────────────────────────────────
// SUM of ABS(variance_cents) across all 'over' rows is compared to the
// per_domain_threshold_cents (300c default = $3). If we cross it, the
// recon_runs.status flips to 'variance'. Otherwise 'clean'.
//
// ── Idempotency / replay ────────────────────────────────────────────────
// Append-only — every run is a fresh recon_runs INSERT (D11 replays
// record replay_of_id pointing back to the original; both rows survive
// for the audit trail).
//
// PUBLIC ENTRY: runCashReconciliation({admin, entity_id, period_start,
//   period_end, cadence?, replay_of_id?, now?}).
//
// BigInt cents throughout (no float drift on money). No external network
// calls other than supabase.

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Frozen per task spec — operator-locked thresholds.
export const CASH_THRESHOLDS = Object.freeze({
  per_row_cents: 50,   // $0.50 per row
  per_domain_cents: 300, // $3.00 per domain
});

// BigInt mirrors for the engine internals.
export const DEFAULT_PER_ROW_THRESHOLD_CENTS = 50n;     // $0.50
export const DEFAULT_PER_DOMAIN_THRESHOLD_CENTS = 300n; // $3.00

// bank_transactions.source enum → recon source_tag mapping.
//   plaid       → 'plaid_sync' (the canonical T10 tag for Plaid-sourced cash)
//   csv_upload  → 'xoro_mirror' (legacy CSV imports = historical Xoro truth)
//   xoro_mirror → 'xoro_mirror' (the register mirror — Xoro truth by
//                 construction; added with the bank-recon mirror build)
//   manual      → 'manual'
// Anything else falls through to 'manual_or_legacy' (defensive).
export function mapBankSourceToTag(raw) {
  if (raw === "plaid") return "plaid_sync";
  if (raw === "csv_upload" || raw === "xoro_mirror") return "xoro_mirror";
  if (raw === "manual") return "manual";
  return "manual_or_legacy";
}

// Classification: which side does this row belong to?
//   'tangerine' side = the new truth: plaid (bank feed) + manual
//   'xoro'      side = the historical truth: csv_upload (legacy imports)
//                      + xoro_mirror (the register mirror)
// (See module header §2 for the rationale.)
export function classifyBankRow(row) {
  if (!row || typeof row !== "object") return null;
  if (row.source === "csv_upload" || row.source === "xoro_mirror") return "xoro";
  if (row.source === "plaid" || row.source === "manual") return "tangerine";
  // Unknown source — bucket to tangerine so it still surfaces as a
  // variance if it has no Xoro counterpart.
  return "tangerine";
}

// ────────────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────────────

/**
 * Cast number / string / bigint / null → BigInt cents.
 * Rejects floats and non-integer strings. Returns 0n for null/undefined/"".
 */
export function toBigInt(v) {
  if (v == null || v === "") return 0n;
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    if (!Number.isInteger(v)) {
      throw new Error(`toBigInt: refusing non-integer number ${v}`);
    }
    return BigInt(v);
  }
  if (typeof v === "string") {
    if (!/^-?\d+$/.test(v)) {
      throw new Error(`toBigInt: refusing non-integer string "${v}"`);
    }
    return BigInt(v);
  }
  throw new Error(`toBigInt: unsupported type ${typeof v}`);
}

/** absolute value for BigInt */
export function absBig(b) {
  return b < 0n ? -b : b;
}

/** ISO YYYY-MM-DD validator */
export function isISODate(v) {
  if (typeof v !== "string" || !ISO_DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().startsWith(v);
}

/** Add `days` (signed integer) to an ISO YYYY-MM-DD; returns YYYY-MM-DD. */
export function addDaysISO(iso, days) {
  if (!isISODate(iso)) throw new Error(`addDaysISO: bad iso ${iso}`);
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Days between two ISO dates (b - a), integer. */
export function daysBetween(a, b) {
  const da = new Date(`${a}T00:00:00Z`).getTime();
  const db = new Date(`${b}T00:00:00Z`).getTime();
  return Math.round((db - da) / 86_400_000);
}

/**
 * Build the matching key for a bank_transactions row. Sign-preserving:
 * we key on (bank_account_id, amount_cents) so a $100 deposit doesn't
 * collide with a $100 withdrawal.
 */
export function buildMatchKey(bank_account_id, amount_cents) {
  return `${bank_account_id || ""}|${amount_cents.toString()}`;
}

/**
 * Partition raw bank_transactions rows into Tangerine-side and
 * Xoro-side lists per classifyBankRow().
 */
export function partitionRows(rows) {
  const tangerine = [];
  const xoro = [];
  for (const r of rows || []) {
    const side = classifyBankRow(r);
    if (side === "tangerine") tangerine.push(r);
    else if (side === "xoro") xoro.push(r);
  }
  return { tangerine, xoro };
}

/**
 * Greedy match Tangerine ↔ Xoro within ±toleranceDays.
 *
 * Algorithm:
 *   1. Bucket Xoro rows by matchKey = (bank_account_id, amount_cents).
 *   2. For each Tangerine row (sorted asc by posted_date, id), search
 *      the bucket for any Xoro row within ±toleranceDays whose match
 *      flag is still false.
 *   3. First eligible match wins (closest-date preference for ties).
 *   4. Both rows flip to matched.
 *
 * Returns:
 *   {
 *     matches:    [{tangerine, xoro, day_delta}],
 *     unmatchedTangerine: [...],
 *     unmatchedXoro:      [...],
 *   }
 */
export function matchWithinTolerance(tangerineRows, xoroRows, toleranceDays = 1) {
  // Bucket xoro by match key.
  const xoroBuckets = new Map(); // key → [rows]
  for (const x of xoroRows) {
    const cents = toBigInt(x.amount_cents);
    const k = buildMatchKey(x.bank_account_id, cents);
    if (!xoroBuckets.has(k)) xoroBuckets.set(k, []);
    xoroBuckets.get(k).push({ row: x, cents, taken: false });
  }

  const sortedTan = [...tangerineRows].sort((a, b) => {
    if (a.posted_date < b.posted_date) return -1;
    if (a.posted_date > b.posted_date) return 1;
    return String(a.id).localeCompare(String(b.id));
  });

  const matches = [];
  const unmatchedTangerine = [];
  for (const t of sortedTan) {
    const tCents = toBigInt(t.amount_cents);
    const k = buildMatchKey(t.bank_account_id, tCents);
    const bucket = xoroBuckets.get(k);
    if (!bucket || bucket.length === 0) {
      unmatchedTangerine.push(t);
      continue;
    }
    // Find the closest-date unmatched row in the bucket within tolerance.
    let bestIdx = -1;
    let bestAbsDelta = Infinity;
    for (let i = 0; i < bucket.length; i++) {
      const slot = bucket[i];
      if (slot.taken) continue;
      const delta = daysBetween(slot.row.posted_date, t.posted_date);
      const abs = Math.abs(delta);
      if (abs <= toleranceDays && abs < bestAbsDelta) {
        bestAbsDelta = abs;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) {
      unmatchedTangerine.push(t);
      continue;
    }
    const slot = bucket[bestIdx];
    slot.taken = true;
    matches.push({
      tangerine: t,
      xoro: slot.row,
      day_delta: daysBetween(slot.row.posted_date, t.posted_date),
    });
  }

  const unmatchedXoro = [];
  for (const bucket of xoroBuckets.values()) {
    for (const slot of bucket) {
      if (!slot.taken) unmatchedXoro.push(slot.row);
    }
  }

  return { matches, unmatchedTangerine, unmatchedXoro };
}

/**
 * Build variance rows for the unmatched bank transactions from each side.
 *
 * Tangerine-side unmatched → tangerine_amount = signed cents, xoro = 0,
 *                            variance = +tangerine.
 * Xoro-side unmatched      → xoro_amount = signed cents, tangerine = 0,
 *                            variance = -xoro.
 */
export function buildVarianceRows({
  unmatchedTangerine,
  unmatchedXoro,
  perRowThresholdCents,
}) {
  const out = [];
  for (const t of unmatchedTangerine) {
    const cents = toBigInt(t.amount_cents);
    const variance = cents;
    const absVar = absBig(variance);
    const status = absVar <= perRowThresholdCents ? "within" : "over";
    out.push({
      bank_transaction_id: t.id,
      side: "tangerine_only",
      bank_account_id: t.bank_account_id || null,
      posted_date: t.posted_date,
      source_tag: mapBankSourceToTag(t.source),
      tangerine_amount_cents: cents,
      xoro_amount_cents: 0n,
      variance_amount_cents: variance,
      status,
    });
  }
  for (const x of unmatchedXoro) {
    const cents = toBigInt(x.amount_cents);
    const variance = -cents;
    const absVar = absBig(variance);
    const status = absVar <= perRowThresholdCents ? "within" : "over";
    out.push({
      bank_transaction_id: x.id,
      side: "xoro_only",
      bank_account_id: x.bank_account_id || null,
      posted_date: x.posted_date,
      source_tag: mapBankSourceToTag(x.source),
      tangerine_amount_cents: 0n,
      xoro_amount_cents: cents,
      variance_amount_cents: variance,
      status,
    });
  }
  // Deterministic ordering for test stability + reproducible inserts.
  out.sort((a, b) => {
    if (a.posted_date < b.posted_date) return -1;
    if (a.posted_date > b.posted_date) return 1;
    return String(a.bank_transaction_id).localeCompare(String(b.bank_transaction_id));
  });
  return out;
}

/**
 * Compose the totals_jsonb payload written to recon_runs.totals_jsonb on
 * completion.
 */
export function composeTotals({
  varianceRows,
  matchCount,
  tangerinePulledCount,
  xoroPulledCount,
  perRowThresholdCents,
  perDomainThresholdCents,
  sanity = {},
}) {
  let rowsCompared = 0;
  let variancesFound = 0;
  let totalAbsVarianceCents = 0n;
  let totalTangerineCents = 0n;
  let totalXoroCents = 0n;
  const perSourceTag = {};
  for (const v of varianceRows) {
    rowsCompared += 1;
    totalTangerineCents += v.tangerine_amount_cents;
    totalXoroCents += v.xoro_amount_cents;
    if (v.status === "over") {
      variancesFound += 1;
      totalAbsVarianceCents += absBig(v.variance_amount_cents);
    }
    if (!perSourceTag[v.source_tag]) {
      perSourceTag[v.source_tag] = {
        rows_compared: 0,
        variances_found: 0,
        total_abs_variance_cents: "0",
        total_tangerine_cents: "0",
        total_xoro_cents: "0",
      };
    }
    const slot = perSourceTag[v.source_tag];
    slot.rows_compared += 1;
    slot.total_tangerine_cents = (
      BigInt(slot.total_tangerine_cents) + v.tangerine_amount_cents
    ).toString();
    slot.total_xoro_cents = (
      BigInt(slot.total_xoro_cents) + v.xoro_amount_cents
    ).toString();
    if (v.status === "over") {
      slot.variances_found += 1;
      slot.total_abs_variance_cents = (
        BigInt(slot.total_abs_variance_cents) + absBig(v.variance_amount_cents)
      ).toString();
    }
  }
  const ceilingCrossed = totalAbsVarianceCents > perDomainThresholdCents;
  return {
    rows_compared: rowsCompared,
    variances_found: variancesFound,
    matches_found: matchCount,
    tangerine_rows_pulled: tangerinePulledCount,
    xoro_rows_pulled: xoroPulledCount,
    total_abs_variance_cents: totalAbsVarianceCents.toString(),
    total_tangerine_cents: totalTangerineCents.toString(),
    total_xoro_cents: totalXoroCents.toString(),
    per_row_threshold_cents: perRowThresholdCents.toString(),
    per_domain_threshold_cents: perDomainThresholdCents.toString(),
    domain_threshold_crossed: ceilingCrossed,
    per_source_tag: perSourceTag,
    sanity,
  };
}

/**
 * Decide the final recon_runs.status based on totals.
 *
 *   variances_found = 0                    → 'clean'
 *   variances_found > 0                    → 'variance'
 *
 * Ceiling crossing surfaces via totals_jsonb.domain_threshold_crossed
 * for the dashboard (still 'variance' either way).
 */
export function decideRunStatus(totals) {
  if (!totals || !totals.variances_found || totals.variances_found === 0) {
    return "clean";
  }
  return "variance";
}

// ────────────────────────────────────────────────────────────────────────
// Supabase IO
// ────────────────────────────────────────────────────────────────────────

/** Insert the recon_runs row in 'running' state. */
export async function insertReconRun(admin, params) {
  const row = {
    entity_id: params.entity_id,
    domain: "cash",
    run_date: params.now.slice(0, 10),
    period_start: params.period_start,
    period_end: params.period_end,
    cadence: params.cadence || "weekly",
    status: "running",
    started_at: params.now,
    totals_jsonb: {},
    replay_of_id: params.replay_of_id || null,
  };
  const { data, error } = await admin
    .from("recon_runs")
    .insert(row)
    .select("id")
    .single();
  return { id: data?.id || null, error };
}

/** Update recon_runs row with final status + totals + completed_at. */
export async function finalizeReconRun(admin, run_id, patch) {
  const { error } = await admin
    .from("recon_runs")
    .update(patch)
    .eq("id", run_id);
  return { error };
}

/**
 * Pull bank_transactions for the period (widened by toleranceDays on
 * each side so the matcher can see ±N day neighbours).
 */
export async function loadBankTransactions(admin, { entity_id, period_start, period_end, toleranceDays = 1 }) {
  const widenedStart = addDaysISO(period_start, -toleranceDays);
  const widenedEnd = addDaysISO(period_end, toleranceDays);
  const { data, error } = await admin
    .from("bank_transactions")
    .select("id, entity_id, bank_account_id, source, posted_date, amount_cents, external_txn_id, status")
    .eq("entity_id", entity_id)
    .gte("posted_date", widenedStart)
    .lte("posted_date", widenedEnd);
  if (error) return { rows: [], error };
  return { rows: data || [], error: null };
}

/**
 * Sanity totals from secondary Xoro-side feeds (AR receipts + tanda_pos
 * payments). Recorded in totals_jsonb.sanity for dashboard use; NOT
 * promoted to recon_variances (per-row $0.50 threshold is too tight to
 * apply to aggregated daily totals — see module header §3).
 *
 * Both reads are best-effort: failures are recorded as warnings, not
 * fatal errors.
 */
export async function loadXoroSanityTotals(admin, { period_start, period_end }) {
  const warnings = [];
  let arReceiptCents = 0n;
  let apPaymentCents = 0n;
  try {
    const { data, error } = await admin
      .from("ip_sales_history_wholesale")
      .select("net_amount, txn_date")
      .gte("txn_date", period_start)
      .lte("txn_date", period_end);
    if (error) {
      warnings.push({ scope: "ar_receipts", reason: error.message });
    } else {
      for (const r of data || []) {
        const n = Number(r.net_amount);
        if (Number.isFinite(n)) arReceiptCents += BigInt(Math.round(n * 100));
      }
    }
  } catch (e) {
    warnings.push({ scope: "ar_receipts", reason: e?.message || String(e) });
  }
  try {
    const { data, error } = await admin
      .from("tanda_pos")
      .select("total_amount_cents, po_date")
      .gte("po_date", period_start)
      .lte("po_date", period_end);
    if (error) {
      warnings.push({ scope: "tanda_pos", reason: error.message });
    } else {
      for (const r of data || []) {
        if (r.total_amount_cents != null) {
          try { apPaymentCents += toBigInt(r.total_amount_cents); } catch { /* skip */ }
        }
      }
    }
  } catch (e) {
    warnings.push({ scope: "tanda_pos", reason: e?.message || String(e) });
  }
  return {
    ar_receipts_total_cents: arReceiptCents.toString(),
    ap_payments_total_cents: apPaymentCents.toString(),
    warnings,
  };
}

/** INSERT all recon_variances rows in one batch. */
export async function insertVariances(admin, run_id, varianceRows) {
  if (!varianceRows.length) return { inserted: 0, error: null };
  const rows = varianceRows.map((v) => ({
    recon_run_id: run_id,
    source_table: "bank_transactions",
    source_id: v.bank_transaction_id ? String(v.bank_transaction_id) : "",
    source_tag: v.source_tag,
    tangerine_amount_cents: v.tangerine_amount_cents.toString(),
    xoro_amount_cents: v.xoro_amount_cents.toString(),
    variance_amount_cents: v.variance_amount_cents.toString(),
    status: v.status,
  }));
  const { error } = await admin.from("recon_variances").insert(rows);
  return { inserted: error ? 0 : rows.length, error };
}

// ────────────────────────────────────────────────────────────────────────
// Public entry point
// ────────────────────────────────────────────────────────────────────────

/**
 * Run a Cash reconciliation for the given period.
 *
 * @param {Object}   args
 * @param {Object}   args.admin            service-role supabase client
 * @param {string}   args.entity_id        tangerine entity uuid
 * @param {string}   args.period_start     inclusive ISO YYYY-MM-DD
 * @param {string}   args.period_end       inclusive ISO YYYY-MM-DD
 * @param {string}   [args.cadence]        'weekly' (default) | 'manual' | 'replay'
 * @param {string}   [args.replay_of_id]   recon_runs.id this run replays (D11)
 * @param {string}   [args.now]            ISO timestamp override (test injection)
 * @param {bigint}   [args.per_row_threshold_cents]    override default (50n)
 * @param {bigint}   [args.per_domain_threshold_cents] override default (300n)
 * @param {number}   [args.tolerance_days] ±N day match tolerance (default 1)
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   recon_run_id: string|null,
 *   status: 'clean'|'variance'|'error',
 *   summary: object,
 *   errors: Array<{kind:string, message?:string}>,
 * }>}
 */
export async function runCashReconciliation(args) {
  const {
    admin,
    entity_id,
    period_start,
    period_end,
    cadence = "weekly",
    replay_of_id = null,
    now: nowOverride,
    per_row_threshold_cents = DEFAULT_PER_ROW_THRESHOLD_CENTS,
    per_domain_threshold_cents = DEFAULT_PER_DOMAIN_THRESHOLD_CENTS,
    tolerance_days = 1,
  } = args || {};

  const errors = [];
  const summary = {
    rows_compared: 0,
    variances_found: 0,
    total_abs_variance_cents: "0",
    domain_threshold_crossed: false,
  };

  // ── validation ─────────────────────────────────────────────────────
  if (!admin) {
    return { ok: false, recon_run_id: null, status: "error", summary, errors: [{ kind: "bad_admin", message: "admin is required" }] };
  }
  if (!entity_id || typeof entity_id !== "string" || !UUID_RE.test(entity_id)) {
    return { ok: false, recon_run_id: null, status: "error", summary, errors: [{ kind: "bad_entity", message: "entity_id (uuid) is required" }] };
  }
  if (!isISODate(period_start)) {
    return { ok: false, recon_run_id: null, status: "error", summary, errors: [{ kind: "bad_period_start", message: `period_start '${period_start}' is not YYYY-MM-DD` }] };
  }
  if (!isISODate(period_end)) {
    return { ok: false, recon_run_id: null, status: "error", summary, errors: [{ kind: "bad_period_end", message: `period_end '${period_end}' is not YYYY-MM-DD` }] };
  }
  if (period_end < period_start) {
    return { ok: false, recon_run_id: null, status: "error", summary, errors: [{ kind: "bad_period_order", message: "period_end is before period_start" }] };
  }
  if (!["weekly", "manual", "replay"].includes(cadence)) {
    return { ok: false, recon_run_id: null, status: "error", summary, errors: [{ kind: "bad_cadence", message: `cadence '${cadence}' is not in (weekly, manual, replay)` }] };
  }
  if (replay_of_id != null && (typeof replay_of_id !== "string" || !UUID_RE.test(replay_of_id))) {
    return { ok: false, recon_run_id: null, status: "error", summary, errors: [{ kind: "bad_replay_of_id", message: "replay_of_id must be a uuid" }] };
  }
  if (!Number.isInteger(tolerance_days) || tolerance_days < 0 || tolerance_days > 30) {
    return { ok: false, recon_run_id: null, status: "error", summary, errors: [{ kind: "bad_tolerance_days", message: "tolerance_days must be integer 0..30" }] };
  }

  const now = nowOverride || new Date().toISOString();

  // ── 1. open the recon_runs row ────────────────────────────────────
  const { id: run_id, error: insertErr } = await insertReconRun(admin, {
    entity_id,
    period_start,
    period_end,
    cadence,
    replay_of_id,
    now,
  });
  if (insertErr || !run_id) {
    return {
      ok: false,
      recon_run_id: null,
      status: "error",
      summary,
      errors: [{ kind: "recon_run_insert_failed", message: insertErr?.message || "no id returned" }],
    };
  }

  try {
    // ── 2. load bank_transactions (period widened by tolerance) ──────
    const { rows: bankRows, error: bankErr } = await loadBankTransactions(admin, {
      entity_id,
      period_start,
      period_end,
      toleranceDays: tolerance_days,
    });
    if (bankErr) {
      errors.push({ kind: "bank_transactions_read_failed", message: bankErr.message });
      await finalizeReconRun(admin, run_id, {
        status: "error",
        completed_at: now,
        totals_jsonb: { errors },
      });
      return { ok: false, recon_run_id: run_id, status: "error", summary, errors };
    }

    // ── 3. partition + match within ±N days ─────────────────────────
    const { tangerine, xoro } = partitionRows(bankRows);
    // Restrict the "primary" tangerine set to rows posted INSIDE the
    // period (the widened window is only there to give matches a
    // chance — we don't surface variances for rows outside the
    // period because those belong to neighbouring runs).
    const tangerineInPeriod = tangerine.filter(
      (r) => r.posted_date >= period_start && r.posted_date <= period_end,
    );
    const xoroInPeriod = xoro.filter(
      (r) => r.posted_date >= period_start && r.posted_date <= period_end,
    );
    // Matching set still uses the WIDENED side for the opposite side
    // (i.e. a Tangerine row inside period can match an Xoro row in
    // the ±tolerance widened window). We do this by passing the
    // widened xoro list to matchWithinTolerance for tangerineInPeriod,
    // then doing a second pass for xoroInPeriod against the widened
    // tangerine list.
    const passA = matchWithinTolerance(tangerineInPeriod, xoro, tolerance_days);
    // Anything in xoroInPeriod that wasn't taken in passA matches against
    // the still-unused tangerine rows from the widened set.
    const usedXoroIds = new Set(passA.matches.map((m) => m.xoro.id));
    const remainingXoroInPeriod = xoroInPeriod.filter((x) => !usedXoroIds.has(x.id));
    const passB = matchWithinTolerance(remainingXoroInPeriod, tangerine, tolerance_days);
    const matchCount = passA.matches.length + passB.matches.length;

    // Unmatched on each side, RESTRICTED to in-period rows (so we don't
    // emit variances for the widened-window neighbours).
    const unmatchedTangerine = passA.unmatchedTangerine;
    // For passB, unmatchedTangerine is actually the unmatched-xoro side
    // (passB ran with xoro as the "tangerine" argument). Pull the actual
    // unmatched-from-passB-xoro-side:
    const unmatchedXoroRaw = passB.unmatchedTangerine; // because we called with xoro as 1st arg
    // Filter to keep only rows whose posted_date is in [period_start, period_end].
    const unmatchedXoro = unmatchedXoroRaw.filter(
      (r) => r.posted_date >= period_start && r.posted_date <= period_end,
    );

    // ── 4. build variance rows ──────────────────────────────────────
    const varianceRows = buildVarianceRows({
      unmatchedTangerine,
      unmatchedXoro,
      perRowThresholdCents: per_row_threshold_cents,
    });

    // ── 5. insert variances ─────────────────────────────────────────
    const { error: varErr } = await insertVariances(admin, run_id, varianceRows);
    if (varErr) {
      errors.push({ kind: "variances_insert_failed", message: varErr.message });
      await finalizeReconRun(admin, run_id, {
        status: "error",
        completed_at: now,
        totals_jsonb: { errors },
      });
      return { ok: false, recon_run_id: run_id, status: "error", summary, errors };
    }

    // ── 6. sanity totals (best-effort; never fails the run) ─────────
    const sanity = await loadXoroSanityTotals(admin, { period_start, period_end });

    // ── 7. compose totals + finalize ────────────────────────────────
    const totals = composeTotals({
      varianceRows,
      matchCount,
      tangerinePulledCount: tangerine.length,
      xoroPulledCount: xoro.length,
      perRowThresholdCents: per_row_threshold_cents,
      perDomainThresholdCents: per_domain_threshold_cents,
      sanity,
    });
    if (errors.length) totals.errors = errors;

    const status = decideRunStatus(totals);
    const { error: finErr } = await finalizeReconRun(admin, run_id, {
      status,
      completed_at: now,
      totals_jsonb: totals,
    });
    if (finErr) {
      errors.push({ kind: "recon_run_finalize_failed", message: finErr.message });
      return { ok: false, recon_run_id: run_id, status: "error", summary: totals, errors };
    }

    return {
      ok: true,
      recon_run_id: run_id,
      status,
      summary: totals,
      errors,
    };
  } catch (e) {
    errors.push({ kind: "engine_threw", message: e instanceof Error ? e.message : String(e) });
    await finalizeReconRun(admin, run_id, {
      status: "error",
      completed_at: now,
      totals_jsonb: { errors },
    }).catch(() => {});
    return { ok: false, recon_run_id: run_id, status: "error", summary, errors };
  }
}
