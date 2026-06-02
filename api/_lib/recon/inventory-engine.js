// api/_lib/recon/inventory-engine.js
//
// Tangerine P9-6 — Inventory reconciliation engine (location-aware).
// Architecture: docs/tangerine/P9-parallel-run-architecture.md §3.5 / §4.4.
// Schema:       supabase/migrations/20260629800000_p9_chunk1_recon_schema.sql
//               supabase/migrations/20260620000000_t10_chunk1_source_columns.sql
//                 (extends inventory_layers.source_kind w/ 'xoro_mirror_snapshot')
//               supabase/migrations/20260629200000_p12_chunk0_marketplaces_shared.sql
//                 (adds inventory_locations + location_id on inventory_layers)
//
// Compares Tangerine `inventory_layers` (FIFO truth, P3-3) against the
// T10-4 Xoro shadow-mirror snapshot for a given period. Emits one
// `recon_runs` row + N `recon_variances` rows per (item_id, location_id)
// pair that disagrees beyond the per-row threshold.
//
// Operator-confirmed decisions:
//   D1  weekly cadence (also supports manual / replay)
//   D2  thresholds  $50/row  +  $250/domain  (LOCKED — widest of all
//       domains because FIFO + landed-cost timing produce normal noise)
//   D7  source_tag-aware grouping (mostly xoro_mirror vs P12 mirror kinds:
//       fba_inbound / wfs_inbound). The engine carries source_kind on the
//       variance row so the dashboard can slice channel-level variance.
//   D11 replay_of_id supports retroactive re-comparison
//
// LOCATION-AWARE PER P12-0:
//   - inventory_locations exists; FBA / WFS / Main-WH are independent scopes.
//   - Tangerine side groups by (item_id, location_id, source_kind) at the
//     end-of-period snapshot. SUM(remaining_qty × unit_cost_cents) is the
//     point-in-time valuation: FIFO is end-of-period because consumption
//     after period_end has not yet drawn down the period_end layer state.
//     Layers received AFTER period_end are excluded.
//   - Xoro side only covers the Main-WH location — FBA + WFS are P12-managed
//     locations the Xoro mirror does not see. For each (item, location)
//     where location.kind ∈ ('fba','wfs','3pl','dropship','virtual') and
//     the Xoro side has no comparable data, we mark the variance row with
//     notes='location_not_in_xoro' and SKIP threshold accounting (those
//     deltas don't reflect real variance — Xoro literally cannot see them).
//
// Pure module. The caller passes a configured supabase admin client.
// No env vars, no service-role plumbing — keeps the engine drivable from
// the manual-trigger handler, the future Wave-B weekly cron, and unit
// tests against an in-memory supabase double.
//
// Returns:
//   {
//     recon_run_id:        uuid,
//     status:              'clean' | 'variance' | 'error',
//     rows_compared:       int,                   // distinct (item, location) pairs
//     variances_found:     int,                   // |variance| >= per-row threshold AND not skipped
//     total_variance_cents:bigint,                // SUM(|variance|) across over-rows
//     totals_jsonb:        { ... }                // written to recon_runs.totals_jsonb
//     errors:              [{ scope, reason }],
//   }
//
// The engine never throws on row-level data issues; it captures them in
// `errors` so the run still completes with status='variance' (or 'error'
// when the run itself can't proceed — e.g. recon_runs INSERT failed).

const INVENTORY_THRESHOLDS = Object.freeze({
  // $50 per row → 5000 cents. Operator-locked (D2).
  per_row_cents: 5000,
  // $250 per domain → 25000 cents. Operator-locked (D2).
  per_domain_cents: 25000,
});

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const VALID_CADENCES = new Set(["weekly", "manual", "replay"]);

const XORO_MIRROR_KIND = "xoro_mirror_snapshot";

// Locations not visible to Xoro per P12-0. The recon still emits variance
// rows for these so the audit trail captures "FBA Tangerine layer state =
// $X, Xoro side blank" — but the row is marked location_not_in_xoro and
// excluded from threshold accounting so it never trips a 'variance'
// run status.
const LOCATION_KINDS_NOT_IN_XORO = new Set([
  "fba",
  "wfs",
  "3pl",
  "dropship",
  "virtual",
]);

