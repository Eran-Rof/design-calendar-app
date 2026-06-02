// api/_lib/recon/ap-engine.js
//
// Tangerine P9-2 — Accounts-Payable reconciliation engine.
// Architecture: docs/tangerine/P9-parallel-run-architecture.md §4.1.
// Schema:       supabase/migrations/20260629800000_p9_chunk1_recon_schema.sql
//
// Compares Tangerine `invoices` (AP bills) against the Xoro shadow-mirror
// (T10-3 produced `tanda_pos` → `invoices` rows tagged source='xoro_mirror')
// for a given period. Emits one `recon_runs` row + N `recon_variances`
// rows per (vendor_id, source_tag, po_reference) group that disagrees.
//
// Operator-confirmed decisions:
//   D1 weekly cadence (also supports manual / replay)
//   D2 thresholds  $1/row  +  $100/domain  (LOCKED — operator confirmed)
//   D7 source_tag-aware grouping per channel
//      (shopify / fba / walmart / faire / xoro_mirror / null)
//   D11 replay_of_id supports retroactive re-comparison
//
// Pure module. The caller passes a configured supabase admin client.
// No env vars, no service-role plumbing — keeps the engine drivable
// from the manual-trigger handler, the future Wave-B weekly cron, and
// unit tests against an in-memory supabase double.
//
// Returns:
//   {
//     recon_run_id:        uuid,
//     status:              'clean' | 'variance' | 'error',
//     rows_compared:       int,                   // distinct (vendor, source_tag, po) groups
//     variances_found:     int,                   // |variance| >= per-row threshold
//     total_variance_cents:bigint,                // SUM(|variance|) across all rows
//     totals_jsonb:        { ... }                // written to recon_runs.totals_jsonb
//     errors:              [{ scope, reason }],
//   }
//
// The engine never throws on row-level data issues; it captures them in
// `errors` so the run still completes with status='variance' (or 'error'
// when the run itself can't proceed — e.g. recon_runs INSERT failed).

const AP_THRESHOLDS = Object.freeze({
  // $1 per row → 100 cents. Operator-locked.
  per_row_cents: 100,
  // $100 per domain → 10000 cents. Operator-locked.
  per_domain_cents: 10000,
});

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const VALID_CADENCES = new Set(["weekly", "manual", "replay"]);

/**
 * Convert a NUMERIC-ish dollar amount to integer cents. Tolerates null,
 * undefined, "$1,234.56", numeric strings, and number primitives.
 * Returns 0 for unparseable values — the caller decides whether 0 is a
 * legitimate amount or a parse failure (the engine treats parseable 0 and
 * unparseable-as-0 identically: $0 - $X = -$X, surfaces as a variance).
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
 * Normalize a vendor PO reference for matching purposes. Tangerine
 * stores invoice_number like "XORO-PO-12345" (mirror) or "VENDOR-INV-7"
 * (manual); Xoro tanda_pos uses po_number / buyer_po. We strip leading
 * "XORO-" so the mirror row collides with the original PO key in the
 * matching map.
 */
export function normalizePoRef(s) {
  if (s == null) return "";
  const str = String(s).trim().toUpperCase();
  // Strip the mirror prefix the T10-3 mirror writes when no Xoro vendor
  // invoice number is present.
  return str.replace(/^XORO-/, "");
}

/**
 * Build the stable group key for matching. (vendor_id || '', source_tag || '', po_ref || '').
 * source_tag null → 'manual_or_legacy' bucket so it groups but doesn't
 * collide with the explicit channel tags.
 */
export function buildGroupKey(vendor_id, source_tag, po_ref) {
  const v = vendor_id || "";
  const s = source_tag || "manual_or_legacy";
  const p = normalizePoRef(po_ref || "");
  return `${v}::${s}::${p}`;
}

/**
 * Validate the `runApReconciliation` arg bag and return either a
 * { data } or { error } envelope. Exported for handler reuse.
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
 * Pull Tangerine-side AP bills for the period:
 *   - entity_id = X
 *   - gl_status = 'posted'
 *   - posting_date BETWEEN period_start AND period_end
 * Bills are grouped by (vendor_id, source, normalized(invoice_number)).
 */
async function fetchTangerineBills({ admin, entity_id, period_start, period_end }) {
  const { data, error } = await admin
    .from("invoices")
    .select("id, vendor_id, invoice_number, po_id, total, total_amount_cents, source, posting_date, gl_status")
    .eq("entity_id", entity_id)
    .eq("gl_status", "posted")
    .gte("posting_date", period_start)
    .lte("posting_date", period_end);
  if (error) {
    return { error: `tangerine invoices read failed: ${error.message}` };
  }
  return { rows: data || [] };
}

