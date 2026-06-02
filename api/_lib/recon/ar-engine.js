// api/_lib/recon/ar-engine.js
//
// Tangerine P9-3 — Parallel-Run AR reconciliation engine.
//
// Mirror of P9-2 (AP) for the AR domain. Compares Tangerine ar_invoices
// (P4-1) against the Xoro side — ip_sales_history_wholesale (the legacy
// fetch table) — for an operator-supplied period window. Writes one
// recon_runs row + N recon_variances rows; updates totals_jsonb with the
// summary.
//
// ── Operator-confirmed decisions (per task spec) ────────────────────────
//   D2  threshold        : $1.00 per row    (100 cents)
//                          $100.00 per domain (10_000 cents ceiling)
//   D7  source_tag-aware : group by (customer_id, source_tag) per channel
//                          so per-channel variance is decideable. Sources
//                          tracked: shopify, fba, walmart, faire,
//                          xoro_mirror, manual, edi_3pl, plaid_sync, api,
//                          system (the full source enum on ar_invoices).
//   D11 replay support   : replay_of_id is recorded on the recon_runs row
//                          so the auditable history shows "originally
//                          clean, re-run found $X variance" without
//                          losing either result.
//
// ── Period semantics ────────────────────────────────────────────────────
// period_start / period_end are inclusive ISO YYYY-MM-DD dates. We filter
// Tangerine on `invoice_date BETWEEN period_start AND period_end` (the
// canonical date column on ar_invoices per P4-1) and Xoro on
// `txn_date BETWEEN period_start AND period_end` (per CURRENT-SCHEMA.md).
//
// ── Source-tag derivation for the Xoro side ─────────────────────────────
// ip_sales_history_wholesale has no `source_tag` column — its `source`
// column defaults to 'xoro' (legacy fetch). For variance grouping
// purposes we DERIVE the Xoro side's source_tag from the invoice_number
// prefix when one of the marketplace patterns matches, falling back to
// 'xoro_mirror' (the canonical T10 tag for everything that flowed
// through the legacy Xoro fetch). The mapping intentionally mirrors the
// T10 source enum so per-channel variances line up across the two
// sides:
//
//   prefix /^SHOP/i   → 'shopify'
//   prefix /^FBA/i    → 'fba'
//   prefix /^AMZ/i    → 'fba'           (FBA orders also surface as AMZ-)
//   prefix /^WMT/i    → 'walmart'
//   prefix /^WM-/i    → 'walmart'
//   prefix /^FAIRE/i  → 'faire'
//   prefix /^FE-/i    → 'faire'
//   otherwise         → 'xoro_mirror'
//
// This lets the dashboards answer "AR shopify variance across the
// period was $X" by grouping on (customer_id, 'shopify') from both
// sides.
//
// ── Comparison logic ────────────────────────────────────────────────────
// Both sides are grouped by (customer_id, source_tag) → BigInt cents
// total. Variance = tangerine_cents − xoro_cents. Per row the variance
// status is:
//
//   'within' if ABS(variance) <= per_row_threshold_cents (100c default)
//   'over'   otherwise
//
// We INSERT a recon_variances row for EVERY group that has a non-zero
// presence on either side (so the queue can show "Tangerine has it,
// Xoro doesn't" as a $X variance vs zero). 'within' rows are inserted
// too so the auditable trail is complete — the dashboard filters by
// status when needed.
//
// ── Domain ceiling ──────────────────────────────────────────────────────
// SUM of ABS(variance_cents) across all 'over' rows is compared to the
// per_domain_threshold_cents (10_000c default). If we cross it, the
// recon_runs.status flips to 'variance'. If no over-threshold rows
// exist, status flips to 'clean'.
//
// ── Idempotency / replay ────────────────────────────────────────────────
// Each run is a fresh recon_runs INSERT (we do NOT upsert) — runs are
// append-only by design (the architecture treats every run as a
// distinct evidence row in the 60-day clean window). Replay is
// supported via the `replay_of_id` parameter — the new run is recorded
// pointing back to the original, and the dashboards show both side by
// side.
//
// PUBLIC ENTRY: runArReconciliation({admin, entity_id, period_start,
//   period_end, cadence?, replay_of_id?, now?, deps?}).
//
// All BigInt math for money (no float drift). No external network calls
// other than supabase.

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// AR source enum on ar_invoices (per CURRENT-SCHEMA.md / T10-1)
export const AR_SOURCE_TAGS = [
  "manual",
  "xoro_mirror",
  "shopify",
  "fba",
  "walmart",
  "faire",
  "edi_3pl",
  "plaid_sync",
  "api",
  "system",
];

