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
import { WHOLESALE_WAREHOUSES } from "../config/warehouses";
import type {
  IpForecastComputeInput,
  IpForecastMethod,
  IpFutureDemandRequest,
  IpOverrideReasonCode,
  IpPlanningGridRow,
  IpPlanningRun,
  IpWholesaleForecast,
} from "../types/wholesale";
import {
  buildFinalWholesaleForecast,
  buildRollingWholesaleSupply,
  classifyAbcXyz,
  generateWholesaleRecommendations,
  historicalReceiptsInPeriod,
  latestOnHandBySku,
  monthOf,
  monthOffset,
  monthsBetween,
  openPoQtyBySku,
  receiptsDueInPeriod,
  recommendForRow,
} from "../compute";
import { wholesaleRepo, BuildCancelledError } from "./wholesalePlanningRepository";
import { resolveVariantColorWithProvenance } from "./resolveVariantColor";
import { parseRequestNote } from "./requestNoteMarker";

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

import { readGender, readGroupName, readSubCategoryName, readSeason } from "../types/itemAttributes";
import { buildSiblingMap } from "../../shared/costResolution";
import {
  baseColorKey,
  buildPoEachCostByBaseColor,
  buildPoEachCostByStyle,
  familyStyleOf,
  resolvePackSize,
  styleKey,
  type PlanningCostMaps,
  type PoCostRow,
} from "../utils/poCostFallback";
import {
  buildVendorCostMaps,
  cascadeVendorAwareCostForItem,
  type VendorCostMaps,
  type VendorPoCostRow,
} from "../utils/vendorCostCascade";

// Trim history to the forecast lookback window. Default 13 months so the
// LY ±1 buffer (months 11/12/13 before snapshot — see baselineForPairLy)
// has full coverage of LY-1. Day is rounded to 1 so an arbitrary snapshot
// day-of-month doesn't clip the leading edge of the LY-1 month.
//
// Example: snapshot 2026-04-26 with lookback=13 -> 2025-03-01 (covers all
// of March 2025, the LY-1 month). Without start-of-month rounding the
// cutoff would be 2025-03-26 and any txn before the 26th in that month
// would be dropped — exactly the bug that hid RYB0412/Ross Procurement's
// 2025-03-18 sale from the SP/LY column.
function historySince(snapshotDate: IpIsoDate, lookbackMonths = 13): IpIsoDate {
  const d = new Date(snapshotDate + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() - lookbackMonths);
  d.setUTCDate(1);
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
  // Open future-demand requests this build folded into the forecast.
  // Their status is flipped from "open" → "applied" at the end of the
  // build so the planner can see at a glance which requests are
  // already accounted for vs still pending.
  requests_applied: number;
  pairs_considered: number;
  // Count of (customer, sku) pairs skipped because they had no demand
  // signal (no T3 history, no LY reference) AND no inventory presence
  // (no on-hand, on-PO, on-SO). These would forecast to zero anyway.
  pairs_pruned_dead: number;
  // Count of pairs skipped because the planner's grid filter excluded
  // them (e.g. "build only for Joggers / Customer X"). Zero when the
  // build was unfiltered.
  pairs_pruned_filter: number;
  // Pairs seeded to honor the build filter even when they have no history —
  // the filter-selected products that would otherwise not have built.
  pairs_seeded_filter: number;
  // True when the grid's period filter selected only month(s) OUTSIDE the
  // run's horizon. Applying it would have dropped every computed row and
  // silently written an empty build, so the build IGNORES the period filter
  // and sets this flag — the UI warns the planner their period filter didn't
  // match the horizon.
  period_filter_out_of_horizon: boolean;
  methods: Record<IpForecastMethod, number>;
}