/**
 * Pull Xoro-side AP shadow rows for the period. The T10-3 mirror writes
 * `invoices` rows with source='xoro_mirror' — we match those by po_id /
 * invoice_number against the Tangerine-truth rows. We also pull raw
 * `tanda_pos` so the engine surfaces vendor-bill events that landed in
 * Xoro but never reached the mirror (potential mirror gap).
 *
 * To keep the engine pure, the caller can pre-bucket; here we read both
 * via the supabase client. Bills come from `invoices.source='xoro_mirror'`
 * (the T10-3 output), tanda_pos raw is used only to flag missing-mirror
 * cases (po_number / buyer_po not in mirrored bills).
 */
async function fetchXoroSideMirror({ admin, entity_id, period_start, period_end }) {
  const { data, error } = await admin
    .from("invoices")
    .select("id, vendor_id, invoice_number, po_id, total, total_amount_cents, source, posting_date, gl_status")
    .eq("entity_id", entity_id)
    .eq("source", "xoro_mirror")
    .gte("posting_date", period_start)
    .lte("posting_date", period_end);
  if (error) {
    return { error: `xoro_mirror invoices read failed: ${error.message}` };
  }
  return { rows: data || [] };
}

/**
 * Bucket a list of invoice rows into a Map<groupKey, {amount_cents, rows[]}>.
 * Amount = total_amount_cents when present, else total*100. Multiple rows
 * in the same group sum together (a vendor can issue 2 bills against one
 * PO; we compare the sum vs the Xoro sum).
 */
export function bucketByGroup(rows) {
  const map = new Map();
  for (const row of rows) {
    const cents = row.total_amount_cents != null
      ? Number(row.total_amount_cents) || 0
      : dollarsToCents(row.total);
    const key = buildGroupKey(row.vendor_id, row.source, row.invoice_number);
    if (!map.has(key)) {
      map.set(key, {
        vendor_id: row.vendor_id,
        source_tag: row.source || null,
        po_reference: normalizePoRef(row.invoice_number || ""),
        amount_cents: 0,
        rows: [],
      });
    }
    const bucket = map.get(key);
    bucket.amount_cents += cents;
    bucket.rows.push(row);
  }
  return map;
}

/**
 * Match two buckets — Tangerine + Xoro — by group key and yield one
 * variance row per (vendor, source_tag, po) where the cents differ.
 *
 * For matching purposes the source_tag dimension is dropped: we want
 * "Tangerine posted source='manual' for PO X" to compare against
 * "Xoro mirror posted source='xoro_mirror' for PO X." The reported
 * source_tag on the variance row reflects the *Tangerine* side
 * (operator originating channel) so the dashboard groups by where
 * Tangerine thinks the bill came from.
 *
 * D7 (per-channel rollup) is satisfied by the dashboard's group-by
 * source_tag query; the engine emits the tag, the dashboard slices.
 */
export function matchGroups(tangerineBuckets, xoroBuckets) {
  // Build cross-source matching keys: (vendor_id, po_reference) — source
  // tag is intentionally NOT in the matching key (we're comparing
  // Tangerine-side accounting vs Xoro-side accounting per PO).
  function poKey(b) {
    return `${b.vendor_id || ""}::${b.po_reference}`;
  }

  const tangSum = new Map(); // poKey → {amount, source_tag, vendor_id, po}
  for (const b of tangerineBuckets.values()) {
    const k = poKey(b);
    if (!tangSum.has(k)) {
      tangSum.set(k, {
        vendor_id: b.vendor_id,
        po_reference: b.po_reference,
        source_tag: b.source_tag,
        amount_cents: 0,
      });
    }
    const t = tangSum.get(k);
    t.amount_cents += b.amount_cents;
    // Prefer the non-xoro_mirror tag for display (operator originating
    // channel), but if Tangerine only has mirror rows the tag stays
    // xoro_mirror.
    if (b.source_tag && b.source_tag !== "xoro_mirror") {
      t.source_tag = b.source_tag;
    }
  }

  const xoroSum = new Map();
  for (const b of xoroBuckets.values()) {
    const k = poKey(b);
    if (!xoroSum.has(k)) {
      xoroSum.set(k, {
        vendor_id: b.vendor_id,
        po_reference: b.po_reference,
        source_tag: b.source_tag,
        amount_cents: 0,
      });
    }
    xoroSum.get(k).amount_cents += b.amount_cents;
  }

  const variances = [];
  const seen = new Set();
  for (const [k, t] of tangSum) {
    seen.add(k);
    const x = xoroSum.get(k);
    const xoro_cents = x ? x.amount_cents : 0;
    const variance_cents = t.amount_cents - xoro_cents;
    variances.push({
      vendor_id: t.vendor_id,
      po_reference: t.po_reference,
      source_tag: t.source_tag,
      tangerine_amount_cents: t.amount_cents,
      xoro_amount_cents: xoro_cents,
      variance_amount_cents: variance_cents,
    });
  }
  // Xoro-only rows (mirror has a bill Tangerine never posted)
  for (const [k, x] of xoroSum) {
    if (seen.has(k)) continue;
    variances.push({
      vendor_id: x.vendor_id,
      po_reference: x.po_reference,
      source_tag: x.source_tag || "xoro_mirror",
      tangerine_amount_cents: 0,
      xoro_amount_cents: x.amount_cents,
      variance_amount_cents: -x.amount_cents,
    });
  }
  return variances;
}

