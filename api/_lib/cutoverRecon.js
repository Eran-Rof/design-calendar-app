// api/_lib/cutoverRecon.js
//
// Pure, side-effect-free helpers for the Cutover Reconciliation report
// (GET /api/internal/cutover-recon). The handler runs one bounded set-based
// SQL per domain that returns a FULL-OUTER-JOIN of the native (Tangerine
// operational tables) side vs the mirror (Xoro feed) side, one row per key,
// each row carrying { native_present, mirror_present, native_value,
// mirror_value, native_status, mirror_status }. These helpers then classify
// every row, tally the domain, decide PASS/FAIL, and cap the variance list.
//
// Everything here is pure so it can be unit-tested without a DB (see
// api/_lib/__tests__/cutoverRecon.test.js). Keeping the classification in JS
// (rather than in SQL) means the *definition* of a variance is one place,
// exercised by tests, identical across all six domains.

/** Variance classifications. A row is one of these five. */
export const KIND = Object.freeze({
  MATCH: "match", // both sides present and tied within tolerance
  MISSING_IN_MIRROR: "missing_in_mirror", // in Tangerine, absent from the Xoro mirror
  MISSING_IN_NATIVE: "missing_in_native", // in the Xoro mirror, absent from Tangerine
  VALUE_MISMATCH: "value_mismatch", // both present, metric differs beyond tolerance
  STATUS_MISMATCH: "status_mismatch", // both present, status label differs
});

/** Per-domain report status. `unavailable` = the mirror lacks the data to tie. */
export const STATUS = Object.freeze({
  PASS: "pass",
  FAIL: "fail",
  UNAVAILABLE: "unavailable",
});

