// Service layer: orchestrates repository IO + compute. The UI calls these
// three verbs and nothing else:
//
//   runForecastPass(run)     — builds baseline, applies requests + overrides, upserts
//   applyOverride(forecast, qty, reasonCode, note)
//                            — audit log + recalc that row's final
//   buildGridRows(run)       — returns the denormalized view for the workbench
//
// Computation is pure; this file only coordinates.

import type { IpIsoDate } from "../types/entities";
import type {
  IpForecastComputeInput,
  IpForecastMethod,
  IpOverrideReasonCode,
  IpPlanningGridRow,
  IpPlanningRun,
  IpWholesaleForecast,
} from "../types/wholesale";
import {
  buildFinalWholesaleForecast,
  buildRollingWholesaleSupply,
  generateWholesaleRecommendations,
  historicalReceiptsInPeriod,
  latestOnHandBySku,
  monthOf,
  monthsBetween,
  openPoQtyBySku,
  receiptsDueInPeriod,
  recommendForRow,
} from "../compute";
import { wholesaleRepo, BuildCancelledError } from "./wholesalePlanningRepository";
import { resolveVariantColorWithProvenance } from "./resolveVariantColor";

export { BuildCancelledError };

// Progress events emitted by runForecastPass at each phase boundary so
// the UI can render a status bar. `current` and `total` are only set on
// phases where a meaningful row count exists (compute, write).
export interface BuildProgress {
  phase: "loading" | "computing" | "writing_forecast" | "reading_back" | "computing_recs" | "writing_recs" | "done";
  label: string;
  current?: number;
  total?: number;
}

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new BuildCancelledError();
}