const LOCATION_NOT_IN_XORO_NOTE = "location_not_in_xoro";

const NULL_LOCATION_KEY = "__null_location__";

/**
 * Validate the `runInventoryReconciliation` arg bag and return either a
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
 * Build the group key for matching layer-level rows into a single
 * (item, location, source_kind) bucket. source_kind is included in the
 * bucket key so the engine preserves per-channel breakdown (D7) while
 * still matching across kinds for the variance comparison.
 *
 * NULL location_id is bucketed under a sentinel so legacy layers without
 * a location still group with each other (and not silently drop).
 */
export function buildLayerKey(item_id, location_id, source_kind) {
  const i = item_id || "";
  const l = location_id || NULL_LOCATION_KEY;
  const s = source_kind || "unknown";
  return `${i}::${l}::${s}`;
}

/**
 * The match key — what we actually compare Tangerine vs Xoro on. We
 * collapse source_kind here so "Tangerine has an ap_invoice layer +
 * adjustment layer for SKU X at Main-WH" sums against "Xoro mirror
 * snapshot total for SKU X at Main-WH."
 */
export function buildMatchKey(item_id, location_id) {
  const i = item_id || "";
  const l = location_id || NULL_LOCATION_KEY;
  return `${i}::${l}`;
}

/**
 * Convert a NUMERIC-ish quantity × unit_cost_cents pair to integer cents.
 * remaining_qty is numeric(18,4); unit_cost_cents is bigint. Math.round
 * on the float multiplication is what the T10-4 mirror also does, so the
 * two sides round identically.
 */
export function layerValueCents(remaining_qty, unit_cost_cents) {
  const qty = Number(remaining_qty || 0);
  const unit = Number(unit_cost_cents || 0);
  if (!Number.isFinite(qty) || !Number.isFinite(unit)) return 0;
  return Math.round(qty * unit);
}

/**
 * Pull Tangerine-side inventory layers — every source_kind EXCEPT
 * xoro_mirror_snapshot. End-of-period snapshot semantics:
 *   - layer.received_at <= period_end (only layers existing at period close)
 *   - remaining_qty is the live FIFO state; for an end-of-period snapshot
 *     we accept the current remaining_qty because P3-3 consumes layers in
 *     order, so a layer's remaining_qty AS-OF period_end is conservative
 *     (post-period consumption would only DECREASE it, but those events
 *     happen after the period closes and are tracked in the NEXT recon).
 *
 * Note on FIFO end-of-period semantics: this engine treats `remaining_qty`
 * as the period-end snapshot. The architecture §4.4 acknowledges Xoro's
 * snapshot is point-in-time too — reconciling FIFO-now vs snapshot-then is
 * intentionally lossy on intra-period churn. The variance threshold ($50)
 * absorbs that noise.
 */
async function fetchTangerineLayers({ admin, entity_id, period_end }) {
  // Paginate — could be 100k+ rows across all SKUs/locations.
  const out = [];
  let offset = 0;
  const page = 1000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await admin
      .from("inventory_layers")
      .select("id, item_id, location_id, source_kind, remaining_qty, unit_cost_cents, received_at")
      .eq("entity_id", entity_id)
      .neq("source_kind", XORO_MIRROR_KIND)
      .lte("received_at", `${period_end}T23:59:59.999Z`)
      .range(offset, offset + page - 1);
    if (error) {
      return { error: `tangerine inventory_layers read failed: ${error.message}` };
    }
    const rows = data || [];
    out.push(...rows);
    if (rows.length < page) break;
    offset += rows.length;
  }
  return { rows: out };
}

/**
 * Pull Xoro-side inventory layers — only source_kind='xoro_mirror_snapshot'.
 * T10-4's nightly cron drops + rebuilds these from ip_inventory_snapshot,
 * so this read returns the latest mirror state. We still apply received_at
 * <= period_end so a replay of an older period doesn't pick up a snapshot
 * that landed later.
 */