// Default per-row / per-domain thresholds (D2)
export const DEFAULT_PER_ROW_THRESHOLD_CENTS = 100n; // $1.00
export const DEFAULT_PER_DOMAIN_THRESHOLD_CENTS = 10_000n; // $100.00

// ────────────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────────────

/**
 * Cast number / string / bigint / null → BigInt.
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

/** Format integer cents as decimal string ("$1.23" → "1.23"). */
export function centsToDecimal(cents) {
  const b = typeof cents === "bigint" ? cents : toBigInt(cents);
  const neg = b < 0n;
  const abs = neg ? -b : b;
  const whole = abs / 100n;
  const frac = abs % 100n;
  const fracStr = frac < 10n ? `0${frac}` : `${frac}`;
  return `${neg ? "-" : ""}${whole}.${fracStr}`;
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

/**
 * Convert dollars-as-numeric (ip_sales_history_wholesale.net_amount etc.)
 * to integer cents using Math.round so 1.005 → 100 (consistent with the
 * T10-2 toCents helper).
 */
export function dollarsToCents(amount) {
  if (amount == null) return 0n;
  const n = Number(amount);
  if (!Number.isFinite(n)) return 0n;
  return BigInt(Math.round(n * 100));
}

/**
 * Derive the source_tag for one ip_sales_history_wholesale row. Uses
 * invoice_number prefix when one of the marketplace patterns matches,
 * falls back to 'xoro_mirror'.
 *
 * (D7 — per-channel grouping so dashboards can answer "AR shopify
 * variance across the period was $X" by comparing the same source_tag
 * on both sides.)
 */
export function deriveXoroSourceTag(invoice_number) {
  if (!invoice_number || typeof invoice_number !== "string") {
    return "xoro_mirror";
  }
  const s = invoice_number.trim();
  if (!s) return "xoro_mirror";
  if (/^SHOP/i.test(s)) return "shopify";
  if (/^AMZ/i.test(s) || /^FBA/i.test(s)) return "fba";
  if (/^WMT/i.test(s) || /^WM-/i.test(s)) return "walmart";
  if (/^FAIRE/i.test(s) || /^FE-/i.test(s)) return "faire";
  return "xoro_mirror";
}

/**
 * Per-row line total for an ip_sales_history_wholesale row. Preference:
 * net_amount → gross_amount → qty * unit_price. Same waterfall as
 * T10-2's composeLine.
 */
export function xoroRowToCents(row) {
  if (!row) return 0n;
  if (row.net_amount != null) return dollarsToCents(row.net_amount);
  if (row.gross_amount != null) return dollarsToCents(row.gross_amount);
  if (row.unit_price != null && row.qty != null) {
    const n = Number(row.unit_price) * Number(row.qty);
    if (!Number.isFinite(n)) return 0n;
    return BigInt(Math.round(n * 100));
  }
  return 0n;
}

/**
 * Group a list of Tangerine ar_invoices rows by (customer_id, source).
 * Returns Map<"customer|source", { customer_id, source_tag, cents, rows[] }>.
 *
 * Rows missing customer_id are still grouped — the key uses "" for the
 * customer slot. (Schema says NOT NULL but defensive.)
 */
export function groupTangerineByCustomerSource(rows) {
  const groups = new Map();
  for (const r of rows || []) {
    const customer_id = r.customer_id || "";
    const source_tag = r.source || "manual";
    const key = `${customer_id}|${source_tag}`;
    if (!groups.has(key)) {
      groups.set(key, {
        customer_id,
        source_tag,
        cents: 0n,
        rows: [],
      });
    }
    const g = groups.get(key);
    g.cents += toBigInt(r.total_amount_cents || 0);
    g.rows.push(r);
  }
  return groups;
}

/**
 * Group ip_sales_history_wholesale rows by (resolved customer_id,
 * derived source_tag). resolveCustomerId is a sync function
 * (legacy_customer_id → tangerine_customer_id|null) — caller does the
 * async pre-fetch and passes the lookup map.
 *
 * Returns Map<"customer|source", { customer_id, source_tag, cents, rows[] }>.
 */
export function groupXoroByCustomerSource(rows, customerLookup) {
  const groups = new Map();
  for (const r of rows || []) {
    const legacy_customer_id = r.customer_id || null;
    const resolved = legacy_customer_id
      ? customerLookup.get(legacy_customer_id) || ""
      : "";
    const source_tag = deriveXoroSourceTag(r.invoice_number);
    const key = `${resolved}|${source_tag}`;
    if (!groups.has(key)) {
      groups.set(key, {
        customer_id: resolved,
        source_tag,
        cents: 0n,
        rows: [],
      });
    }
    const g = groups.get(key);
    g.cents += xoroRowToCents(r);
    g.rows.push(r);
  }
  return groups;
}

/**
 * Take two groupings (tangerine, xoro), produce the union list of
 * variance rows.
 */
export function buildVarianceRows({
  tangerineGroups,
  xoroGroups,
  perRowThresholdCents,
}) {
  const keys = new Set([...tangerineGroups.keys(), ...xoroGroups.keys()]);
  const out = [];
  for (const key of keys) {
    const t = tangerineGroups.get(key);
    const x = xoroGroups.get(key);
    const customer_id = (t || x).customer_id || null;
    const source_tag = (t || x).source_tag;
    const tan = t ? t.cents : 0n;
    const xor = x ? x.cents : 0n;
    const variance = tan - xor;
    const absVar = absBig(variance);
    const status = absVar <= perRowThresholdCents ? "within" : "over";
    const sumAbs = absBig(tan) + absBig(xor);
    let variance_percent = null;
    if (sumAbs > 0n) {
      // dollars on dollars; safe Number conversion (max ~10^9 cents = $10M)
      const denomDollars = Number(sumAbs) / 100;
      const numDollars = Number(absVar) / 100;
      if (Number.isFinite(denomDollars) && denomDollars > 0) {
        variance_percent = +((numDollars / denomDollars) * 100).toFixed(4);
      }
    }
    out.push({
      key,
      customer_id: customer_id || null,
      source_tag,
      tangerine_amount_cents: tan,
      xoro_amount_cents: xor,
      variance_amount_cents: variance,
      variance_percent,
      status,
    });
  }
  // deterministic order for tests + reproducible inserts
  out.sort((a, b) => a.key.localeCompare(b.key));
  return out;
}

/**
 * Compose the totals_jsonb payload written to recon_runs.totals_jsonb on
 * completion.
 */
export function composeTotals({ varianceRows, perRowThresholdCents, perDomainThresholdCents }) {
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
    total_abs_variance_cents: totalAbsVarianceCents.toString(),
    total_tangerine_cents: totalTangerineCents.toString(),
    total_xoro_cents: totalXoroCents.toString(),
    per_row_threshold_cents: perRowThresholdCents.toString(),
    per_domain_threshold_cents: perDomainThresholdCents.toString(),
    domain_threshold_crossed: ceilingCrossed,
    per_source_tag: perSourceTag,
  };
}