// Optional grid-derived filter applied at build time so the planner
// can scope a build to the rows currently visible in the grid (e.g.
// just one customer, just one category). Empty/missing fields mean
// "no filter on this dimension". customer_id matches forecast rows;
// the three string filters match against item-master attributes
// (group_name / category_name / gender).
// Every INPUT dimension the planner can filter the grid by is honored as a
// multi-value array (customer_ids / style_codes / group_names /
// sub_category_names / genders / period_codes) so a filtered build scopes to
// exactly the grid's current selection — the whole point of a filtered build.
// The single-value fields (customer_id / style_code / …) are kept for legacy
// callers; when both are present, the array wins. (recommended_action /
// confidence_level / forecast_method are build OUTPUTS, not inputs — see below.)
export interface BuildFilter {
  customer_id?: string | null;
  customer_ids?: string[] | null;
  // Style identity. When set, the build only processes pairs whose
  // item.style_code (or, for items without a style, sku_code) matches.
  // style_codes (array) scopes a build to SEVERAL styles at once — the
  // planner picks N styles in the grid's Style filter and rebuilds just
  // those. The single style_code stays for legacy callers; when both are
  // present, style_codes wins.
  style_code?: string | null;
  style_codes?: string[] | null;
  group_name?: string | null;
  group_names?: string[] | null;
  sub_category_name?: string | null;
  sub_category_names?: string[] | null;
  gender?: string | null;
  genders?: string[] | null;
  // Style Master season (attributes.season via the Tangerine overlay).
  season?: string | null;
  seasons?: string[] | null;
  // Period scoping is post-compute: forecast rows for non-matching
  // periods are dropped before upsert. The build still walks the
  // full horizon for rolling supply continuity, then trims at the
  // edge. Multi-period builds pass period_codes (an array); the
  // single-string period_code stays for legacy callers.
  period_code?: string | null;
  period_codes?: string[] | null;
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

// Per-pair decision for a filtered build. Exported for unit testing.
//
// Product-attribute filters (style_code / group_name / sub_category_name /
// gender) apply to ALL pairs, INCLUDING supply-only synthetics — so a
// filtered build (e.g. "Cargo Shorts") only surfaces incoming inventory
// within that product scope instead of every SKU that happens to have an
// open PO. (Previously supply-only rows were exempted from the filter
// entirely, which meant a "Cargo Shorts" build pulled in ~1k unrelated
// SKUs — denim, etc. — that had inbound POs.)
//
// The CUSTOMER filter still applies to real demand pairs only: supply-only
// rows carry the placeholder customer and represent customer-agnostic
// incoming inventory, so filtering by customer alone must not drop them.
// Open future-demand requests likewise always survive (real pairs only).
export function pairPassesBuildFilter(
  filter: BuildFilter,
  opts: {
    isSupplyOnly: boolean;
    hasOpenRequest: boolean;
    customerId: string;
    item: { style_code?: string | null; sku_code?: string | null; attributes?: unknown } | undefined;
  },
): boolean {
  const { isSupplyOnly, hasOpenRequest, customerId, item } = opts;
  if (!isSupplyOnly && hasOpenRequest) return true;
  // Customer filter applies to real demand pairs only (supply-only rows carry
  // the placeholder customer = customer-agnostic incoming inventory).
  if (!isSupplyOnly) {
    if (filter.customer_ids && filter.customer_ids.length > 0) {
      if (!filter.customer_ids.includes(customerId)) return false;
    } else if (filter.customer_id && customerId !== filter.customer_id) {
      return false;
    }
  }
  const styleOnSku = item?.style_code ?? item?.sku_code ?? null;
  if (filter.style_codes && filter.style_codes.length > 0) {
    if (!styleOnSku || !filter.style_codes.includes(styleOnSku)) return false;
  } else if (filter.style_code) {
    if (styleOnSku !== filter.style_code) return false;
  }
  const attrs = (item?.attributes ?? null) as Record<string, unknown> | null;
  // Match a trimmed string attribute against a single value or an array.
  const attrMatches = (raw: unknown, one: string | null | undefined, many: string[] | null | undefined): boolean => {
    if (many && many.length > 0) {
      return typeof raw === "string" && many.includes(raw.trim());
    }
    if (one) {
      return typeof raw === "string" && raw.trim() === one;
    }
    return true; // no filter on this dimension
  };
  if (!attrMatches(attrs?.group_name, filter.group_name, filter.group_names)) return false;
  if (!attrMatches(attrs?.category_name, filter.sub_category_name, filter.sub_category_names)) return false;
  if (!attrMatches(attrs?.gender, filter.gender, filter.genders)) return false;
  if (!attrMatches(attrs?.season, filter.season, filter.seasons)) return false;
  return true;
}

// True when the filter names a PRODUCT dimension (style / group / sub-cat /
// gender / season) — the only case that seeds new pairs (a customer-only
// filter already covers everything that customer buys; seeding all SKUs for
// them is neither wanted nor bounded).
export function buildFilterHasProductScope(filter: BuildFilter): boolean {
  const any = (a?: string[] | null) => !!a && a.length > 0;
  return !!(filter.style_code || any(filter.style_codes)
    || filter.group_name || any(filter.group_names)
    || filter.sub_category_name || any(filter.sub_category_names)
    || filter.gender || any(filter.genders)
    || filter.season || any(filter.seasons));
}

export interface SeedPairInput {
  existingPairs: Array<{ customer_id: string; sku_id: string }>;
  filter: BuildFilter;
  items: Array<{ id: string; style_code?: string | null; sku_code?: string | null; attributes?: unknown }>;
  itemCategoryBySku: Map<string, string | null>;
  supplyPlaceholder: string;
}

// Honor the build filter even with NO history: for every product the filter
// selects, ensure the filter's customers get a (customer, sku) pair so the
// style is built (as zero-forecast rows the planner can then plan) instead of
// silently absent. CEO 2026-07-22: "any filters selected to create a build are
// to be honored for the build even if there is not historical information."
//
// Returns ONLY the pairs to ADD (those not already present). No product scope
// → no seeding. Seed customers = the filter's customers, else the run's real
// demand customers, else the supply placeholder. Seed SKUs = every item that
// matches the product-attribute filter.
export function seedFilterPairs(input: SeedPairInput): Array<{ customer_id: string; sku_id: string; category_id: string | null }> {
  const { existingPairs, filter, items, itemCategoryBySku, supplyPlaceholder } = input;
  if (!buildFilterHasProductScope(filter)) return [];

  let seedCustomers: string[];
  if (filter.customer_ids && filter.customer_ids.length > 0) seedCustomers = [...new Set(filter.customer_ids)];
  else if (filter.customer_id) seedCustomers = [filter.customer_id];
  else {
    const real = [...new Set(existingPairs.map((p) => p.customer_id).filter((c) => c && c !== supplyPlaceholder))];
    seedCustomers = real.length > 0 ? real : [supplyPlaceholder];
  }

  // Items matching the PRODUCT filter — isSupplyOnly:true short-circuits the
  // customer check so only style/group/sub-cat/gender are tested.
  const seedItems = items.filter((it) =>
    pairPassesBuildFilter(filter, { isSupplyOnly: true, hasOpenRequest: false, customerId: "", item: it }));

  const existing = new Set(existingPairs.map((p) => `${p.customer_id}:${p.sku_id}`));
  const out: Array<{ customer_id: string; sku_id: string; category_id: string | null }> = [];
  const added = new Set<string>();
  for (const cust of seedCustomers) {
    for (const it of seedItems) {
      const k = `${cust}:${it.id}`;
      if (existing.has(k) || added.has(k)) continue;
      added.add(k);
      out.push({ customer_id: cust, sku_id: it.id, category_id: itemCategoryBySku.get(it.id) ?? null });
    }
  }
  return out;
}

export async function runForecastPass(run: IpPlanningRun, options: RunForecastPassOptions = {}): Promise<RunForecastPassResult> {
  if (!run.horizon_start || !run.horizon_end) {
    throw new Error("Planning run has no horizon; set horizon_start + horizon_end before running the forecast.");
  }
  const { signal, onProgress } = options;
  const snapshotDate = run.source_snapshot_date;
  const lookbackFrom = historySince(snapshotDate);

  onProgress?.({ phase: "loading", label: "Loading sales, inventory, POs…" });
  checkAbort(signal);
  const [items, sales, requests, overrides, inv, pos, openSos, receipts, supplyPlaceholder] = await Promise.all([
    wholesaleRepo.listItems(),
    wholesaleRepo.listWholesaleSales(lookbackFrom),
    // listActiveRequestsForBuild = open + applied. Build needs both
    // so that already-applied requests stay folded into the forecast
    // on every rebuild instead of silently dropping out after the
    // first build flipped their status.
    wholesaleRepo.listActiveRequestsForBuild(),
    wholesaleRepo.listOverrides(run.id),
    wholesaleRepo.listInventorySnapshots(WHOLESALE_WAREHOUSES),
    wholesaleRepo.listOpenPos(),
    // Load openSos so buildRollingWholesaleSupply can deduct SO
    // commitments in their ship-month (Phase 2 SO-by-month accuracy
    // fix). Without this, the rolling supply call on line 390 below
    // ReferenceError'd "openSos is not defined".
    wholesaleRepo.listOpenSos(),
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
      // qty_units is the authoritative unit-grain value (handles
      // mixed pack/unit-grain prepack rows). Fallback to qty when the
      // sync handler hasn't backfilled the column yet — see
      // 20260517230000_sales_history_grain_and_margin.sql.
      qty: s.qty_units ?? s.qty,
    }));

  // Parse a request's note marker once. The form encodes the
  // planner's actual (cat, subcat, style, color, desc) intent there
  // because the FK on ip_future_demand_requests forced an arbitrary
  // sku_id pin when either dim was TBD.
  const parseRequestMeta = (r: IpFutureDemandRequest) => parseRequestNote(r.note).meta;

  // Resolve the request's stored sku_id to a real master variant
  // matching the planner's intended style + color. Strategy mirrors
  // the form's resolveSkuId: exact match → any variant of the real
  // style → keep stored.
  const resolveRequestSku = (r: IpFutureDemandRequest): string => {
    const meta = parseRequestMeta(r);
    const style = meta.style;
    const color = meta.color;
    if (!style || style.toUpperCase() === "TBD") return r.sku_id;
    if (color && color.toUpperCase() !== "TBD") {
      for (const i of items) {
        if ((i.style_code ?? i.sku_code) === style && i.color === color) return i.id;
      }
    }
    for (const i of items) {
      if ((i.style_code ?? i.sku_code) === style) return i.id;
    }
    return r.sku_id;
  };

  // Split requests by color intent. A request gets routed to the
  // ip_wholesale_forecast_tbd table (instead of folding into the
  // regular forecast) when ANY of:
  //   • meta.color is literally "TBD" (planner deferred the colorway)
  //   • meta.color is a real color but the picked style doesn't have
  //     a matching master variant — folding it into the resolved sku
  //     (any variant of the style) would surface the qty under the
  //     wrong master color in the grid. The TBD path renders it
  //     correctly under the planner's intended (style, color).
  // The remaining regularRequests have an exact master variant and
  // can fold into the forecast at the resolved sku grain.
  const masterColorsByStyle = new Map<string, Set<string>>();
  for (const i of items) {
    const s = i.style_code ?? i.sku_code;
    if (!s || !i.color) continue;
    let bucket = masterColorsByStyle.get(s);
    if (!bucket) { bucket = new Set(); masterColorsByStyle.set(s, bucket); }
    bucket.add(i.color);
  }
  const allMasterColors = new Set<string>();
  for (const i of items) if (i.color) allMasterColors.add(i.color);
  const tbdColorRequests: IpFutureDemandRequest[] = [];
  const regularRequests: IpFutureDemandRequest[] = [];
  for (const r of requests) {
    const meta = parseRequestMeta(r);
    const colorIsTbd = !!meta.color && meta.color.toUpperCase() === "TBD";
    const styleColors = meta.style ? masterColorsByStyle.get(meta.style) : null;
    const newToStyle = !!meta.color && !colorIsTbd && !styleColors?.has(meta.color);
    if (colorIsTbd || newToStyle) {
      tbdColorRequests.push(r);
    } else {
      regularRequests.push(r);
    }
  }