async function fetchXoroMirrorLayers({ admin, entity_id, period_end }) {
  const out = [];
  let offset = 0;
  const page = 1000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await admin
      .from("inventory_layers")
      .select("id, item_id, location_id, source_kind, remaining_qty, unit_cost_cents, received_at")
      .eq("entity_id", entity_id)
      .eq("source_kind", XORO_MIRROR_KIND)
      .lte("received_at", `${period_end}T23:59:59.999Z`)
      .range(offset, offset + page - 1);
    if (error) {
      return { error: `xoro_mirror inventory_layers read failed: ${error.message}` };
    }
    const rows = data || [];
    out.push(...rows);
    if (rows.length < page) break;
    offset += rows.length;
  }
  return { rows: out };
}

/**
 * Pull the inventory_locations registry. Returns Map<location_id, {kind}>
 * so the matcher can decide which (item, location) keys are FBA/WFS and
 * therefore exempt from threshold accounting.
 */
async function fetchLocations({ admin, entity_id }) {
  const { data, error } = await admin
    .from("inventory_locations")
    .select("id, code, kind")
    .eq("entity_id", entity_id);
  if (error) {
    return { error: `inventory_locations read failed: ${error.message}` };
  }
  const map = new Map();
  for (const r of data || []) {
    map.set(r.id, { id: r.id, code: r.code, kind: r.kind });
  }
  return { locations: map };
}

/**
 * Bucket a list of layer rows into a Map<groupKey, {item_id, location_id,
 * source_kind, value_cents, layer_count}>. value_cents = SUM(remaining_qty
 * × unit_cost_cents) per group.
 */
export function bucketLayersByGroup(rows) {
  const map = new Map();
  for (const row of rows) {
    const cents = layerValueCents(row.remaining_qty, row.unit_cost_cents);
    const key = buildLayerKey(row.item_id, row.location_id, row.source_kind);
    if (!map.has(key)) {
      map.set(key, {
        item_id: row.item_id || null,
        location_id: row.location_id || null,
        source_kind: row.source_kind || null,
        value_cents: 0,
        layer_count: 0,
      });
    }
    const b = map.get(key);
    b.value_cents += cents;
    b.layer_count += 1;
  }
  return map;
}

/**
 * Collapse layer-level buckets by (item, location) → match-level buckets.
 * Returns Map<matchKey, {item_id, location_id, value_cents, source_kinds[]}>.
 * source_kinds[] preserves the per-channel breakdown for the variance row
 * (D7 — dashboard groups by source_kind).
 */
export function collapseToMatchBuckets(layerBuckets) {
  const map = new Map();
  for (const b of layerBuckets.values()) {
    const k = buildMatchKey(b.item_id, b.location_id);
    if (!map.has(k)) {
      map.set(k, {
        item_id: b.item_id,
        location_id: b.location_id,
        value_cents: 0,
        source_kinds: [],
      });
    }
    const m = map.get(k);
    m.value_cents += b.value_cents;
    if (b.source_kind && !m.source_kinds.includes(b.source_kind)) {
      m.source_kinds.push(b.source_kind);
    }
  }
  return map;
}

/**
 * Match Tangerine match-level buckets against Xoro match-level buckets by
 * (item, location) and yield one variance per pair. For pairs where the
 * Tangerine location.kind is FBA/WFS/3PL/dropship/virtual the row is
 * marked `is_skipped = true` (notes='location_not_in_xoro') and excluded
 * from threshold accounting.
 *
 * The reported source_tag on the variance is the join of Tangerine-side
 * source_kinds, falling back to 'xoro_mirror_snapshot' for Xoro-only rows.
 */