/**
 * Decide the final recon_runs.status based on the totals.
 *
 *   variances_found = 0                                     → 'clean'
 *   variances_found > 0 && !ceilingCrossed                  → 'variance'
 *   variances_found > 0 && ceilingCrossed                   → 'variance'
 *
 * (Both over-threshold cases are 'variance'; ceiling crossing surfaces
 * via totals_jsonb.domain_threshold_crossed for the dashboard.)
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

/**
 * Insert the recon_runs row in 'running' state. Returns { id, error }.
 */
export async function insertReconRun(admin, params) {
  const row = {
    entity_id: params.entity_id,
    domain: "ar",
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
 * Pull ar_invoices for the entity / period. Posted-equivalent statuses
 * are the ones that carry real $ — sent/posted/posted_historical/
 * partial_paid/paid. (Unposted drafts and voids are excluded so we
 * compare like-for-like with Xoro's completed invoice ledger.)
 */
export async function loadTangerineAr(admin, { entity_id, period_start, period_end }) {
  const POSTED_STATUSES = [
    "sent",
    "posted",
    "posted_historical",
    "partial_paid",
    "paid",
  ];
  const { data, error } = await admin
    .from("ar_invoices")
    .select("id, customer_id, source, total_amount_cents, invoice_date, gl_status, invoice_number")
    .eq("entity_id", entity_id)
    .in("gl_status", POSTED_STATUSES)
    .gte("invoice_date", period_start)
    .lte("invoice_date", period_end);
  if (error) return { rows: [], error };
  return { rows: data || [], error: null };
}

/**
 * Pull ip_sales_history_wholesale for the same period. The legacy
 * fetch table is NOT entity-scoped (it's a single-tenant snapshot of
 * the Xoro fetch), so we pull the whole period and trust the dollar
 * grain. customer_id here is the LEGACY ip_customer_master id — we
 * resolve it to a Tangerine customers.id via the lookup map.
 */
export async function loadXoroAr(admin, { period_start, period_end }) {
  const { data, error } = await admin
    .from("ip_sales_history_wholesale")
    .select("id, customer_id, invoice_number, txn_date, qty, unit_price, gross_amount, discount_amount, net_amount")
    .gte("txn_date", period_start)
    .lte("txn_date", period_end);
  if (error) return { rows: [], error };
  return { rows: data || [], error: null };
}

/**
 * Build the legacy_customer_id → tangerine_customer_id lookup for every
 * legacy id observed in xoroRows. Returns Map<legacy_id, tangerine_id|null>.
 *
 * Two-hop join (mirrors T10-2's resolveCustomerId):
 *   ip_customer_master.id (legacy) → customer_code → customers.code (within entity)
 */
export async function buildCustomerLookup(admin, { entity_id, xoroRows }) {
  const legacyIds = [...new Set(xoroRows.map((r) => r.customer_id).filter(Boolean))];
  const lookup = new Map();
  if (!legacyIds.length) return { lookup, error: null };
  const { data: legacyRows, error: e1 } = await admin
    .from("ip_customer_master")
    .select("id, customer_code")
    .in("id", legacyIds);
  if (e1) return { lookup, error: e1 };
  const codes = [
    ...new Set((legacyRows || []).map((r) => r.customer_code).filter(Boolean)),
  ];
  const codeToTangerine = new Map();
  if (codes.length) {
    const { data: matched, error: e2 } = await admin
      .from("customers")
      .select("id, code")
      .eq("entity_id", entity_id)
      .in("code", codes);
    if (e2) return { lookup, error: e2 };
    for (const c of matched || []) {
      if (c.code) codeToTangerine.set(c.code, c.id);
    }
  }
  for (const lr of legacyRows || []) {
    lookup.set(lr.id, lr.customer_code ? codeToTangerine.get(lr.customer_code) || null : null);
  }
  return { lookup, error: null };
}

/**
 * INSERT all recon_variances rows in one batch. Returns { inserted, error }.
 */
export async function insertVariances(admin, run_id, varianceRows) {
  if (!varianceRows.length) return { inserted: 0, error: null };
  const rows = varianceRows.map((v) => ({
    recon_run_id: run_id,
    source_table: "ar_invoices",
    source_id: v.customer_id ? `customer:${v.customer_id}` : `customer:unknown`,
    source_tag: v.source_tag,
    tangerine_amount_cents: v.tangerine_amount_cents.toString(),
    xoro_amount_cents: v.xoro_amount_cents.toString(),
    variance_amount_cents: v.variance_amount_cents.toString(),
    variance_percent: v.variance_percent,
    status: v.status,
  }));
  const { error } = await admin.from("recon_variances").insert(rows);
  return { inserted: error ? 0 : rows.length, error };
}

// ────────────────────────────────────────────────────────────────────────
// Public entry point
// ────────────────────────────────────────────────────────────────────────

/**
 * Run an AR reconciliation for the given period.
 *
 * @param {Object}   args
 * @param {Object}   args.admin            service-role supabase client
 * @param {string}   args.entity_id        tangerine entity uuid
 * @param {string}   args.period_start     inclusive ISO YYYY-MM-DD
 * @param {string}   args.period_end       inclusive ISO YYYY-MM-DD
 * @param {string}   [args.cadence]        'weekly' (default) | 'manual' | 'replay'
 * @param {string}   [args.replay_of_id]   recon_runs.id this run replays (D11)
 * @param {string}   [args.now]            ISO timestamp override (test injection)
 * @param {bigint}   [args.per_row_threshold_cents]      override default
 * @param {bigint}   [args.per_domain_threshold_cents]   override default
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   recon_run_id: string|null,
 *   status: 'clean'|'variance'|'error',
 *   summary: object,
 *   errors: Array<{kind:string, message?:string}>,
 * }>}
 */
export async function runArReconciliation(args) {
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
    // ── 2. load both sides ──────────────────────────────────────────
    const { rows: tanRows, error: tanErr } = await loadTangerineAr(admin, {
      entity_id,
      period_start,
      period_end,
    });
    if (tanErr) {
      errors.push({ kind: "tangerine_read_failed", message: tanErr.message });
      await finalizeReconRun(admin, run_id, {
        status: "error",
        completed_at: now,
        totals_jsonb: { errors },
      });
      return { ok: false, recon_run_id: run_id, status: "error", summary, errors };
    }

    const { rows: xoroRows, error: xoroErr } = await loadXoroAr(admin, {
      period_start,
      period_end,
    });
    if (xoroErr) {
      errors.push({ kind: "xoro_read_failed", message: xoroErr.message });
      await finalizeReconRun(admin, run_id, {
        status: "error",
        completed_at: now,
        totals_jsonb: { errors },
      });
      return { ok: false, recon_run_id: run_id, status: "error", summary, errors };
    }

    // ── 3. build the customer lookup (legacy id → tangerine id) ─────
    const { lookup: customerLookup, error: lookupErr } = await buildCustomerLookup(admin, {
      entity_id,
      xoroRows,
    });
    if (lookupErr) {
      // non-fatal: unresolved customers fall through with empty customer_id;
      // we still capture the error in totals_jsonb.errors for the dashboard.
      errors.push({ kind: "customer_lookup_partial_failure", message: lookupErr.message });
    }

    // ── 4. group + compare ──────────────────────────────────────────
    const tangerineGroups = groupTangerineByCustomerSource(tanRows);
    const xoroGroups = groupXoroByCustomerSource(xoroRows, customerLookup);
    const varianceRows = buildVarianceRows({
      tangerineGroups,
      xoroGroups,
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

    // ── 6. compose totals + finalize ────────────────────────────────
    const totals = composeTotals({
      varianceRows,
      perRowThresholdCents: per_row_threshold_cents,
      perDomainThresholdCents: per_domain_threshold_cents,
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