  const requestInput: IpForecastComputeInput["requests"] = regularRequests.map((r) => {
    const period = monthOf(r.target_period_start);
    return {
      customer_id: r.customer_id,
      sku_id: resolveRequestSku(r),
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
  // Pairs that carry an OPEN future-demand request must survive the
  // dead-SKU prune even when they have no T3 / LY / inventory signal.
  // Without this, a request for a brand-new (customer, sku) — exactly
  // the case the request feature was designed for — gets pruned out,
  // never reaches applyBuyerRequests, and never appears in the grid.
  // The user reported 5 open requests built into a fresh run with no
  // matching forecast rows; root cause was this prune.
  const pairsWithOpenRequest = new Set<string>();
  for (const r of requests) {
    pairsWithOpenRequest.add(`${r.customer_id}:${r.sku_id}`);
  }

  const beforePrune = pairs.length;
  pairs = pairs.filter((p) => {
    // Don't prune supply-only synthetic pairs — they exist precisely
    // because there's incoming inventory, so by definition they have
    // at least one of on-PO or on-hand or on-SO non-zero. Belt-and-
    // suspenders: keep them regardless.
    if (p.customer_id === supplyPlaceholder) return true;
    const k = `${p.customer_id}:${p.sku_id}`;
    if (pairsWithOpenRequest.has(k)) return true;
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
  const anyArray = (a?: string[] | null) => !!a && a.length > 0;
  const filterActive = !!filter && (
    filter.customer_id || anyArray(filter.customer_ids)
    || filter.style_code || anyArray(filter.style_codes)
    || filter.group_name || anyArray(filter.group_names)
    || filter.sub_category_name || anyArray(filter.sub_category_names)
    || filter.gender || anyArray(filter.genders)
  );
  let seededFilterCount = 0;
  if (filterActive) {
    const itemBySku = new Map(items.map((i) => [i.id, i]));
    const beforeFilter = pairs.length;
    pairs = pairs.filter((p) => pairPassesBuildFilter(filter!, {
      isSupplyOnly: p.customer_id === supplyPlaceholder,
      hasOpenRequest: pairsWithOpenRequest.has(`${p.customer_id}:${p.sku_id}`),
      customerId: p.customer_id,
      item: itemBySku.get(p.sku_id),
    }));
    prunedFilterCount = beforeFilter - pairs.length;
    // Honor the filter even without history: seed the selected products for the
    // filter's customers so they build as (zero-forecast) rows rather than
    // vanishing. Added after the prune + filter so they can't be pruned.
    const seeded = seedFilterPairs({
      existingPairs: pairs, filter: filter!, items, itemCategoryBySku, supplyPlaceholder,
    });
    if (seeded.length > 0) { pairs = pairs.concat(seeded); seededFilterCount = seeded.length; }
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

  // Weighted-average gross margin % per (customer, sku) over the same
  // T3 window used for trailing qty. Weighted by net_amount so a $10k
  // sale moves the average more than a $100 sale. Skips rows with null
  // margin/net (rows the sync handler hasn't backfilled). The result
  // is a decimal fraction (0.25 = 25%) matching the column type.
  const marginCutoff = historySince(snapshotDate, 3);
  const marginSums = new Map<string, { marginSum: number; netSum: number }>();
  for (const s of sales) {
    if (s.txn_date < marginCutoff) continue;
    if (s.margin_amount == null || s.net_amount == null || s.net_amount <= 0) continue;
    if (!s.customer_id) continue;
    const k = `${s.customer_id}:${s.sku_id}`;
    const cur = marginSums.get(k);
    if (cur) {
      cur.marginSum += s.margin_amount;
      cur.netSum += s.net_amount;
    } else {
      marginSums.set(k, { marginSum: s.margin_amount, netSum: s.net_amount });
    }
  }
  const marginByCustSku = new Map<string, number>();
  for (const [k, v] of marginSums) {
    if (v.netSum > 0) marginByCustSku.set(k, v.marginSum / v.netSum);
  }
  forecastRows = forecastRows.map((f) => ({
    ...f,
    historical_margin_pct: marginByCustSku.get(`${f.customer_id}:${f.sku_id}`) ?? null,
  }));

  // Period-scoped build — drop rows whose period_code isn't in the
  // selected set. Done post-compute so rolling supply still walks the
  // full horizon even if only some periods persist. Accepts both the
  // multi-select period_codes array AND the legacy single period_code
  // string; either restricts the write to the matching periods.
  const periodScope = (() => {
    const set = new Set<string>();
    if (filter?.period_codes && filter.period_codes.length > 0) {
      for (const p of filter.period_codes) if (p) set.add(p);
    }
    if (filter?.period_code) set.add(filter.period_code);
    return set;
  })();
  // The period_codes present in the computed rows ARE the run's horizon.
  // If the planner's period filter overlaps none of them, applying it would
  // drop every row and write an empty build (a common footgun: a period
  // filter left over from browsing a different run whose months don't fall
  // in this run's horizon). Ignore the period filter in that case and flag
  // it, rather than silently producing 0 rows.
  let periodFilterOutOfHorizon = false;
  if (periodScope.size > 0) {
    const horizonCodes = new Set(forecastRows.map((f) => f.period_code));
    const overlaps = [...periodScope].some((c) => horizonCodes.has(c));
    if (!overlaps) {
      periodFilterOutOfHorizon = true;
    } else {
      const before = forecastRows.length;
      forecastRows = forecastRows.filter((f) => periodScope.has(f.period_code));
      prunedFilterCount += before - forecastRows.length;
    }
  }

  // Compute the in-scope grain keys up front. Used twice: first to
  // wipe out-of-scope rows when a filter is active (so a filtered
  // build = the filtered slice, not the filter overlaid on a prior
  // unfiltered build), then again as the stale-row defence on
  // read-back further down.
  const liveGrainKeys = new Set<string>(
    forecastRows.map((f) => `${f.customer_id}:${f.sku_id}:${f.period_start}`),
  );

  // Filtered-build scoping. Wipe forecast rows from prior builds
  // whose grain isn't in the new filter scope. Without this, a
  // planner who built a 30k-row full run, then filtered to one
  // style + 8 periods, would still see all 30k rows in the grid
  // (the upsert below only writes the filtered slice; nothing
  // removes the leftover 29.8k from prior runs). With this, the
  // run = the filtered slice. Saved builds (Phase 1) are how a
  // planner preserves work before refocusing.
  if (filterActive) {
    checkAbort(signal);
    onProgress?.({ phase: "writing_forecast", label: "Wiping out-of-scope rows" });
    const wipeResult = await wholesaleRepo.wipeOutOfScopeForecast(run.id, liveGrainKeys);
    if (wipeResult.wiped > 0) {
      onProgress?.({ phase: "writing_forecast", label: `Wiped ${wipeResult.wiped.toLocaleString()} out-of-scope rows` });
    }
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

  // Stale-row defence on read-back. With the filtered-build wipe
  // above this should now be a near no-op for filtered builds, but
  // the filter still runs as a safety net for unfiltered builds
  // (where dead pairs from old builds can still linger in the
  // persisted set).
  const relevantPersisted = persisted.filter((p) =>
    liveGrainKeys.has(`${p.customer_id}:${p.sku_id}:${p.period_start}`),
  );

  checkAbort(signal);
  onProgress?.({ phase: "computing_recs", label: "Generating recommendations", current: 0, total: relevantPersisted.length });
  const horizon = monthsBetween(run.horizon_start, run.horizon_end);
  // Pass openSos so the rolling supply deducts SO commitments in their
  // ship-month instead of taking the full snapshot qty_committed off
  // period 1 (Phase 2 SO-by-month accuracy fix). Lines without
  // ship_date apply to period 1 as a conservative fallback.
  const supplyBySkuPeriod = buildRollingWholesaleSupply(
    relevantPersisted,
    { inventorySnapshots: inv, openPos: pos, openSos, receipts },
    horizon,
  );
  const asOf = new Date().toISOString().slice(0, 10);
  // Per-SKU rounding multiple. Combines two constraints from the
  // item master:
  //   • moq_units  — vendor minimum order (case pack)
  //   • pack_size  — prepack units-per-pack (PPK styles; 1 = non-prepack)
  // recommended_qty must be a multiple of BOTH. In practice one is 1,
  // so max() is the right binary operation; if both > 1, the LCM is
  // the safe choice but would surprise the planner with very large
  // round-ups. max() is what they'd compute on paper.
  const moqBySku = new Map<string, number>();
  for (const i of items) {
    const moq = (i.moq_units && i.moq_units > 1) ? i.moq_units : 1;
    const pack = (i.pack_size && i.pack_size > 1) ? i.pack_size : 1;
    const rounding = Math.max(moq, pack);
    if (rounding > 1) moqBySku.set(i.id, rounding);
  }
  const recs = generateWholesaleRecommendations(relevantPersisted, supplyBySkuPeriod, asOf, undefined, moqBySku);
  checkAbort(signal);
  onProgress?.({ phase: "writing_recs", label: `Writing recommendations`, current: 0, total: recs.length });
  await wholesaleRepo.replaceRecommendations(run.id, recs, {
    signal,
    onPhase: (label) => onProgress?.({ phase: "writing_recs", label }),
    onProgress: (rowsDone, totalRows) => {
      onProgress?.({ phase: "writing_recs", label: `Writing recommendations`, current: rowsDone, total: totalRows });
    },
  });

  // TBD-color requests → write to ip_wholesale_forecast_tbd as
  // planner-added stock-buy rows. Each request becomes its own row
  // (plain INSERT, is_user_added=true) so multiple requests sharing
  // the same (style, color, customer, period) grain don't collapse
  // into one — the partial unique index on the table only constrains
  // is_user_added=false rows. Each row's notes is prefixed with
  // [fromRequest:<request_id>] so we can find and wipe them at the
  // start of the next build before re-inserting; otherwise rows
  // would compound on every rebuild.
  if (tbdColorRequests.length > 0) {
    try {
      await wholesaleRepo.deleteRequestDerivedTbdRows(run.id);
    } catch (e) {
      console.warn(`[planning] failed to clear prior request-derived TBD rows`, e);
    }
  }
  for (const r of tbdColorRequests) {
    const meta = parseRequestMeta(r);
    const style = meta.style && meta.style.toUpperCase() !== "TBD" ? meta.style : "TBD";
    // Preserve the planner's intended color when it's a real value
    // that's just new to this style. Only fall back to literal "TBD"
    // when the planner truly deferred the colorway.
    const metaColor = meta.color ?? "";
    const colorIsTbd = !metaColor || metaColor.toUpperCase() === "TBD";
    const color = colorIsTbd ? "TBD" : metaColor;
    // is_new_color drives the orange NEW badge in the grid. Set it
    // only when the color isn't in the master at all (brand-new
    // colorway). For "exists in master, just new on this style",
    // leave it false — the row still renders as a TBD line under
    // (style, color) but without the new-color badge.
    const isNewColor = !colorIsTbd && !allMasterColors.has(metaColor);
    const period = monthOf(r.target_period_start);
    const desc = meta.desc?.trim() ?? "";
    const notes = desc ? `[fromRequest:${r.id}] ${desc}` : `[fromRequest:${r.id}]`;
    try {
      await wholesaleRepo.insertTbdRow(run.id, {
        style_code: style,
        color,
        is_new_color: isNewColor,
        customer_id: r.customer_id,
        group_name: meta.cat || null,
        sub_category_name: meta.subcat || null,
        period_start: period.period_start,
        period_end: period.period_end,
        period_code: period.period_code,
        buyer_request_qty: r.requested_qty,
        // Final = system + buyer + override. System is always 0 on a
        // TBD row, override starts at 0, so final must be primed to
        // requested_qty here or the grid's Final column reads as 0.
        final_forecast_qty: r.requested_qty,
        notes,
      });
    } catch (e) {
      // Don't block the rest of the build on a single TBD insert
      // failure — surface in console so the planner can investigate.
      console.warn(`[planning] TBD-color request insert failed for ${r.id}`, e);
    }
  }

  // Flip OPEN requests to "applied" once their (customer, sku, period)
  // grain has landed in the persisted forecast OR the TBD table.
  // Already-applied rows stay applied (they're still feeding
  // subsequent builds — see listActiveRequestsForBuild). archived
  // rows are excluded by the fetch above, so they never reach this
  // path.
  const persistedKeys = new Set(
    forecastRows.map((f) => `${f.customer_id}:${f.sku_id}:${f.period_start}`),
  );
  const tbdAppliedKeys = new Set(
    tbdColorRequests.map((r) => `${r.customer_id}:${monthOf(r.target_period_start).period_start}`),
  );
  const appliedRequestIds: string[] = [];
  for (const r of requests) {
    if (r.request_status !== "open") continue;
    const periodStart = monthOf(r.target_period_start).period_start;
    // Use the resolved sku to match — the persisted forecast row
    // lands under the resolved sku, not the request's stored sku_id
    // (which may be the arbitrary FK fallback).
    const resolvedSku = resolveRequestSku(r);
    if (persistedKeys.has(`${r.customer_id}:${resolvedSku}:${periodStart}`)) {
      appliedRequestIds.push(r.id);
      continue;
    }
    if (tbdAppliedKeys.has(`${r.customer_id}:${periodStart}`)) {
      appliedRequestIds.push(r.id);
    }
  }
  if (appliedRequestIds.length > 0) {
    onProgress?.({ phase: "writing_recs", label: `Marking ${appliedRequestIds.length} request${appliedRequestIds.length === 1 ? "" : "s"} applied` });
    await wholesaleRepo.markRequestsApplied(appliedRequestIds);
  }

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
    requests_applied: appliedRequestIds.length,
    pairs_considered: pairs.length,
    pairs_pruned_dead: prunedDeadCount,
    pairs_pruned_filter: prunedFilterCount,
    pairs_seeded_filter: seededFilterCount,
    period_filter_out_of_horizon: periodFilterOutOfHorizon,
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
  const [items, customers, categories, forecast, sales, inv, pos, openSos, receipts, atsCostBySku, avgCostBySku, tbdRows, supplyPlaceholderId, prepackUnitsPerPack] = await Promise.all([
    wholesaleRepo.listItems(),
    wholesaleRepo.listCustomers(),
    wholesaleRepo.listCategories(),
    wholesaleRepo.listForecast(run.id),
    // 13-month sales fetch — 12 months back for ABC/XYZ classification
    // plus an extra month so the LY ±1 window (used by SP/LY in the
    // grid + the ly_sales forecast method) has full coverage of the
    // LY-1 month. The trailing-3 calc below filters in-memory so the
    // Hist T3 column still reflects the prior quarter only.
    wholesaleRepo.listWholesaleSales(historySince(run.source_snapshot_date)),
    wholesaleRepo.listInventorySnapshots(WHOLESALE_WAREHOUSES),
    wholesaleRepo.listOpenPos(),
    wholesaleRepo.listOpenSos(),
    wholesaleRepo.listReceipts(historySince(run.source_snapshot_date, 3)),
    wholesaleRepo.listAtsAvgCostBySku(),
    wholesaleRepo.listItemAvgCostBySku(),
    wholesaleRepo.listTbdRows(run.id),
    wholesaleRepo.ensureSupplyPlaceholderCustomer(),
    wholesaleRepo.listPrepackUnitsPerPack(),
  ]);

  const itemById = new Map(items.map((i) => [i.id, i]));
  const customerById = new Map(customers.map((c) => [c.id, c]));
  const categoryById = new Map(categories.map((c) => [c.id, c]));
  // (style_code, color) → real item sku_id. Lets planner-added TBD rows resolve
  // to the actual SKU so they can surface that SKU's supply (on-hand, incoming
  // PO receipts) instead of showing blanks — and, critically, so the row shares
  // the real sku_id with any regular forecast row for the same SKU/period, which
  // keeps the supply totals deduped (no double-count). Lowercased keys.
  const skuIdByStyleColor = new Map<string, string>();
  for (const i of items) {
    if (!i.style_code || !i.color) continue;
    const key = `${i.style_code.toLowerCase()}|${i.color.toLowerCase()}`;
    if (!skuIdByStyleColor.has(key)) skuIdByStyleColor.set(key, i.id);
  }

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

  // Full per-(customer, sku, month) unit-grain history. Drives a PERIOD-SPECIFIC
  // Hist T3: the column must slide with each horizon month — the trailing
  // quarter through THAT month's same-period-last-year — not show one
  // snapshot-anchored number repeated across the whole (future) horizon. Uses
  // ALL loaded sales (the 13-month lookback), which covers the LY windows of
  // every horizon month. qty prefers the backfilled unit grain (see
  // 20260517230000_sales_history_grain_and_margin.sql — mixed pack/unit rows
  // otherwise under-count prepacks).
  const histByPairMonth = new Map<string, Map<string, number>>();
  for (const s of sales) {
    if (!s.customer_id) continue;
    const key = `${s.customer_id}:${s.sku_id}`;
    const ym = s.txn_date.slice(0, 7);
    let byMonth = histByPairMonth.get(key);
    if (!byMonth) { byMonth = new Map(); histByPairMonth.set(key, byMonth); }
    // Number() BEFORE the add: PostgREST serialises `numeric`-typed columns as
    // JSON strings, and `0 + "167"` CONCATENATES ("0167") — poisoning every
    // trailing-window sum so the Hist T3 column renders blank ("–"). Coercing
    // the addend keeps the accumulator numeric regardless of column type.
    byMonth.set(ym, (byMonth.get(ym) ?? 0) + Number(s.qty_units ?? s.qty ?? 0));
  }
  // Trailing-history windows for a horizon month, all ending at (and including)
  // that month's same-period-last-year month (M−12). The planner can view T3,
  // T6, T9 or T12 in the grid, so compute every window up front (buildGridRows
  // runs on load, so the toggle stays instant client-side). breakdown is the
  // full 12 months (oldest→newest) for the tooltip; windows[N] = sum of the
  // last N of those (the N months through M−12).
  const windowsFor = (byMonth: Map<string, number> | undefined, periodStart: string): { windows: Record<number, number>; breakdown: Array<{ month: string; qty: number }> } => {
    const breakdown: Array<{ month: string; qty: number }> = [];
    for (let off = 23; off >= 12; off--) {
      const code = monthOffset(periodStart, off).period_code;
      breakdown.push({ month: code, qty: byMonth?.get(code) ?? 0 });
    }
    const windows: Record<number, number> = {};
    for (const w of [3, 6, 9, 12]) {
      windows[w] = breakdown.slice(breakdown.length - w).reduce((s, m) => s + m.qty, 0);
    }
    return { windows, breakdown };
  };
  const t3ForPeriod = (customerId: string, skuId: string, periodStart: string): { windows: Record<number, number>; breakdown: Array<{ month: string; qty: number }> } =>
    windowsFor(histByPairMonth.get(`${customerId}:${skuId}`), periodStart);

  // FAMILY key = base style (PPK token stripped) + the RESOLVED display color,
  // squished to alphanumerics. Crucial: PPK and base SKUs encode the color
  // DIFFERENTLY in their sku_code (pack `RYB0412PPK-BLKCAMO` vs each-grain
  // `RYB0412-BLACK-CAMO-30`), so a sku_code-derived key (baseColorKey) does
  // NOT reconcile them. resolveVariantColorWithProvenance normalizes both to
  // the same display color ("Black Camo"), so keying on it lets a prepack row
  // find the each-grain family's Hist T3/6/9/12, SP/LY and demand.
  const normColor = (c: string | null | undefined): string => (c ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const famColorKeyOf = (skuId: string | undefined, styleFallback?: string | null, colorFallback?: string | null): string => {
    const it = skuId ? itemById.get(skuId) : undefined;
    const style = it?.style_code ?? styleFallback ?? "";
    if (!style) return "";
    const rawColor = it ? resolveVariantColorWithProvenance(it.color, it.sku_code, it.style_code).color : colorFallback;
    const col = normColor(rawColor ?? colorFallback);
    if (!col) return "";
    return `${familyStyleOf(style)}|${col}`;
  };
  // FAMILY-grain history twin, keyed (customer, familyColorKey). A planner-added
  // TBD stock-buy row resolves the PACK sku while the customer's history is on
  // the each-grain family SKUs — this lets it surface the whole family's sales.
  // Two grains: per-(customer, family) for real-customer rows, and per-family
  // across ALL customers for the synthetic (Supply Only) rows — a prepack that
  // built as a stock line (no customer of its own) inherits the family's total
  // demand/history across the run's customers.
  // The run's REAL customers (those it forecasts, excluding the supply
  // placeholder) — the all-family history for Supply-Only prepack rows is
  // scoped to these so a customer-filtered run doesn't pull in demand from
  // customers outside the run.
  const runCustomers = new Set(forecast.map((f) => f.customer_id).filter((c) => c && c !== supplyPlaceholderId));
  const histByCustFamilyMonth = new Map<string, Map<string, number>>();
  const histByFamilyMonth = new Map<string, Map<string, number>>();
  const bump = (map: Map<string, Map<string, number>>, key: string, ym: string, qty: number) => {
    let byMonth = map.get(key);
    if (!byMonth) { byMonth = new Map(); map.set(key, byMonth); }
    byMonth.set(ym, (byMonth.get(ym) ?? 0) + qty);
  };
  for (const s of sales) {
    if (!s.customer_id) continue;
    const fam = famColorKeyOf(s.sku_id);
    if (!fam) continue;
    const qty = Number(s.qty_units ?? s.qty ?? 0);
    const ym = s.txn_date.slice(0, 7);
    bump(histByCustFamilyMonth, `${s.customer_id}:${fam}`, ym, qty);
    if (runCustomers.has(s.customer_id)) bump(histByFamilyMonth, fam, ym, qty);
  }
  // Family key for a TBD row: resolved SKU's family+color, else style+typed color.
  const tbdFamilyKey = (skuId: string | undefined, style: string, color: string | null | undefined): string =>
    famColorKeyOf(skuId, style, color);
  // allCust=true reads the family's total across every customer (Supply Only).
  const familyT3ForPeriod = (customerId: string, famKey: string, periodStart: string, allCust = false): { windows: Record<number, number>; breakdown: Array<{ month: string; qty: number }> } =>
    windowsFor(
      famKey ? (allCust ? histByFamilyMonth.get(famKey) : histByCustFamilyMonth.get(`${customerId}:${famKey}`)) : undefined,
      periodStart,
    );

  // ABC / XYZ classification per SKU, using the full 12-month window.
  // Stamped on every row (TBD + forecast) below so the grid can render
  // a Class column and the planner can filter by it. Pass unit-grain
  // qty so prepack styles rank correctly against non-prepack peers.
  const salesAtUnitGrain = sales.map((s) => ({ ...s, qty: s.qty_units ?? s.qty }));
  const classBySku = classifyAbcXyz(salesAtUnitGrain, run.source_snapshot_date, { monthsBack: 12 });

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
  // ── Shared cost cascade prep ──────────────────────────────────────────
  // Build the input maps that resolveCost (src/shared/costResolution.ts)
  // expects so every row resolves with the same direct→sibling→po→margin
  // ordering ATS uses. Replaces the previous bespoke cascade rooted in
  // ip_item_master.unit_cost (which is poisoned for some prepacks —
  // carries StandardUnitCost × MasterCaseQty from historical Excel
  // uploads). Doing the prep once keeps the per-row cost call O(1).
  //
  // siblingsBySku: every variant SKU in the same style code, ordered by
  // input order. The cascade walks this list looking for the first
  // sibling whose avg_cost is in avgCostBySku.
  const siblingsBySku = buildSiblingMap(
    items
      .filter((i) => i.sku_code && i.style_code)
      .map((i) => ({ sku: i.sku_code as string, basePart: i.style_code as string })),
  );
  // openPoCostsBySkuCode: convert the existing sku_id-keyed poCostBySku
  // (weighted-avg open-PO unit cost) into a sku_code-keyed Map<sku, [cost]>.
  // resolveCost averages the input list; passing a single pre-computed
  // weighted avg keeps the behavior the existing planning cascade had.
  const openPoCostsBySkuCode = new Map<string, number[]>();
  for (const [skuId, avgCost] of poCostBySku) {
    if (avgCost <= 0) continue;
    const it = itemById.get(skuId);
    if (it?.sku_code) openPoCostsBySkuCode.set(it.sku_code, [avgCost]);
  }
  // ── Grain-aware open-PO cost FALLBACK (BUG: RYB0412PPK blank cost) ─────
  // The exact-sku open-PO step in resolveCost never reaches a style's
  // each-grain rows when the PO sits on the pack-grain PPK sibling
  // (RYB0412PPK-<color>), and a PPK PO price is per-PACK, not per-each.
  // Build a per-each open-PO cost keyed by BASE-COLOR (size + PPK token
  // stripped) so a PO on RYB0412PPK-BLACK reaches the RYB0412-BLACK row.
  // Per-each = poUnitCost / poPackSize; a row re-grains it back up by its
  // own pack size (each-grain → per-each; pack-grain → pack price). This
  // is applied ONLY when the direct+sibling avg cascade came up empty
  // (see the row map below) — a PO price never overrides an avg cost.
  const poCostRowsForFallback: PoCostRow[] = pos
    .map((p) => {
      const it = itemById.get(p.sku_id);
      const skuCode = it?.sku_code ?? "";
      return {
        sku_code: skuCode,
        unit_cost: typeof p.unit_cost === "number" ? p.unit_cost : null,
        qty_open: typeof p.qty_open === "number" ? p.qty_open : null,
        pack_size: resolvePackSize(skuCode, it?.pack_size ?? null, prepackUnitsPerPack),
      };
    })
    .filter((r) => r.sku_code);
  const poEachCostByBaseColor = buildPoEachCostByBaseColor(poCostRowsForFallback);
  // STYLE-level tier (color stripped): a color with no PO of its own inherits
  // its style's per-each PO cost across sibling colors. Strictly BELOW the
  // base-color tier — see poFallbackCostForRow — and still only fires after
  // the direct+sibling avg cascade comes up empty (the row map below).
  const poEachCostByStyle = buildPoEachCostByStyle(poCostRowsForFallback);
  // ONE bundle of cascade inputs shared by BOTH row families below —
  // regular forecast rows and TBD stock-buy rows resolve through the
  // identical cascadeVendorAwareCostForItem so they can never disagree.
  const costMaps: PlanningCostMaps = {
    avgCostMap: avgCostBySku,
    siblingsBySku,
    openPoCostsBySku: openPoCostsBySkuCode,
    poEachCostByBaseColor,
    poEachCostByStyle,
    prepackUnitsPerPack,
  };

  // ── Vendor-first cost tiers (CEO ask: same style, multiple vendors) ───────
  // When the run has a vendor selected at build time, resolve unit costs
  // vendor-first: tier 1 = this vendor's OPEN POs (qty-weighted per-each), tier
  // 2 = this vendor's MOST-RECENT RECEIVED PO (price guide), then fall through
  // to the existing avg + any-vendor open-PO cascade. Vendor PO cost lines come
  // from the ip_vendor_po_costs view (native purchase_orders, the only place PO
  // vendor identity is populated). Pack size is re-resolved via the prepack
  // matrix so the per-each math matches the rest of the grid. NULL vendor =>
  // vendorMaps stays null and every cost call is byte-identical to today.
  let vendorMaps: VendorCostMaps | null = null;
  if (run.build_vendor_id) {
    try {
      const vendorCostRows = await wholesaleRepo.listVendorPoCostRows(run.build_vendor_id);
      const vRows: VendorPoCostRow[] = vendorCostRows
        .filter((r) => r.sku_code)
        .map((r) => ({
          sku_code: r.sku_code,
          unit_cost: r.unit_cost,
          qty_open: r.qty_open,
          qty_received: r.qty_received,
          pack_size: resolvePackSize(r.sku_code, r.pack_size, prepackUnitsPerPack),
          is_open: r.is_open,
          is_received: r.is_received,
          order_date: r.order_date,
        }));
      vendorMaps = buildVendorCostMaps(vRows);
    } catch (e) {
      // Never block the grid on a vendor-cost fetch failure — fall back to the
      // existing cascade (vendorMaps stays null).
      console.warn(`[planning] vendor PO cost fetch failed for vendor ${run.build_vendor_id}`, e);
      vendorMaps = null;
    }
  }

  // ── PPK-inherit reference (CEO: PPK rows should show the base garment's
  // demand/history so a prepack can be planned against real sales) ──────────
  // Base-family demand from this run's BASE each-grain forecast rows (non-PPK),
  // summed across sizes per (customer, base-color, period). A prepack row's
  // ppk_base_ref draws system/final from here when the base is in the run; the
  // family SALES HISTORY (familyT3ForPeriod) supplies Hist T3/6/9/12 + SP/LY
  // and the fallback demand, so the reference is populated even for a build
  // that selected ONLY the PPK styles (no base rows present).
  const baseFamilyDemand = new Map<string, { system: number; final: number }>();       // per (customer, family, period)
  const baseFamilyDemandAll = new Map<string, { system: number; final: number }>();    // per (family, period), all customers
  for (const f of forecast) {
    const it = itemById.get(f.sku_id);
    const styleCode = it?.style_code ?? "";
    if (!styleCode || familyStyleOf(styleCode) !== styleCode) continue; // base garment only
    if (f.customer_id === supplyPlaceholderId) continue;               // real-customer demand only
    const fam = famColorKeyOf(f.sku_id);
    if (!fam) continue;
    const sys = Number(f.system_forecast_qty_override ?? f.system_forecast_qty ?? 0);
    const fin = Number(f.final_forecast_qty ?? 0);
    for (const [map, key] of [
      [baseFamilyDemand, `${f.customer_id}:${fam}:${f.period_start}`] as const,
      [baseFamilyDemandAll, `${fam}:${f.period_start}`] as const,
    ]) {
      const acc = map.get(key) ?? { system: 0, final: 0 };
      acc.system += sys; acc.final += fin;
      map.set(key, acc);
    }
  }
  // Build the reference for a prepack row. Returns null for a non-PPK row. A
  // synthetic (Supply Only) prepack — a stock line with no customer demand of
  // its own — inherits the family's TOTAL across the run's customers; a
  // real-customer prepack inherits that customer's family demand.
  const ppkBaseRefFor = (
    skuId: string,
    styleCode: string | null | undefined,
    customerId: string,
    periodStart: string,
    famOverride?: string,
  ): IpPlanningGridRow["ppk_base_ref"] => {
    if (!styleCode || familyStyleOf(styleCode) === styleCode) return null; // not a prepack row
    const fam = famOverride || famColorKeyOf(skuId);
    if (!fam) return null;
    const allCust = customerId === supplyPlaceholderId;
    const hist = familyT3ForPeriod(customerId, fam, periodStart, allCust);
    const ly = hist.breakdown[hist.breakdown.length - 1]?.qty ?? 0; // M−12 = SP/LY
    const base = (allCust ? baseFamilyDemandAll : baseFamilyDemand).get(`${allCust ? "" : `${customerId}:`}${fam}:${periodStart}`);
    // System/Final from the base forecast rows when the run has them; else the
    // last-year demand as the ly_sales-basis proxy (pure-PPK build).
    const system = base ? base.system : ly;
    const final = base ? base.final : ly;
    return {
      system_forecast_qty: system,
      final_forecast_qty: final,
      ly_reference_qty: ly,
      historical_trailing_qty: hist.windows[3],
      historical_trailing_windows: hist.windows,
    };
  };

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
    // Shared cost cascade — direct (ip_item_avg_cost) → sibling variant
    // → open-PO weighted-avg → margin (skipped here, no per-row sale
    // price). Replaces the previous bespoke cascade that started with
    // ip_item_master.unit_cost — the latter is poisoned for some prepack
    // SKUs (carries StandardUnitCost × MasterCaseQty from legacy Excel
    // uploads, e.g. RYB059430 reads as $160.80 instead of $6.70).
    // ATS Excel snapshot remains available via the `ats_avg_cost` row
    // field below as audit data even though it's no longer in the
    // cascade — operators can compare side-by-side.
    // The grain-aware open-PO fallback fires ONLY when the direct-avg →
    // sibling-avg cascade comes up empty — a PO price never overrides an
    // avg cost. Covers PPK styles whose PO sits on the pack sibling AND
    // the plain-each case (packSize 1 on both sides → poUnitCost as-is).
    const resolvedCost = cascadeVendorAwareCostForItem(item, costMaps, vendorMaps);
    // Period-specific Hist T3 (trailing quarter through this month's LY).
    const t3 = t3ForPeriod(f.customer_id, f.sku_id, f.period_start);
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
      sku_inseam: item?.inseam ?? styleFallback?.inseam ?? null,
      // Item-master classification — falls back to a sibling variant in
      // the same style if the variant master row hasn't been populated yet.
      group_name: readGroupName(item) ?? readGroupName(styleFallback) ?? null,
      sub_category_name: readSubCategoryName(item) ?? readSubCategoryName(styleFallback) ?? null,
      gender: readGender(item) ?? readGender(styleFallback) ?? null,
      season: readSeason(item) ?? readSeason(styleFallback) ?? null,
      period_code: f.period_code,
      period_start: f.period_start,
      period_end: f.period_end,
      historical_trailing_qty: t3.windows[3],
      historical_trailing_windows: t3.windows,
      ppk_base_ref: ppkBaseRefFor(f.sku_id, item?.style_code, f.customer_id, f.period_start),
      historical_margin_pct: f.historical_margin_pct ?? null,
      historical_trailing_breakdown: t3.breakdown.some((b) => b.qty > 0) ? t3.breakdown : null,
      abc_class: classBySku.get(f.sku_id)?.abc,
      xyz_class: classBySku.get(f.sku_id)?.xyz,
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
      // Coerce to a real number (or null). PostgREST returns `numeric` columns
      // as strings; a string ly_reference_qty renders blank ("–") via formatQty
      // — the SP/LY column's failure mode — so normalise it at the source.
      ly_reference_qty: f.ly_reference_qty == null ? null : Number(f.ly_reference_qty),
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

  // Strip the `[fromRequest:<uuid>]` marker that the build pipeline
  // stamps onto request-derived TBD rows so it never shows up in the
  // grid's Description column. The marker stays in the persisted
  // notes column so deleteRequestDerivedTbdRows can find it via
  // notes=like on the next rebuild.
  const stripRequestMarker = (s: string | null | undefined): string | null => {
    if (!s) return null;
    return s.replace(/^\[fromRequest:[^\]]+\]\s*/, "").trim() || null;
  };

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
    const description = stripRequestMarker(supplyTbd?.notes) || styleFb?.description || null;
    const groupName = readGroupName(styleFb) ?? null;
    const subCategoryName = readSubCategoryName(styleFb) ?? null;
    const season = readSeason(styleFb) ?? null;
    let gender = readGender(styleFb) ?? null;
    // Best-effort gender inference for planner-added new styles
    // (no master row exists yet). Pulls the most common gender from
    // sibling styles in the same (group_name, sub_category_name).
    if (!gender) {
      const siblingCat = groupName ?? supplyTbd?.group_name ?? "";
      const siblingSub = subCategoryName ?? supplyTbd?.sub_category_name ?? "";
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
    // Per the planner's spec change: don't auto-emit a "(Supply Only)
    // TBD" row for every (style, period) combo. The earlier behavior
    // was to surface a TBD catch-all per style+period AND a supply-
    // only synthetic per supply-only sku — both are now suppressed.
    // Only persisted TBD rows that the planner explicitly added (via
    // the + Add row form or a TbdStyleCell rename) reach the grid;
    // they ride the second push loop below, not this synthetic one.
    const supplyTbdIsRealAdd = !!supplyTbd?.is_user_added;
    const skipSynthetic = !supplyTbdIsRealAdd;
    if (!skipSynthetic) {
    // Resolve the real SKU so the stock-buy row surfaces that SKU's supply
    // (on-hand + incoming PO receipts) instead of blanks. Falls back to the
    // synthetic sku_id when the (style, color) doesn't resolve (e.g. TBD color).
    const synSkuId = skuIdByStyleColor.get(`${sp.style_code.toLowerCase()}|${(supplyTbd?.color ?? "TBD").toLowerCase()}`);
    const synOnHand = synSkuId ? (onHand.get(synSkuId) ?? 0) : 0;
    const synReceipts = synSkuId ? (receiptsBySkuPeriod.get(`${synSkuId}:${sp.period_start}`) ?? 0) : 0;
    const synHistRecv = synSkuId ? (historicalReceiptsBySkuPeriod.get(`${synSkuId}:${sp.period_start}`) ?? 0) : 0;
    // Same cost cascade the forecast rows run (direct avg → sibling avg →
    // open-PO, then the grain-aware PO fallback), keyed off the resolved
    // real SKU. Previously TBD rows hard-coded `unit_cost ?? null` and a
    // stock buy on any style without a typed cost showed a blank Unit
    // Cost / Buy $ (bug: RYB0185PPK).
    const synResolvedCost = cascadeVendorAwareCostForItem(synSkuId ? itemById.get(synSkuId) : null, costMaps, vendorMaps);
    // Synthetic (Supply Only) TBD line — always rendered; overlays
    // persisted qty/cost when supplyTbd exists.
    tbdGridRows.push({
      forecast_id: supplyTbd ? `tbd:${supplyTbd.id}` : `tbd:synthetic:${sp.style_code}:${sp.period_start}`,
      planning_run_id: run.id,
      customer_id: supplyPlaceholderId,
      customer_name: supplyCustomerName,
      category_id: null,
      category_name: null,
      // LIVE master taxonomy (style_master overlay = Tangerine truth) WINS;
      // the values stored on the TBD row at creation time are only a
      // fallback for styles the master doesn't know (planner-typed NEW
      // styles / the literal TBD slot). Stored-wins showed stale
      // categories forever after a Tangerine re-categorization.
      group_name: groupName ?? supplyTbd?.group_name ?? null,
      sub_category_name: subCategoryName ?? supplyTbd?.sub_category_name ?? null,
      gender,
      season,
      // Real sku_id when resolved — ties the row to the SKU's supply AND keeps
      // supply totals deduped against any regular forecast row for the same SKU.
      sku_id: synSkuId ?? `tbd:${sp.style_code}`,
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
      // NEW description badge persists until the master catches
      // up: only set when the planner's typed value differs from
      // the master style's description. Once the master gains a
      // matching description, the override is effectively redundant
      // and the badge clears.
      is_new_description: (() => {
        const planner = stripRequestMarker(supplyTbd?.notes) ?? "";
        if (!planner) return false;
        const master = (styleFb?.description ?? "").trim();
        return planner.toLowerCase() !== master.toLowerCase();
      })(),
      tbd_id: supplyTbd?.id,
      tbd_updated_at: supplyTbd?.updated_at,
      sku_size: null,
      sku_inseam: null,
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
      historical_margin_pct: null,
      item_cost: null,
      ats_avg_cost: null,
      // Forecast-row convention: avg_cost = the cascade result at the
      // SKU's native grain; a planner-typed TBD cost rides
      // unit_cost_override (display grain — the explode transform never
      // re-divides an override) and wins in unit_cost.
      avg_cost: synResolvedCost,
      unit_cost_override: supplyTbd?.unit_cost ?? null,
      unit_cost: supplyTbd?.unit_cost ?? synResolvedCost,
      planned_buy_qty: supplyTbd?.planned_buy_qty ?? null,
      on_hand_qty: synOnHand,
      on_so_qty: 0,
      on_po_qty: 0,
      receipts_due_qty: synReceipts,
      historical_receipts_qty: synHistRecv,
      available_supply_qty: synOnHand + synReceipts + (supplyTbd?.planned_buy_qty ?? 0),
      projected_shortage_qty: 0,
      projected_excess_qty: 0,
      recommended_action: "monitor",
      recommended_qty: null,
      action_reason: null,
      notes: stripRequestMarker(supplyTbd?.notes),
    });
    }
    // Any other persisted TBD rows for this (style, period) (e.g.
    // a planner reassigned color/customer in a future phase) become
    // their own grid lines so the planner can see and edit them.
    for (const t of persistedAll) {
      if (supplyTbd && t.id === supplyTbd.id) continue;
      const cust = customerById.get(t.customer_id);
      // Resolve the real SKU (style, color) → surface its supply on this row.
      const tSkuId = skuIdByStyleColor.get(`${sp.style_code.toLowerCase()}|${(t.color ?? "").toLowerCase()}`);
      const tOnHand = tSkuId ? (onHand.get(tSkuId) ?? 0) : 0;
      const tReceipts = tSkuId ? (receiptsBySkuPeriod.get(`${tSkuId}:${sp.period_start}`) ?? 0) : 0;
      const tHistRecv = tSkuId ? (historicalReceiptsBySkuPeriod.get(`${tSkuId}:${sp.period_start}`) ?? 0) : 0;
      // Same cost cascade the forecast rows run — see synResolvedCost above.
      const tResolvedCost = cascadeVendorAwareCostForItem(tSkuId ? itemById.get(tSkuId) : null, costMaps, vendorMaps);
      // FAMILY-grain history for the row's real customer: Hist T3/6/9/12 and
      // SP/LY aggregated across every SKU of the (style, color) family — a
      // TBD row resolved to the PACK sku still surfaces the each-grain
      // family's sales (CEO 2026-07-21: "T3/6/9/12 all 0 not possibly
      // correct"). Falls back to zeros only when the customer truly has no
      // family history.
      const tFam = tbdFamilyKey(tSkuId, sp.style_code, t.color);
      const tHist = familyT3ForPeriod(t.customer_id, tFam, sp.period_start);
      const tLy = tHist.breakdown[tHist.breakdown.length - 1]?.qty ?? 0;
      // PPK-inherit reference on a prepack stock-buy row — same family demand
      // the grid's toggle surfaces on forecast prepack rows.
      const tPpkRef = ppkBaseRefFor(tSkuId ?? "", sp.style_code, t.customer_id, sp.period_start, tFam);
      tbdGridRows.push({
        forecast_id: `tbd:${t.id}`,
        planning_run_id: run.id,
        customer_id: t.customer_id,
        customer_name: cust?.name ?? "(unknown customer)",
        category_id: null,
        category_name: null,
        // Same precedence as the synthetic row above: live master WINS,
        // stored TBD values only cover master-unknown styles.
        group_name: groupName ?? t.group_name ?? null,
        sub_category_name: subCategoryName ?? t.sub_category_name ?? null,
        gender,
        season,
        // Real sku_id when resolved (dedups supply vs. regular rows for same SKU).
        sku_id: tSkuId ?? `tbd:${sp.style_code}`,
        sku_code: `${sp.style_code}-TBD`,
        sku_description: stripRequestMarker(t.notes) || description,
        sku_style: sp.style_code,
        sku_color: t.color,
        sku_color_inferred: false,
        is_tbd: true,
        is_new_color: t.is_new_color && !isKnownColor(sp.style_code, t.color),
        is_user_added: t.is_user_added,
        is_new_description: (() => {
          const planner = stripRequestMarker(t.notes) ?? "";
          if (!planner) return false;
          const master = (styleFb?.description ?? "").trim();
          return planner.toLowerCase() !== master.toLowerCase();
        })(),
        tbd_id: t.id,
        tbd_updated_at: t.updated_at,
        sku_size: null,
        sku_inseam: null,
        period_code: sp.period_code,
        period_start: sp.period_start as IpIsoDate,
        period_end: sp.period_end as IpIsoDate,
        historical_trailing_qty: tHist.windows[3],
        historical_trailing_windows: tHist.windows,
        ppk_base_ref: tPpkRef,
        historical_trailing_breakdown: tHist.breakdown.some((b) => b.qty > 0) ? tHist.breakdown : null,
        system_forecast_qty: 0,
        system_forecast_qty_original: 0,
        system_forecast_qty_overridden_at: null,
        system_forecast_qty_overridden_by: null,
        buyer_request_qty: t.buyer_request_qty,
        override_qty: t.override_qty,
        final_forecast_qty: t.final_forecast_qty,
        confidence_level: "estimate",
        forecast_method: "zero_floor",
        ly_reference_qty: tLy > 0 ? tLy : null,
        historical_margin_pct: null,
        item_cost: null,
        ats_avg_cost: null,
        // Forecast-row convention (see the synthetic row above): cascade
        // cost in avg_cost/unit_cost, planner-typed cost as the override.
        avg_cost: tResolvedCost,
        unit_cost_override: t.unit_cost ?? null,
        unit_cost: t.unit_cost ?? tResolvedCost,
        planned_buy_qty: t.planned_buy_qty ?? null,
        on_hand_qty: tOnHand,
        on_so_qty: 0,
        on_po_qty: 0,
        receipts_due_qty: tReceipts,
        historical_receipts_qty: tHistRecv,
        available_supply_qty: tOnHand + tReceipts + (t.planned_buy_qty ?? 0),
        projected_shortage_qty: 0,
        projected_excess_qty: 0,
        recommended_action: "monitor",
        recommended_qty: null,
        action_reason: null,
        notes: stripRequestMarker(t.notes),
      });
    }
  }

  return [...rows, ...tbdGridRows];
}