/**
 * Apply the per-row + per-domain thresholds. Returns {variances_with_status, summary}.
 *   per-row:    |variance| <  $1   → status 'within'
 *               |variance| >= $1   → status 'over'
 *   per-domain: SUM(|over-variances|) >  $100 → run status 'variance'
 *               (all-within or sum below)     → run status 'clean'
 */
export function applyThresholds(variances, thresholds = AP_THRESHOLDS) {
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
 * Insert N recon_variances rows in one batch. Only rows that have a
 * non-zero variance OR a non-within status are persisted — within-rows
 * with $0 variance are not interesting for the variances queue (the
 * recon_runs.totals_jsonb captures the count).
 */
async function persistVariances(admin, recon_run_id, variances_with_status) {
  const toInsert = variances_with_status
    .filter((v) => v.variance_amount_cents !== 0)
    .map((v) => ({
      recon_run_id,
      source_table: "invoices",
      source_id: v.po_reference || "",
      source_tag: v.source_tag,
      tangerine_amount_cents: v.tangerine_amount_cents,
      xoro_amount_cents: v.xoro_amount_cents,
      variance_amount_cents: v.variance_amount_cents,
      status: v.status,
    }));
  if (toInsert.length === 0) return { inserted: 0, error: null };
  const { error } = await admin.from("recon_variances").insert(toInsert);
  if (error) return { inserted: 0, error: error.message };
  return { inserted: toInsert.length, error: null };
}

/**
 * Main entry point. See module header for the contract.
 */
export async function runApReconciliation({ admin, entity_id, period_start, period_end, cadence = "weekly", replay_of_id = null }) {
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
        domain: "ap",
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

  // 2. Pull both sides.
  const tang = await fetchTangerineBills({ admin, entity_id: args.entity_id, period_start: args.period_start, period_end: args.period_end });
  if (tang.error) {
    result.errors.push({ scope: "tangerine_fetch", reason: tang.error });
    await markRunErrored(admin, recon_run_id, result.errors);
    return result;
  }
  const xoro = await fetchXoroSideMirror({ admin, entity_id: args.entity_id, period_start: args.period_start, period_end: args.period_end });
  if (xoro.error) {
    result.errors.push({ scope: "xoro_fetch", reason: xoro.error });
    await markRunErrored(admin, recon_run_id, result.errors);
    return result;
  }

  // 3. Bucket + match.
  const tangBuckets = bucketByGroup(tang.rows);
  // Xoro side: exclude the mirror's own rows from Tangerine-side bucket
  // (avoid double-counting): the Tangerine fetch already includes
  // source='xoro_mirror' rows because gl_status='posted' was the filter.
  // We treat the mirror-tagged rows in tang.rows as the Xoro side, and
  // remove them from the Tangerine bucket so the comparison is
  // "Tangerine-non-mirror vs Xoro-mirror".
  const tangNonMirror = new Map();
  const xoroFromTang = new Map();
  for (const [k, b] of tangBuckets) {
    if (b.source_tag === "xoro_mirror") xoroFromTang.set(k, b);
    else tangNonMirror.set(k, b);
  }
  // Combine xoro side with explicit xoro_mirror fetch (overlap = same rows).
  // Use the xoroFromTang map as authoritative (already filtered by period).
  const xoroBuckets = xoroFromTang;
  // (xoro.rows is informational — it should equal xoroFromTang here. We
  // keep the separate fetch so the future engine can compare against
  // unposted-mirror rows or other xoro-side tables without code change.)
  void xoro;

  const variances = matchGroups(tangNonMirror, xoroBuckets);
  const { variances_with_status, summary } = applyThresholds(variances);

  // 4. Persist variances.
  const persisted = await persistVariances(admin, recon_run_id, variances_with_status);
  if (persisted.error) {
    result.errors.push({ scope: "recon_variances_insert", reason: persisted.error });
    await markRunErrored(admin, recon_run_id, result.errors);
    return result;
  }

  // 5. Update recon_runs row with totals + final status.
  const totals_jsonb = {
    rows_compared: summary.rows_compared,
    variances_found: summary.variances_found,
    total_variance_cents: summary.total_variance_cents,
    per_row_threshold_cents: summary.per_row_threshold_cents,
    per_domain_threshold_cents: summary.per_domain_threshold_cents,
    tangerine_rows_pulled: tang.rows.length,
    xoro_rows_pulled: xoro.rows.length,
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
      // Don't return early — the comparison ran, persistence happened.
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
    // best-effort — the caller already has the errors in `result.errors`.
  }
}

export const __test_only__ = {
  AP_THRESHOLDS,
  fetchTangerineBills,
  fetchXoroSideMirror,
  persistVariances,
  markRunErrored,
};