export function matchInventory(tangBuckets, xoroBuckets, locations) {
  const variances = [];
  const seen = new Set();

  function locationKind(location_id) {
    if (!location_id) return null;
    const loc = locations.get(location_id);
    return loc ? loc.kind : null;
  }

  function isLocationNotInXoro(location_id) {
    const k = locationKind(location_id);
    return k != null && LOCATION_KINDS_NOT_IN_XORO.has(k);
  }

  function joinKinds(kinds) {
    if (!kinds || kinds.length === 0) return null;
    if (kinds.length === 1) return kinds[0];
    return kinds.slice().sort().join("+");
  }

  for (const [k, t] of tangBuckets) {
    seen.add(k);
    const x = xoroBuckets.get(k);
    const xoro_cents = x ? x.value_cents : 0;
    const variance_cents = t.value_cents - xoro_cents;
    const skipped = isLocationNotInXoro(t.location_id);
    variances.push({
      item_id: t.item_id,
      location_id: t.location_id,
      location_kind: locationKind(t.location_id),
      source_tag: joinKinds(t.source_kinds),
      tangerine_amount_cents: t.value_cents,
      xoro_amount_cents: xoro_cents,
      variance_amount_cents: variance_cents,
      is_skipped: skipped,
      notes: skipped ? LOCATION_NOT_IN_XORO_NOTE : null,
    });
  }
  // Xoro-only rows (mirror has a layer Tangerine doesn't, e.g. SKU exists in
  // Xoro snapshot but never received via Tangerine flows). Mark with the
  // mirror kind. Cannot be 'location_not_in_xoro' since the row exists in
  // Xoro — but the location could still be FBA/WFS if the mirror somehow
  // wrote one (defensive: still emit but do not skip).
  for (const [k, x] of xoroBuckets) {
    if (seen.has(k)) continue;
    variances.push({
      item_id: x.item_id,
      location_id: x.location_id,
      location_kind: locationKind(x.location_id),
      source_tag: XORO_MIRROR_KIND,
      tangerine_amount_cents: 0,
      xoro_amount_cents: x.value_cents,
      variance_amount_cents: -x.value_cents,
      is_skipped: false,
      notes: null,
    });
  }
  return variances;
}

/**
 * Apply the per-row + per-domain thresholds. Returns {variances_with_status, summary}.
 *   per-row:    |variance| <  $50  → status 'within'
 *               |variance| >= $50  → status 'over'
 *   per-domain: SUM(|over-variances|) >  $250 → run status 'variance'
 *               (all-within or sum below)     → run status 'clean'
 *
 * Skipped (location_not_in_xoro) rows are NEVER 'over' — they're tagged
 * 'within' and excluded from the domain total. They still surface in the
 * variances queue so the audit trail is intact.
 */
export function applyThresholds(variances, thresholds = INVENTORY_THRESHOLDS) {
  let total_variance_cents = 0;
  let over_count = 0;
  let skipped_count = 0;
  // Per-location summary so the dashboard can render Main-WH variance vs
  // FBA "informational only" counts side by side.
  const per_location = {};
  const out = variances.map((v) => {
    const abs = Math.abs(v.variance_amount_cents);
    let status;
    if (v.is_skipped) {
      status = "within";
      skipped_count += 1;
    } else if (abs >= thresholds.per_row_cents) {
      status = "over";
      over_count += 1;
      total_variance_cents += abs;
    } else {
      status = "within";
    }
    const locKey = v.location_id || NULL_LOCATION_KEY;
    if (!per_location[locKey]) {
      per_location[locKey] = {
        location_id: v.location_id,
        location_kind: v.location_kind,
        rows: 0,
        over: 0,
        skipped: 0,
        variance_cents: 0,
      };
    }
    per_location[locKey].rows += 1;
    if (status === "over") {
      per_location[locKey].over += 1;
      per_location[locKey].variance_cents += abs;
    }
    if (v.is_skipped) per_location[locKey].skipped += 1;
    return { ...v, status };
  });
  const run_status =
    total_variance_cents > thresholds.per_domain_cents ? "variance" : "clean";
  return {
    variances_with_status: out,
    summary: {
      rows_compared: out.length,
      variances_found: over_count,
      skipped_count,
      total_variance_cents,
      run_status,
      per_row_threshold_cents: thresholds.per_row_cents,
      per_domain_threshold_cents: thresholds.per_domain_cents,
      per_location,
    },
  };
}

/**
 * Insert N recon_variances rows in one batch. Only rows that have a
 * non-zero variance OR are skipped (we want the FBA/WFS audit trail) are
 * persisted — zero-variance non-skipped rows are not interesting.
 */