// Item-master attributes JSONB pulls — keep null-safe so the grid never
// breaks when an item was created by a sync stub before the Excel master
// upload populated these.
function readGroupName(item: { attributes?: Record<string, unknown> | null } | null | undefined): string | null {
  const v = item?.attributes && (item.attributes as Record<string, unknown>).group_name;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function readSubCategoryName(item: { attributes?: Record<string, unknown> | null } | null | undefined): string | null {
  const v = item?.attributes && (item.attributes as Record<string, unknown>).category_name;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function readGender(item: { attributes?: Record<string, unknown> | null } | null | undefined): string | null {
  const v = item?.attributes && (item.attributes as Record<string, unknown>).gender;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

// Trim history to the forecast lookback window (default: 12 months before
// the snapshot date). Keeps the compute payload small.
function historySince(snapshotDate: IpIsoDate, lookbackMonths = 12): IpIsoDate {
  const d = new Date(snapshotDate + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() - lookbackMonths);
  return d.toISOString().slice(0, 10);
}

// Build the pair list (customer, sku, category) from history + open
// requests. A pair makes it in if it has any history in the lookback OR
// has an open future-demand request in the horizon.
function resolvePairs(
  history: Array<{ customer_id: string; sku_id: string; category_id: string | null }>,
  requests: Array<{ customer_id: string; sku_id: string }>,
  itemCategoryBySku: Map<string, string | null>,
): Array<{ customer_id: string; sku_id: string; category_id: string | null }> {
  const seen = new Set<string>();
  const out: Array<{ customer_id: string; sku_id: string; category_id: string | null }> = [];
  function push(c: string, s: string, cat: string | null) {
    const k = `${c}:${s}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ customer_id: c, sku_id: s, category_id: cat });
  }
  for (const h of history) push(h.customer_id, h.sku_id, h.category_id ?? itemCategoryBySku.get(h.sku_id) ?? null);
  for (const r of requests) push(r.customer_id, r.sku_id, itemCategoryBySku.get(r.sku_id) ?? null);
  return out;
}

export interface RunForecastPassResult {
  run_id: string;
  forecast_rows_written: number;
  recommendations_written: number;
  pairs_considered: number;
  // Count of (customer, sku) pairs skipped because they had no demand
  // signal (no T3 history, no LY reference) AND no inventory presence
  // (no on-hand, on-PO, on-SO). These would forecast to zero anyway.
  pairs_pruned_dead: number;
  // Count of pairs skipped because the planner's grid filter excluded
  // them (e.g. "build only for Joggers / Customer X"). Zero when the
  // build was unfiltered.
  pairs_pruned_filter: number;
  methods: Record<IpForecastMethod, number>;
}

// Optional grid-derived filter applied at build time so the planner
// can scope a build to the rows currently visible in the grid (e.g.
// just one customer, just one category). Empty/missing fields mean
// "no filter on this dimension". customer_id matches forecast rows;
// the three string filters match against item-master attributes
// (group_name / category_name / gender).
export interface BuildFilter {
  customer_id?: string | null;
  // Style identity. When set, the build only processes pairs whose
  // item.style_code (or, for items without a style, sku_code) matches.
  style_code?: string | null;
  group_name?: string | null;
  sub_category_name?: string | null;
  gender?: string | null;
  // Period scoping is post-compute: forecast rows for non-matching
  // periods are dropped before upsert. The build still walks the
  // full horizon for rolling supply continuity, then trims at the
  // edge.
  period_code?: string | null;
  // Output-derived filters — included in the type so the planner's
  // grid can pass every dropdown through without the build call site
  // having to choose. Action / confidence / method are *outputs* of
  // the build, so applying them as inputs would force the pipeline
  // to throw away rows it just computed; we keep the build full and
  // surface these only as a hint in the build chip line.
  recommended_action?: string | null;
  confidence_level?: string | null;
  forecast_method?: string | null;
}

export interface RunForecastPassOptions {
  filter?: BuildFilter;
  // Best-effort cancellation. Aborting the signal causes the build to
  // throw `BuildCancelledError` at the next checkpoint (between phases
  // or between upsert chunks). Already-flushed rows are NOT rolled back.
  signal?: AbortSignal;
  // Status-bar callback. Fires once per phase boundary plus periodically
  // during the upsert phase (per chunk).
  onProgress?: (p: BuildProgress) => void;
}

export async function runForecastPass(run: IpPlanningRun, options: RunForecastPassOptions = {}): Promise<RunForecastPassResult> {
  if (!run.horizon_start || !run.horizon_end) {
    throw new Error("Planning run has no horizon; set horizon_start + horizon_end before running the forecast.");
  }
  const { signal, onProgress } = options;
  const snapshotDate = run.source_snapshot_date;
  const lookbackFrom = historySince(snapshotDate, 12);

  onProgress?.({ phase: "loading", label: "Loading sales, inventory, POs…" });
  checkAbort(signal);
  const [items, sales, requests, overrides, inv, pos, receipts, supplyPlaceholder] = await Promise.all([
    wholesaleRepo.listItems(),
    wholesaleRepo.listWholesaleSales(lookbackFrom),
    wholesaleRepo.listOpenRequests(),
    wholesaleRepo.listOverrides(run.id),
    wholesaleRepo.listInventorySnapshots(),
    wholesaleRepo.listOpenPos(),
    wholesaleRepo.listReceipts(lookbackFrom),
    wholesaleRepo.ensureSupplyPlaceholderCustomer(),
  ]);

  // De-dup overrides to the latest per grain (createdAt desc from repo).
  const latestOverrideByGrain = new Map<string, typeof overrides[number]>();
  for (const o of overrides) {
    const key = `${o.customer_id}:${o.sku_id}:${o.period_start}`;
    if (!latestOverrideByGrain.has(key)) latestOverrideByGrain.set(key, o);
  }

  const itemCategoryBySku = new Map<string, string | null>(items.map((i) => [i.id, i.category_id]));

  const historyInput: IpForecastComputeInput["history"] = sales
    // Only rows with a sku (defensive — fact table is FK-enforced but
    // joins can still surface nulls in dev data).
    .filter((s) => s.sku_id && s.customer_id)
    .map((s) => ({
      customer_id: s.customer_id!,
      sku_id: s.sku_id,
      category_id: s.category_id ?? itemCategoryBySku.get(s.sku_id) ?? null,
      txn_date: s.txn_date,
      qty: s.qty,
    }));

  const requestInput: IpForecastComputeInput["requests"] = requests.map((r) => {
    const period = monthOf(r.target_period_start);
    return {
      customer_id: r.customer_id,
      sku_id: r.sku_id,
      period_code: period.period_code,
      period_start: period.period_start,
      period_end: period.period_end,
      requested_qty: r.requested_qty,
      confidence_level: r.confidence_level,
    };
  });

  let pairs = resolvePairs(historyInput, requestInput, itemCategoryBySku);

  // Supply-only pairs: any SKU with open PO qty or on-SO qty but no
  // sales-history pair gets a synthetic forecast row under a "(Supply Only)"
  // placeholder customer so the planner can see incoming inventory.
  const skusWithSalesPair = new Set(pairs.map((p) => p.sku_id));
  const supplyOnlySkus = new Set<string>();
  for (const p of pos) {
    if (p.qty_open > 0 && !skusWithSalesPair.has(p.sku_id)) supplyOnlySkus.add(p.sku_id);
  }
  for (const s of inv) {
    if (((s.qty_committed ?? 0) > 0 || (s.qty_on_hand ?? 0) > 0) && !skusWithSalesPair.has(s.sku_id)) {
      supplyOnlySkus.add(s.sku_id);
    }
  }
  for (const skuId of supplyOnlySkus) {
    pairs.push({
      customer_id: supplyPlaceholder,
      sku_id: skuId,
      category_id: itemCategoryBySku.get(skuId) ?? null,
    });
  }

  // Dead-SKU prune. A pair has no demand signal AND no inventory presence
  // when ALL of these are zero:
  //   - trailing-3 history (last 3 months of sales for this customer/sku)
  //   - LY reference (sales 12 months back ±1mo for the snapshot)
  //   - on-hand qty (latest inventory snapshot)
  //   - on-PO qty (open POs for this sku)
  //   - on-SO qty (committed_so on the latest snapshot)
  // These rows would all forecast to zero anyway and just bloat the
  // grid + slow down the build. Skip them at pair time.
  const trailingT3Cutoff = historySince(snapshotDate, 3);
  const trailingT3BySkuCust = new Map<string, number>();
  for (const h of historyInput) {
    if (h.txn_date < trailingT3Cutoff) continue;
    const k = `${h.customer_id}:${h.sku_id}`;
    trailingT3BySkuCust.set(k, (trailingT3BySkuCust.get(k) ?? 0) + h.qty);
  }
  const lyCutoffStart = historySince(snapshotDate, 13);
  const lyCutoffEnd = historySince(snapshotDate, 11);
  const lyBySkuCust = new Map<string, number>();
  for (const h of historyInput) {
    if (h.txn_date < lyCutoffStart || h.txn_date > lyCutoffEnd) continue;
    const k = `${h.customer_id}:${h.sku_id}`;
    lyBySkuCust.set(k, (lyBySkuCust.get(k) ?? 0) + h.qty);
  }
  const onHandBySku = new Map<string, number>();
  const onSoBySku = new Map<string, number>();
  for (const s of inv) {
    onHandBySku.set(s.sku_id, (onHandBySku.get(s.sku_id) ?? 0) + (s.qty_on_hand ?? 0));
    onSoBySku.set(s.sku_id, (onSoBySku.get(s.sku_id) ?? 0) + (s.qty_committed ?? 0));
  }
  const onPoBySku = new Map<string, number>();
  for (const p of pos) {
    onPoBySku.set(p.sku_id, (onPoBySku.get(p.sku_id) ?? 0) + (p.qty_open ?? 0));
  }
  const beforePrune = pairs.length;
  pairs = pairs.filter((p) => {
    // Don't prune supply-only synthetic pairs — they exist precisely
    // because there's incoming inventory, so by definition they have
    // at least one of on-PO or on-hand or on-SO non-zero. Belt-and-
    // suspenders: keep them regardless.
    if (p.customer_id === supplyPlaceholder) return true;
    const k = `${p.customer_id}:${p.sku_id}`;
    const t3 = trailingT3BySkuCust.get(k) ?? 0;
    const ly = lyBySkuCust.get(k) ?? 0;
    const onH = onHandBySku.get(p.sku_id) ?? 0;
    const onPo = onPoBySku.get(p.sku_id) ?? 0;
    const onSo = onSoBySku.get(p.sku_id) ?? 0;
    return t3 > 0 || ly > 0 || onH > 0 || onPo > 0 || onSo > 0;
  });
  const prunedDeadCount = beforePrune - pairs.length;

  // Optional grid-derived filter — when the planner builds with the
  // grid filtered to e.g. "customer X / Joggers", scope the build
  // so we only process those pairs.
  let prunedFilterCount = 0;
  const filter = options.filter;
  const filterActive = !!filter && (
    filter.customer_id || filter.style_code || filter.group_name || filter.sub_category_name || filter.gender
  );
  if (filterActive) {
    const itemBySku = new Map(items.map((i) => [i.id, i]));
    const beforeFilter = pairs.length;
    pairs = pairs.filter((p) => {
      // Always keep the (Supply Only) synthetic — filtering it out by
      // customer_id would lose visibility on incoming inventory.
      if (p.customer_id === supplyPlaceholder) return true;
      if (filter!.customer_id && p.customer_id !== filter!.customer_id) return false;
      const item = itemBySku.get(p.sku_id);
      if (filter!.style_code) {
        const styleOnSku = item?.style_code ?? item?.sku_code ?? null;
        if (styleOnSku !== filter!.style_code) return false;
      }
      const attrs = (item?.attributes ?? null) as Record<string, unknown> | null;
      if (filter!.group_name) {
        const v = attrs?.group_name;
        if (typeof v !== "string" || v.trim() !== filter!.group_name) return false;
      }
      if (filter!.sub_category_name) {
        const v = attrs?.category_name;
        if (typeof v !== "string" || v.trim() !== filter!.sub_category_name) return false;
      }
      if (filter!.gender) {
        const v = attrs?.gender;
        if (typeof v !== "string" || v.trim() !== filter!.gender) return false;
      }
      return true;
    });
    prunedFilterCount = beforeFilter - pairs.length;
  }

  const computeInput: IpForecastComputeInput = {
    planning_run_id: run.id,
    source_snapshot_date: snapshotDate,
    methodPreference: run.forecast_method_preference ?? "ly_sales",
    horizon_start: run.horizon_start,
    horizon_end: run.horizon_end,
    pairs,
    history: historyInput,
    requests: requestInput,
    overrides: Array.from(latestOverrideByGrain.values()).map((o) => ({
      customer_id: o.customer_id,
      sku_id: o.sku_id,
      period_start: o.period_start,
      override_qty: o.override_qty,
    })),
  };

  checkAbort(signal);
  onProgress?.({ phase: "computing", label: `Computing forecast for ${pairs.length.toLocaleString()} pairs`, current: 0, total: pairs.length });
  let forecastRows = buildFinalWholesaleForecast(computeInput);

  // Period-scoped build — drop rows whose period_code doesn't match.
  // Done post-compute so rolling supply still walks the full horizon
  // even if only one period's rows persist.
  if (filter?.period_code) {
    const before = forecastRows.length;
    forecastRows = forecastRows.filter((f) => f.period_code === filter.period_code);
    prunedFilterCount += before - forecastRows.length;
  }

  checkAbort(signal);
  onProgress?.({ phase: "writing_forecast", label: `Writing forecast`, current: 0, total: forecastRows.length });
  await wholesaleRepo.upsertForecast(forecastRows, {
    signal,
    onProgress: (rowsDone, totalRows) => {
      onProgress?.({ phase: "writing_forecast", label: `Writing forecast`, current: rowsDone, total: totalRows });
    },
  });

  checkAbort(signal);
  onProgress?.({ phase: "reading_back", label: "Reading back persisted forecast" });
  // Read persisted rows — they carry planned_buy_qty from prior planner saves
  // (upsert preserves the column). Rolling supply must use these so buy qty
  // is reflected in recommendations.
  const persisted = await wholesaleRepo.listForecast(run.id);

  // Stale-row defence. `listForecast` returns every row for this run,
  // including rows written by PRIOR builds for (customer, sku) pairs
  // that the dead-SKU prune or grid filter just excluded. Without this
  // filter, recs are generated 1:1 from `persisted` and explode to
  // many times the size of forecastRows — that's the root of the
  // "1,134 forecast → 20,000 recs" cardinality blowup.
  const liveGrainKeys = new Set<string>(
    forecastRows.map((f) => `${f.customer_id}:${f.sku_id}:${f.period_start}`),
  );
  const relevantPersisted = persisted.filter((p) =>
    liveGrainKeys.has(`${p.customer_id}:${p.sku_id}:${p.period_start}`),
  );

  checkAbort(signal);
  onProgress?.({ phase: "computing_recs", label: "Generating recommendations", current: 0, total: relevantPersisted.length });
  const horizon = monthsBetween(run.horizon_start, run.horizon_end);
  const supplyBySkuPeriod = buildRollingWholesaleSupply(
    relevantPersisted,
    { inventorySnapshots: inv, openPos: pos, receipts },
    horizon,
  );
  const asOf = new Date().toISOString().slice(0, 10);
  const recs = generateWholesaleRecommendations(relevantPersisted, supplyBySkuPeriod, asOf);
  checkAbort(signal);
  onProgress?.({ phase: "writing_recs", label: `Writing recommendations`, current: 0, total: recs.length });
  await wholesaleRepo.replaceRecommendations(run.id, recs, {
    signal,
    onPhase: (label) => onProgress?.({ phase: "writing_recs", label }),
    onProgress: (rowsDone, totalRows) => {
      onProgress?.({ phase: "writing_recs", label: `Writing recommendations`, current: rowsDone, total: totalRows });
    },
  });
  onProgress?.({ phase: "done", label: "Done" });

  const methods: Record<IpForecastMethod, number> = {
    ly_sales: 0,
    trailing_avg_sku: 0,
    weighted_recent_sku: 0,
    cadence_sku: 0,
    category_fallback: 0,
    customer_category_fallback: 0,
    zero_floor: 0,
  };
  for (const r of forecastRows) methods[r.forecast_method]++;

  return {
    run_id: run.id,
    forecast_rows_written: forecastRows.length,
    recommendations_written: recs.length,
    pairs_considered: pairs.length,
    pairs_pruned_dead: prunedDeadCount,
    pairs_pruned_filter: prunedFilterCount,
    methods,
  };
}

// ── Override flow ──────────────────────────────────────────────────────────
export async function applyOverride(args: {
  forecast: IpWholesaleForecast;
  override_qty: number;
  reason_code: IpOverrideReasonCode;
  note?: string | null;
  created_by?: string | null;
}): Promise<IpWholesaleForecast> {
  const { forecast, override_qty, reason_code, note, created_by } = args;
  const final = Math.max(0, forecast.system_forecast_qty + forecast.buyer_request_qty + override_qty);
  // Audit log first so the current value on the forecast row always has
  // a trail behind it.
  await wholesaleRepo.createOverride({
    planning_run_id: forecast.planning_run_id,
    customer_id: forecast.customer_id,
    category_id: forecast.category_id,
    sku_id: forecast.sku_id,
    period_start: forecast.period_start,
    period_end: forecast.period_end,
    override_qty,
    reason_code,
    note: note ?? null,
    created_by: created_by ?? null,
  });
  return wholesaleRepo.patchForecastOverride(forecast.id, override_qty, final);
}

// ── Grid assembly ──────────────────────────────────────────────────────────
// Build the flat row shape the workbench renders. Joins masters, history
// trailing, supply context, and recommendations in memory (dataset is
// small enough in Phase 1; server-side view is Phase 2+).
export async function buildGridRows(run: IpPlanningRun): Promise<IpPlanningGridRow[]> {
  // listRecommendations was removed — the grid recomputes recommended
  // actions live via recommendForRow() against the rolling-supply pool,
  // and the persisted ip_wholesale_recommendations rows are never read
  // back here (they exist for audit/archival from the forecast pass).
  // Removing the read eliminates a 1k-row paginated query that timed
  // out (PostgREST 57014) once a run accumulated thousands of recs.
  const [items, customers, categories, forecast, sales, inv, pos, openSos, receipts, atsCostBySku, avgCostBySku, tbdRows, supplyPlaceholderId] = await Promise.all([
    wholesaleRepo.listItems(),
    wholesaleRepo.listCustomers(),
    wholesaleRepo.listCategories(),
    wholesaleRepo.listForecast(run.id),
    wholesaleRepo.listWholesaleSales(historySince(run.source_snapshot_date, 3)),
    wholesaleRepo.listInventorySnapshots(),
    wholesaleRepo.listOpenPos(),
    wholesaleRepo.listOpenSos(),
    wholesaleRepo.listReceipts(historySince(run.source_snapshot_date, 3)),
    wholesaleRepo.listAtsAvgCostBySku(),
    wholesaleRepo.listItemAvgCostBySku(),
    wholesaleRepo.listTbdRows(run.id),
    wholesaleRepo.ensureSupplyPlaceholderCustomer(),
  ]);

  const itemById = new Map(items.map((i) => [i.id, i]));
  const customerById = new Map(customers.map((c) => [c.id, c]));
  const categoryById = new Map(categories.map((c) => [c.id, c]));

  // Style-level fallback. Planner's Item Master Excel often has one row
  // per STYLE (e.g., "RYO0659" with description "MONEYMAKER Vrsty Jkt"),
  // while ATS / TandA / Xoro see VARIANTS ("RYO0659-BLACK", "RYO0659-RED").
  // Sync auto-stubs variants with no description, so joining grid →
  // forecast.sku_id → variant master row produces blanks. Index master
  // rows that have a description / unit_cost by style_code so the grid
  // can promote those values up to all variants.
  const masterByStyle = new Map<string, typeof items[number]>();
  for (const i of items) {
    if (!i.style_code) continue;
    if (!i.description && i.unit_cost == null) continue;
    const cur = masterByStyle.get(i.style_code);
    // Prefer shorter sku_code (style-only beats variant) so "RYO0659"
    // wins over "RYO0659-BLACK" when both have descriptions.
    const ourLen = i.sku_code?.length ?? Number.MAX_SAFE_INTEGER;
    const curLen = cur?.sku_code?.length ?? Number.MAX_SAFE_INTEGER;
    if (!cur || ourLen < curLen) masterByStyle.set(i.style_code, i);
  }
  const avgCostByStyle = new Map<string, number>();
  for (const i of items) {
    if (!i.style_code || !i.sku_code) continue;
    const cost = avgCostBySku.get(i.sku_code);
    if (cost != null && cost > 0 && !avgCostByStyle.has(i.style_code)) {
      avgCostByStyle.set(i.style_code, cost);
    }
  }
  // Separate cost index: any master row in the same style with a real
  // unit_cost wins. masterByStyle prefers shortest sku_code (best for
  // description) but that row may have no cost — without this second
  // index, RYO0659FP-BLACK/BLACK (desc set, cost null) would shadow
  // RYO0659FP-SLATE/OFFWHITE (desc set, cost 11.90).
  //
  // When multiple variants in the same style have a unit_cost, take
  // the max — sku_code-ASC iteration would otherwise let a deprecated
  // cheap variant win over a current one. Max isn't a perfect signal
  // but it's strictly more useful than first-seen for fallback display.
  const unitCostByStyle = new Map<string, number>();
  for (const i of items) {
    if (!i.style_code || i.unit_cost == null || i.unit_cost <= 0) continue;
    const cur = unitCostByStyle.get(i.style_code);
    if (cur == null || i.unit_cost > cur) unitCostByStyle.set(i.style_code, i.unit_cost);
  }
  // recByGrain removed — grid no longer joins persisted recommendations.
  // recommendForRow() runs live against rolling supply per row.

  const onHand = latestOnHandBySku(inv);
  // Per-(customer, sku, period_start) open-PO + open-SO qty, filtered
  // by expected_date / ship_date AND customer_id. Drives the grid's
  // "On PO" and "On SO" columns so a PO/SO landing in May only shows
  // on May rows, AND only on the customer row it was allocated to.
  // Stock POs and customer-less SOs route to the (Supply Only)
  // placeholder customer at sync time. POs/SOs without a date are
  // dropped — we can't bucket them into a period.
  const onPoByCustSkuPeriod = new Map<string, number>();
  const onSoByCustSkuPeriod = new Map<string, number>();
  {
    const periodWindows = Array.from(
      new Map(forecast.map((f) => [f.period_start, { start: f.period_start, end: f.period_end }])).values(),
    );
    for (const w of periodWindows) {
      for (const p of pos) {
        if (!p.expected_date) continue;
        if (p.expected_date < w.start || p.expected_date > w.end) continue;
        const custKey = p.customer_id ?? "supply_only";
        const k = `${custKey}:${p.sku_id}:${w.start}`;
        onPoByCustSkuPeriod.set(k, (onPoByCustSkuPeriod.get(k) ?? 0) + (p.qty_open ?? 0));
      }
      for (const so of openSos) {
        if (!so.ship_date) continue;
        if (so.ship_date < w.start || so.ship_date > w.end) continue;
        const custKey = so.customer_id ?? "supply_only";
        const k = `${custKey}:${so.sku_id}:${w.start}`;
        onSoByCustSkuPeriod.set(k, (onSoByCustSkuPeriod.get(k) ?? 0) + (so.qty_open ?? 0));
      }
    }
  }

  // Weighted-avg unit cost across open POs per SKU. Used as a fallback
  // when item master has no unit_cost / avg_cost (typical for SKUs the
  // master Excel hasn't covered yet but TandA already has POs for).
  const poCostBySku = new Map<string, number>();
  {
    const sumCostQty = new Map<string, { num: number; den: number }>();
    for (const p of pos) {
      const c = typeof p.unit_cost === "number" ? p.unit_cost : null;
      const q = typeof p.qty_open === "number" ? p.qty_open : 0;
      if (c == null || c <= 0 || q <= 0) continue;
      const acc = sumCostQty.get(p.sku_id) ?? { num: 0, den: 0 };
      acc.num += c * q;
      acc.den += q;
      sumCostQty.set(p.sku_id, acc);
    }
    for (const [skuId, { num, den }] of sumCostQty) {
      if (den > 0) poCostBySku.set(skuId, num / den);
    }
  }

  // Trailing-3 per (customer, sku).
  const trailing = new Map<string, number>();
  for (const s of sales) {
    const key = `${s.customer_id}:${s.sku_id}`;
    trailing.set(key, (trailing.get(key) ?? 0) + s.qty);
  }

  const asOf = new Date().toISOString().slice(0, 10);

  // Phase 2 supply model: the grid presents inventory as ONE shared pool
  // that rolls top-to-bottom across whatever rows the planner has on
  // screen. Service layer therefore returns per-row FACTS only — raw sku
  // on_hand, per-customer SO, sku receipts, planned buy — and the
  // rolling balance ("displayed OnHand" + "displayed ATS") is computed
  // by the grid component after sort+aggregate. See
  // WholesalePlanningGrid.tsx → applyRollingPool.
  //
  // We still expose `available_supply_qty` per row (= row's own
  // OH−SO+R+Buy) as a stable sortable fallback for code paths that don't
  // run the presentation roll (recommendation engine, scenario summary,
  // etc.). The grid overwrites it with the rolling value on render.
  const onPoBySku = openPoQtyBySku(pos);
  // Two separate maps now: receipts_due (future inbound POs) drives supply
  // math; historical_receipts (past actuals) is display-only since those
  // qtys are already in on_hand_qty.
  const receiptsBySkuPeriod = new Map<string, number>();
  const historicalReceiptsBySkuPeriod = new Map<string, number>();
  {
    const periodWindows = Array.from(
      new Map(forecast.map((f) => [f.period_start, { start: f.period_start, end: f.period_end }])).values(),
    );
    for (const skuId of new Set(forecast.map((f) => f.sku_id))) {
      for (const w of periodWindows) {
        receiptsBySkuPeriod.set(
          `${skuId}:${w.start}`,
          receiptsDueInPeriod({ openPos: pos }, skuId, w.start, w.end),
        );
        historicalReceiptsBySkuPeriod.set(
          `${skuId}:${w.start}`,
          historicalReceiptsInPeriod({ receipts }, skuId, w.start, w.end),
        );
      }
    }
  }
  const rows: IpPlanningGridRow[] = forecast.map((f) => {
    const item = itemById.get(f.sku_id);
    const customer = customerById.get(f.customer_id);
    const category = f.category_id ? categoryById.get(f.category_id) : null;
    const rawOnHand = onHand.get(f.sku_id) ?? 0;
    const rowOnSo = onSoByCustSkuPeriod.get(`${f.customer_id}:${f.sku_id}:${f.period_start}`) ?? 0;
    const rowReceipts = receiptsBySkuPeriod.get(`${f.sku_id}:${f.period_start}`) ?? 0;
    const rowBuy = f.planned_buy_qty ?? 0;
    const rowAvailable = Math.max(0, rawOnHand - rowOnSo + rowReceipts + rowBuy);
    // Synthesize a PeriodSupply-shaped object so liveRec keeps its existing
    // contract; rolling-pool effects are layered in by the grid itself.
    const supply = {
      on_hand_qty: rawOnHand,
      beginning_balance_qty: rawOnHand,
      on_po_qty: onPoBySku.get(f.sku_id) ?? 0,
      receipts_due_qty: rowReceipts,
      available_supply_qty: rowAvailable,
    };
    const styleFallback = item?.style_code ? masterByStyle.get(item.style_code) : null;
    const description = item?.description ?? styleFallback?.description ?? null;
    const colorResolved = resolveVariantColorWithProvenance(item?.color, item?.sku_code, item?.style_code);
    const colorDisplay = colorResolved.color;
    // Resolved master cost: variant.unit_cost > variant avg_cost > any
    // sibling-variant unit_cost in the same style > any sibling avg_cost.
    // Then PO weighted avg, then ATS snapshot avg.
    const masterCost =
      item?.unit_cost
      ?? (item?.sku_code ? avgCostBySku.get(item.sku_code) ?? null : null)
      ?? (item?.style_code ? unitCostByStyle.get(item.style_code) ?? null : null)
      ?? (item?.style_code ? avgCostByStyle.get(item.style_code) ?? null : null);
    const fallbackCost = poCostBySku.get(f.sku_id) ?? (item?.sku_code ? atsCostBySku.get(item.sku_code) ?? null : null);
    const resolvedCost = masterCost ?? fallbackCost ?? null;
    // Always derive avail/shortage/excess from the rolling supply so that
    // planned_buy_qty and the month-to-month roll are always current.
    // rec is kept only for action/reason labels (rebuilt on next forecast run).
    const avail = supply?.available_supply_qty ?? 0;
    const shortage = Math.max(0, f.final_forecast_qty - avail);
    const excess = Math.max(0, avail - f.final_forecast_qty);
    const liveRec = recommendForRow(f, { on_hand_qty: supply?.on_hand_qty ?? 0, on_po_qty: supply?.on_po_qty ?? 0, receipts_due_qty: supply?.receipts_due_qty ?? 0, available_supply_qty: avail }, asOf);
    return {
      forecast_id: f.id,
      planning_run_id: f.planning_run_id,
      customer_id: f.customer_id,
      customer_name: customer?.name ?? "(unknown customer)",
      category_id: f.category_id,
      category_name: category?.name ?? null,
      sku_id: f.sku_id,
      sku_code: item?.sku_code ?? "(unknown sku)",
      sku_description: description,
      sku_style: item?.style_code ?? null,
      sku_color: colorDisplay,
      sku_color_inferred: colorResolved.inferred || undefined,
      sku_size: item?.size ?? styleFallback?.size ?? null,
      // Item-master classification — falls back to a sibling variant in
      // the same style if the variant master row hasn't been populated yet.
      group_name: readGroupName(item) ?? readGroupName(styleFallback) ?? null,
      sub_category_name: readSubCategoryName(item) ?? readSubCategoryName(styleFallback) ?? null,
      gender: readGender(item) ?? readGender(styleFallback) ?? null,
      period_code: f.period_code,
      period_start: f.period_start,
      period_end: f.period_end,
      historical_trailing_qty: trailing.get(`${f.customer_id}:${f.sku_id}`) ?? 0,
      // Effective system: override wins when set, otherwise the
      // computed value. The original is preserved separately so the
      // grid tooltip can display "from X to Y on DATE".
      system_forecast_qty: f.system_forecast_qty_override ?? f.system_forecast_qty,
      system_forecast_qty_original: f.system_forecast_qty,
      system_forecast_qty_overridden_at: f.system_forecast_qty_overridden_at ?? null,
      system_forecast_qty_overridden_by: f.system_forecast_qty_overridden_by ?? null,
      buyer_request_qty: f.buyer_request_qty,
      override_qty: f.override_qty,
      final_forecast_qty: f.final_forecast_qty,
      confidence_level: f.confidence_level,
      forecast_method: f.forecast_method,
      ly_reference_qty: f.ly_reference_qty ?? null,
      item_cost: item?.unit_cost ?? (item?.style_code ? unitCostByStyle.get(item.style_code) ?? null : null) ?? null,
      ats_avg_cost: item?.sku_code ? (atsCostBySku.get(item.sku_code) ?? null) : null,
      avg_cost: resolvedCost,
      unit_cost_override: f.unit_cost_override ?? null,
      unit_cost: f.unit_cost_override ?? resolvedCost,
      planned_buy_qty: f.planned_buy_qty ?? null,
      on_hand_qty: supply?.beginning_balance_qty ?? onHand.get(f.sku_id) ?? 0,
      on_so_qty: onSoByCustSkuPeriod.get(`${f.customer_id}:${f.sku_id}:${f.period_start}`) ?? 0,
      on_po_qty: onPoByCustSkuPeriod.get(`${f.customer_id}:${f.sku_id}:${f.period_start}`) ?? 0,
      receipts_due_qty: supply?.receipts_due_qty ?? 0,
      historical_receipts_qty: historicalReceiptsBySkuPeriod.get(`${f.sku_id}:${f.period_start}`) ?? 0,
      available_supply_qty: avail,
      projected_shortage_qty: shortage,
      projected_excess_qty: excess,
      recommended_action: liveRec.recommended_action,
      recommended_qty: liveRec.recommended_qty,
      action_reason: liveRec.action_reason,
      notes: f.notes,
    };
  });

  // ── TBD synthetic stock-buy rows ─────────────────────────────────────────
  // One row per (style_code, period) — surfaced in the grid as a
  // "(Supply Only) TBD" line. Aggregate Buyer / Override / Buy edits
  // route here instead of distributing across real customer rows.
  // These rows are lazy: until the planner types into one, no
  // ip_wholesale_forecast_tbd record exists. Any persisted edits in
  // tbdRows are overlaid onto the synthetic per-(style, period)
  // entry (matched by style_code + period_start; per-style we expect
  // at most one row, since the dropdown / cell edits keep that
  // invariant). A planner who has reassigned a TBD row to a real
  // customer will see it under that customer instead — we still
  // synthesize a fresh "(Supply Only) TBD" line for the now-vacated
  // slot so they always have a place to type stock buys against.
  const supplyCust = customerById.get(supplyPlaceholderId);
  const supplyCustomerName = supplyCust?.name ?? "(Supply Only)";

  // Set of every color any item-master variant carries (case-
  // insensitive). The TBD picker is category-wide, so the auto-clear
  // here matches that scope: once the typed color exists ANYWHERE in
  // the master, is_new_color drops on the next refresh. The planner
  // gets one build cycle of the orange "NEW COLOR" badge, then it
  // disappears.
  const allKnownColorsLowerMaster = new Set<string>();
  for (const it of items) {
    if (!it.color) continue;
    const c = it.color.trim();
    if (!c) continue;
    allKnownColorsLowerMaster.add(c.toLowerCase());
  }
  const isKnownColor = (_style: string | null, color: string | null): boolean => {
    if (!color) return false;
    return allKnownColorsLowerMaster.has(color.trim().toLowerCase());
  };

  // Build (style_code, period) tuple set. Sourced from BOTH the
  // forecast rows (so every style with at least one demand pair gets
  // a synthetic TBD line) and the persisted tbd rows (so a planner-
  // added TBD line with a style the master doesn't know — e.g. the
  // literal "TBD" placeholder from "+ Add row" — still renders).
  // Most-common-gender per (group_name, sub_category_name) pair —
  // used to infer the gender for planner-added TBD rows whose style
  // isn't in the master yet. Without this, the planner-added row
  // has gender=null and silently vanishes when a gender filter is
  // active (and saves under the wrong scope downstream).
  const genderByCatSubCat = new Map<string, string>();
  {
    const counts = new Map<string, Map<string, number>>();
    for (const i of items) {
      const g = readGender(i);
      if (!g) continue;
      const cat = readGroupName(i) ?? "";
      const sub = readSubCategoryName(i) ?? "";
      const key = `${cat}|${sub}`;
      let m = counts.get(key);
      if (!m) { m = new Map(); counts.set(key, m); }
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    for (const [key, m] of counts) {
      let bestG: string | null = null;
      let bestN = 0;
      for (const [g, n] of m) {
        if (n > bestN) { bestG = g; bestN = n; }
      }
      if (bestG) genderByCatSubCat.set(key, bestG);
    }
  }

  type StylePeriod = { style_code: string; period_code: string; period_start: string; period_end: string };
  const stylePeriods = new Map<string, StylePeriod>();
  // Track which (style, period) entries came from real forecast
  // demand vs only from a tbdRows entry. The synthetic catch-all
  // line should NOT be auto-emitted for tbd-only entries with no
  // (Supply Only) supply row — otherwise a planner who typed a
  // brand-new style on a real customer ends up with a phantom
  // "(Supply Only) TBD" row at the top of the grid carrying no
  // category, no qty, just clutter.
  const forecastStylePeriods = new Set<string>();
  for (const f of forecast) {
    const item = itemById.get(f.sku_id);
    const style = item?.style_code;
    if (!style) continue;
    const k = `${style}|${f.period_start}`;
    forecastStylePeriods.add(k);
    if (!stylePeriods.has(k)) {
      stylePeriods.set(k, { style_code: style, period_code: f.period_code, period_start: f.period_start, period_end: f.period_end });
    }
  }
  for (const t of tbdRows) {
    const k = `${t.style_code}|${t.period_start}`;
    if (!stylePeriods.has(k)) {
      stylePeriods.set(k, { style_code: t.style_code, period_code: t.period_code, period_start: t.period_start, period_end: t.period_end });
    }
  }
  // Always synthesize a catch-all (style="TBD", color="TBD") slot for
  // every period seen in the run. Aggregate edits at collapse modes
  // that span multiple styles (e.g. By Sub Cat / By Category)
  // route here when no single style owns the bucket — the planner
  // gets a single visible "stock buy" row to type against. The
  // catch-all uses a synthetic stylePeriod entry; the row renders
  // even before the planner has typed anything.
  const periodsSeen = new Map<string, { period_code: string; period_start: string; period_end: string }>();
  for (const sp of stylePeriods.values()) {
    if (!periodsSeen.has(sp.period_start)) {
      periodsSeen.set(sp.period_start, { period_code: sp.period_code, period_start: sp.period_start, period_end: sp.period_end });
    }
  }
  for (const p of periodsSeen.values()) {
    const k = `TBD|${p.period_start}`;
    if (!stylePeriods.has(k)) {
      stylePeriods.set(k, { style_code: "TBD", period_code: p.period_code, period_start: p.period_start, period_end: p.period_end });
    }
  }
  // Index persisted TBD rows by the same (style_code, period_start)
  // grain so we can overlay them onto the synthetic rows.
  type TbdRow = (typeof tbdRows)[number];
  const tbdByKey = new Map<string, TbdRow[]>();
  for (const t of tbdRows) {
    const k = `${t.style_code}|${t.period_start}`;
    let bucket = tbdByKey.get(k);
    if (!bucket) { bucket = []; tbdByKey.set(k, bucket); }
    bucket.push(t);
  }
  // Pull category metadata from the style master so a TBD row
  // displays under the right Category / Sub Cat / Gender.
  const tbdGridRows: IpPlanningGridRow[] = [];
  for (const [key, sp] of stylePeriods) {
    const persistedAll = tbdByKey.get(key) ?? [];
    // For Phase 1 the natural representation is one TBD row per
    // (style, period) under (Supply Only). Extra persisted rows
    // (after a future "reassign customer" or "rename color" feature
    // ships) are surfaced as their own grid lines below.
    const supplyTbd = persistedAll.find((t) => t.customer_id === supplyPlaceholderId && t.color === "TBD") ?? null;
    const styleFb = masterByStyle.get(sp.style_code) ?? null;
    // For TBD rows, the planner-typed `notes` value (if any) acts
    // as the description override — gives a working description on
    // brand-new styles whose master row hasn't been created yet.
    // Falls back to the master's description when notes is empty.
    const description = supplyTbd?.notes?.trim() || styleFb?.description || null;
    const groupName = readGroupName(styleFb) ?? null;
    const subCategoryName = readSubCategoryName(styleFb) ?? null;
    let gender = readGender(styleFb) ?? null;
    // Best-effort gender inference for planner-added new styles
    // (no master row exists yet). Pulls the most common gender from
    // sibling styles in the same (group_name, sub_category_name).
    if (!gender) {
      const siblingCat = supplyTbd?.group_name ?? groupName ?? "";
      const siblingSub = supplyTbd?.sub_category_name ?? subCategoryName ?? "";
      gender = genderByCatSubCat.get(`${siblingCat}|${siblingSub}`) ?? null;
    }
    // Skip the synthetic supply line whenever the style is NOT
    // the canonical "TBD" catch-all AND the supplyTbd backing row
    // (if any) is not a real planner add. The synthetic / catch-
    // all line ONLY makes sense for "TBD"|period (the multi-style
    // routing target). For any specific style, the row should
    // exist iff a planner explicitly added it — the per-row loop
    // below emits those.
    //
    // This also kills the leftover "phantom" rows for non-TBD
    // styles whose backing DB row got is_user_added=false from the
    // earlier mergeBucket-leakage bug (planner clicked TbdStyleCell
    // on what looked like an aggregate header and patched the auto
    // catch-all to a custom style code). Those rows should not
    // render — they're stranded auto rows with the wrong style.
    const isTbdCatchAll = sp.style_code === "TBD";
    const hasForecast = forecastStylePeriods.has(key);
    const supplyTbdIsRealAdd = !!supplyTbd?.is_user_added;
    const skipSynthetic = !isTbdCatchAll && !supplyTbdIsRealAdd && !hasForecast;
    if (!skipSynthetic) {
    // Synthetic (Supply Only) TBD line — always rendered; overlays
    // persisted qty/cost when supplyTbd exists.
    tbdGridRows.push({
      forecast_id: supplyTbd ? `tbd:${supplyTbd.id}` : `tbd:synthetic:${sp.style_code}:${sp.period_start}`,
      planning_run_id: run.id,
      customer_id: supplyPlaceholderId,
      customer_name: supplyCustomerName,
      category_id: null,
      category_name: null,
      group_name: supplyTbd?.group_name ?? groupName,
      sub_category_name: supplyTbd?.sub_category_name ?? subCategoryName,
      gender,
      sku_id: `tbd:${sp.style_code}`,
      sku_code: `${sp.style_code}-TBD`,
      sku_description: description,
      sku_style: sp.style_code,
      sku_color: supplyTbd?.color ?? "TBD",
      sku_color_inferred: false,
      is_tbd: true,
      // Auto-clear: if the planner-typed color is now in the master,
      // the row is no longer "new" — even if it was flagged when
      // saved. This is the only place the flag gets cleared without
      // an explicit edit.
      is_new_color: supplyTbd && supplyTbd.is_new_color && !isKnownColor(sp.style_code, supplyTbd.color)
        ? true
        : false,
      is_user_added: supplyTbd?.is_user_added ?? false,
      tbd_id: supplyTbd?.id,
      tbd_updated_at: supplyTbd?.updated_at,
      sku_size: null,
      period_code: sp.period_code,
      period_start: sp.period_start as IpIsoDate,
      period_end: sp.period_end as IpIsoDate,
      historical_trailing_qty: 0,
      system_forecast_qty: 0,
      system_forecast_qty_original: 0,
      system_forecast_qty_overridden_at: null,
      system_forecast_qty_overridden_by: null,
      buyer_request_qty: supplyTbd?.buyer_request_qty ?? 0,
      override_qty: supplyTbd?.override_qty ?? 0,
      final_forecast_qty: supplyTbd?.final_forecast_qty ?? 0,
      confidence_level: "estimate",
      forecast_method: "zero_floor",
      ly_reference_qty: null,
      item_cost: null,
      ats_avg_cost: null,
      avg_cost: supplyTbd?.unit_cost ?? null,
      unit_cost_override: null,
      unit_cost: supplyTbd?.unit_cost ?? null,
      planned_buy_qty: supplyTbd?.planned_buy_qty ?? null,
      on_hand_qty: 0,
      on_so_qty: 0,
      on_po_qty: 0,
      receipts_due_qty: 0,
      historical_receipts_qty: 0,
      available_supply_qty: 0,
      projected_shortage_qty: 0,
      projected_excess_qty: 0,
      recommended_action: "monitor",
      recommended_qty: null,
      action_reason: null,
      notes: supplyTbd?.notes ?? null,
    });
    }
    // Any other persisted TBD rows for this (style, period) (e.g.
    // a planner reassigned color/customer in a future phase) become
    // their own grid lines so the planner can see and edit them.
    for (const t of persistedAll) {
      if (supplyTbd && t.id === supplyTbd.id) continue;
      const cust = customerById.get(t.customer_id);
      tbdGridRows.push({
        forecast_id: `tbd:${t.id}`,
        planning_run_id: run.id,
        customer_id: t.customer_id,
        customer_name: cust?.name ?? "(unknown customer)",
        category_id: null,
        category_name: null,
        group_name: t.group_name ?? groupName,
        sub_category_name: t.sub_category_name ?? subCategoryName,
        gender,
        sku_id: `tbd:${sp.style_code}`,
        sku_code: `${sp.style_code}-TBD`,
        sku_description: t.notes?.trim() || description,
        sku_style: sp.style_code,
        sku_color: t.color,
        sku_color_inferred: false,
        is_tbd: true,
        is_new_color: t.is_new_color && !isKnownColor(sp.style_code, t.color),
        is_user_added: t.is_user_added,
        tbd_id: t.id,
        tbd_updated_at: t.updated_at,
        sku_size: null,
        period_code: sp.period_code,
        period_start: sp.period_start as IpIsoDate,
        period_end: sp.period_end as IpIsoDate,
        historical_trailing_qty: 0,
        system_forecast_qty: 0,
        system_forecast_qty_original: 0,
        system_forecast_qty_overridden_at: null,
        system_forecast_qty_overridden_by: null,
        buyer_request_qty: t.buyer_request_qty,
        override_qty: t.override_qty,
        final_forecast_qty: t.final_forecast_qty,
        confidence_level: "estimate",
        forecast_method: "zero_floor",
        ly_reference_qty: null,
        item_cost: null,
        ats_avg_cost: null,
        avg_cost: t.unit_cost ?? null,
        unit_cost_override: null,
        unit_cost: t.unit_cost ?? null,
        planned_buy_qty: t.planned_buy_qty ?? null,
        on_hand_qty: 0,
        on_so_qty: 0,
        on_po_qty: 0,
        receipts_due_qty: 0,
        historical_receipts_qty: 0,
        available_supply_qty: 0,
        projected_shortage_qty: 0,
        projected_excess_qty: 0,
        recommended_action: "monitor",
        recommended_qty: null,
        action_reason: null,
        notes: t.notes,
      });
    }
  }

  return [...rows, ...tbdGridRows];
}