const num = (v) => {
  if (v === null || v === undefined || v === "") return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

const truthy = (v) => v === true || v === "t" || v === "true" || v === 1 || v === "1";

/**
 * Classify a single FULL-OUTER-JOIN row.
 *
 * @param {object} row - { native_present, mirror_present, native_value,
 *   mirror_value, native_status, mirror_status }
 * @param {object} [opts]
 * @param {number} [opts.tolerance=0] - abs(native_value - mirror_value) must
 *   exceed this to count as a value mismatch (absorbs rounding / cents jitter).
 * @param {boolean} [opts.compareStatus=false] - when both present, an unequal
 *   status label is flagged as STATUS_MISMATCH (takes precedence over value).
 * @returns {string} one of KIND.*
 */
export function classifyRow(row, opts = {}) {
  const { tolerance = 0, compareStatus = false } = opts;
  const nat = truthy(row.native_present);
  const mir = truthy(row.mirror_present);
  if (nat && !mir) return KIND.MISSING_IN_MIRROR;
  if (!nat && mir) return KIND.MISSING_IN_NATIVE;
  if (!nat && !mir) return KIND.MATCH; // defensive — should never be emitted
  if (compareStatus) {
    const ns = (row.native_status ?? "").toString();
    const ms = (row.mirror_status ?? "").toString();
    if (ns !== ms) return KIND.STATUS_MISMATCH;
  }
  if (Math.abs(num(row.native_value) - num(row.mirror_value)) > num(tolerance)) {
    return KIND.VALUE_MISMATCH;
  }
  return KIND.MATCH;
}

/** Tally an array of classified rows into per-kind counts (+ variance total). */
export function tallyKinds(classified) {
  const counts = {
    total: classified.length,
    match: 0,
    missing_in_mirror: 0,
    missing_in_native: 0,
    value_mismatch: 0,
    status_mismatch: 0,
    variances: 0,
  };
  for (const r of classified) {
    const k = r.kind;
    if (k in counts) counts[k] += 1;
    if (k !== KIND.MATCH) counts.variances += 1;
  }
  return counts;
}

/**
 * Decide PASS/FAIL from a variance count. The report's whole purpose is to
 * "watch gaps burn to zero" — so by default ANY variance is a FAIL, and the
 * card goes green only when the count reaches (<=) `threshold`.
 */
export function decideStatus(varianceCount, opts = {}) {
  const { threshold = 0 } = opts;
  return num(varianceCount) > num(threshold) ? STATUS.FAIL : STATUS.PASS;
}

/**
 * Cap a variance list to `cap` rows (deterministic: sort by descending
 * absolute value gap, then key) while still reporting the true total.
 *
 * @returns {{ shown: object[], total: number, truncated: boolean }}
 */
export function capVariances(variances, cap = 200) {
  const total = variances.length;
  const sorted = [...variances].sort((a, b) => {
    const ga = Math.abs(num(a.native_value) - num(a.mirror_value));
    const gb = Math.abs(num(b.native_value) - num(b.mirror_value));
    if (gb !== ga) return gb - ga;
    return String(a.key ?? "").localeCompare(String(b.key ?? ""));
  });
  const shown = cap > 0 ? sorted.slice(0, cap) : sorted;
  return { shown, total, truncated: total > shown.length };
}

/**
 * Build one full domain section from raw FULL-OUTER-JOIN rows.
 *
 * @param {object} args
 * @param {string} args.domain - stable id, e.g. "sales_orders"
 * @param {string} args.label - human title, e.g. "Sales Orders"
 * @param {object[]} args.rows - raw join rows (see classifyRow)
 * @param {number} [args.tolerance=0]
 * @param {boolean} [args.compareStatus=false]
 * @param {number} [args.cap=200]
 * @param {number} [args.threshold=0] - variance count allowed while still PASS
 * @param {object} [args.headline_metrics] - domain headline object (merged as-is)
 * @param {string} [args.note] - human note (e.g. why a domain is unavailable)
 * @param {boolean} [args.unavailable=false] - mirror can't tie; force UNAVAILABLE
 * @returns {object} section: { domain, label, status, headline_metrics, counts,
 *   variances, variance_total, truncated, note }
 */
export function buildSection(args) {
  const {
    domain,
    label,
    rows = [],
    tolerance = 0,
    compareStatus = false,
    cap = 200,
    threshold = 0,
    headline_metrics = {},
    note = null,
    unavailable = false,
  } = args;

  if (unavailable) {
    return {
      domain,
      label,
      status: STATUS.UNAVAILABLE,
      headline_metrics,
      counts: tallyKinds([]),
      variances: [],
      variance_total: 0,
      truncated: false,
      note,
    };
  }

  const classified = rows.map((r) => ({ ...r, kind: classifyRow(r, { tolerance, compareStatus }) }));
  const counts = tallyKinds(classified);
  const variances = classified.filter((r) => r.kind !== KIND.MATCH);
  const { shown, total, truncated } = capVariances(variances, cap);
  return {
    domain,
    label,
    status: decideStatus(counts.variances, { threshold }),
    headline_metrics: { ...headline_metrics, variance_count: counts.variances },
    counts,
    variances: shown,
    variance_total: total,
    truncated,
    note,
  };
}

/**
 * Finalize one domain section from the raw jsonb a `cutover_recon_*()` SQL
 * function returns. Unlike buildSection, the SQL has already done the set-based
 * join, computed the accurate FULL-set headline (incl. `status_break_count` and
 * `variance_total`), and capped the returned `variances` sample to <=200 rows.
 * This wrapper only: (a) tags each display row with its `kind` via classifyRow
 * (so the UI can label it), and (b) decides PASS/FAIL from the SQL's full-set
 * break count via decideStatus — keeping the variance *definition* and the
 * pass/fail rule in tested JS, on the live path.
 *
 * @param {object} raw - { headline{ status_break_count }, variances[], variance_total, note }
 * @param {object} cfg
 * @param {string} cfg.domain
 * @param {string} cfg.label
 * @param {number} [cfg.tolerance=0]
 * @param {boolean} [cfg.compareStatus=false]
 * @param {number} [cfg.threshold=0] - breaks allowed while still PASS
 * @param {boolean} [cfg.unavailable=false] - mirror can't tie -> UNAVAILABLE
 * @returns {object} the client-facing section
 */
export function finalizeSection(raw, cfg = {}) {
  const {
    domain,
    label,
    tolerance = 0,
    compareStatus = false,
    threshold = 0,
    unavailable = false,
  } = cfg;
  const headline = (raw && raw.headline) || {};
  const rows = Array.isArray(raw && raw.variances) ? raw.variances : [];
  const varianceTotal = Number(raw && raw.variance_total) || 0;
  const breakCount = Number(headline.status_break_count ?? varianceTotal) || 0;

  const classified = rows.map((r) => ({ ...r, kind: classifyRow(r, { tolerance, compareStatus }) }));
  const status = unavailable ? STATUS.UNAVAILABLE : decideStatus(breakCount, { threshold });

  return {
    domain,
    label,
    status,
    headline_metrics: headline,
    variances: classified,
    variance_total: varianceTotal,
    truncated: varianceTotal > classified.length,
    note: (raw && raw.note) || null,
  };
}