async function persistVariances(admin, recon_run_id, variances_with_status) {
  const toInsert = variances_with_status
    .filter((v) => v.variance_amount_cents !== 0 || v.is_skipped)
    .map((v) => ({
      recon_run_id,
      source_table: "inventory_layers",
      // source_id = "<item_id>::<location_id>" so the dashboard can link
      // back to the specific (item, location) without overloading any
      // single uuid column.
      source_id: `${v.item_id || ""}::${v.location_id || ""}`,
      source_tag: v.source_tag,
      tangerine_amount_cents: v.tangerine_amount_cents,
      xoro_amount_cents: v.xoro_amount_cents,
      variance_amount_cents: v.variance_amount_cents,
      status: v.status,
      notes: v.notes,
    }));
  if (toInsert.length === 0) return { inserted: 0, error: null };
  const { error } = await admin.from("recon_variances").insert(toInsert);
  if (error) return { inserted: 0, error: error.message };
  return { inserted: toInsert.length, error: null };
}

/**
 * Main entry point. See module header for the contract.
 */
export async function runInventoryReconciliation({
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
        domain: "inventory",
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

  // 2. Pull locations registry, both sides.
  const locRes = await fetchLocations({ admin, entity_id: args.entity_id });
  if (locRes.error) {
    result.errors.push({ scope: "locations_fetch", reason: locRes.error });
    await markRunErrored(admin, recon_run_id, result.errors);
    return result;
  }
  const tang = await fetchTangerineLayers({
    admin,
    entity_id: args.entity_id,
    period_end: args.period_end,
  });
  if (tang.error) {
    result.errors.push({ scope: "tangerine_fetch", reason: tang.error });
    await markRunErrored(admin, recon_run_id, result.errors);
    return result;
  }
  const xoro = await fetchXoroMirrorLayers({
    admin,
    entity_id: args.entity_id,
    period_end: args.period_end,
  });
  if (xoro.error) {
    result.errors.push({ scope: "xoro_fetch", reason: xoro.error });
    await markRunErrored(admin, recon_run_id, result.errors);
    return result;
  }

  // 3. Bucket per (item, location, source_kind) → collapse to (item, location).
  const tangLayerBuckets = bucketLayersByGroup(tang.rows);
  const xoroLayerBuckets = bucketLayersByGroup(xoro.rows);
  const tangMatchBuckets = collapseToMatchBuckets(tangLayerBuckets);
  const xoroMatchBuckets = collapseToMatchBuckets(xoroLayerBuckets);

  // 4. Match + threshold.
  const variances = matchInventory(tangMatchBuckets, xoroMatchBuckets, locRes.locations);
  const { variances_with_status, summary } = applyThresholds(variances);

  // 5. Persist variances.
  const persisted = await persistVariances(admin, recon_run_id, variances_with_status);
  if (persisted.error) {
    result.errors.push({ scope: "recon_variances_insert", reason: persisted.error });
    await markRunErrored(admin, recon_run_id, result.errors);
    return result;
  }

  // 6. Update recon_runs row with totals + final status.
  const totals_jsonb = {
    rows_compared: summary.rows_compared,
    variances_found: summary.variances_found,
    skipped_count: summary.skipped_count,
    total_variance_cents: summary.total_variance_cents,
    per_row_threshold_cents: summary.per_row_threshold_cents,
    per_domain_threshold_cents: summary.per_domain_threshold_cents,
    tangerine_rows_pulled: tang.rows.length,
    xoro_rows_pulled: xoro.rows.length,
    tangerine_layer_buckets: tangLayerBuckets.size,
    xoro_layer_buckets: xoroLayerBuckets.size,
    per_location: summary.per_location,
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
  INVENTORY_THRESHOLDS,
  XORO_MIRROR_KIND,
  LOCATION_KINDS_NOT_IN_XORO,
  LOCATION_NOT_IN_XORO_NOTE,
  NULL_LOCATION_KEY,
  fetchTangerineLayers,
  fetchXoroMirrorLayers,
  fetchLocations,
  persistVariances,
  markRunErrored,
};
