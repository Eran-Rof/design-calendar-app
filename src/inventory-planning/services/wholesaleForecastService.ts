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
  committedSoBySku,
  generateWholesaleRecommendations,
  latestOnHandBySku,
  monthOf,
  monthsBetween,
  openPoQtyBySku,
  openPoQtyBySkuPeriod,
  recommendForRow,
} from "../compute";
import { wholesaleRepo } from "./wholesalePlanningRepository";

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
  methods: Record<IpForecastMethod, number>;
}

export async function runForecastPass(run: IpPlanningRun): Promise<RunForecastPassResult> {
  if (!run.horizon_start || !run.horizon_end) {
    throw new Error("Planning run has no horizon; set horizon_start + horizon_end before running the forecast.");
  }
  const snapshotDate = run.source_snapshot_date;
  const lookbackFrom = historySince(snapshotDate, 12);

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

  const forecastRows = buildFinalWholesaleForecast(computeInput);
  await wholesaleRepo.upsertForecast(forecastRows);

  // Read persisted rows — they carry planned_buy_qty from prior planner saves
  // (upsert preserves the column). Rolling supply must use these so buy qty
  // is reflected in recommendations.
  const persisted = await wholesaleRepo.listForecast(run.id);
  const horizon = monthsBetween(run.horizon_start, run.horizon_end);
  const supplyBySkuPeriod = buildRollingWholesaleSupply(
    persisted,
    { inventorySnapshots: inv, openPos: pos, receipts },
    horizon,
  );
  const asOf = new Date().toISOString().slice(0, 10);
  const recs = generateWholesaleRecommendations(persisted, supplyBySkuPeriod, asOf);
  await wholesaleRepo.replaceRecommendations(run.id, recs);

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
  const [items, customers, categories, forecast, recs, sales, inv, pos, receipts, atsCostBySku, avgCostBySku] = await Promise.all([
    wholesaleRepo.listItems(),
    wholesaleRepo.listCustomers(),
    wholesaleRepo.listCategories(),
    wholesaleRepo.listForecast(run.id),
    wholesaleRepo.listRecommendations(run.id),
    wholesaleRepo.listWholesaleSales(historySince(run.source_snapshot_date, 3)),
    wholesaleRepo.listInventorySnapshots(),
    wholesaleRepo.listOpenPos(),
    wholesaleRepo.listReceipts(historySince(run.source_snapshot_date, 3)),
    wholesaleRepo.listAtsAvgCostBySku(),
    wholesaleRepo.listItemAvgCostBySku(),
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
  const recByGrain = new Map(recs.map((r) => [
    `${r.customer_id}:${r.sku_id}:${r.period_start}`,
    r,
  ]));

  const onHand = latestOnHandBySku(inv);
  const onSo = committedSoBySku(inv);
  // Total open-PO qty per SKU — kept for the rolling-supply compute layer
  // which still operates SKU-wide.
  const onPo = openPoQtyBySku(pos);
  // Per-(sku, period_start) open-PO qty, filtered by expected_date.
  // Drives the grid's "On PO" column so a PO landing in May only shows
  // on May rows, not every period. POs without an expected_date are
  // bucketed as "unscheduled" and surface only when filtered out below.
  const onPoByPeriod = new Map<string, number>();
  {
    const periodWindows = Array.from(
      new Map(forecast.map((f) => [f.period_start, { start: f.period_start, end: f.period_end }])).values(),
    );
    for (const w of periodWindows) {
      const m = openPoQtyBySkuPeriod(pos, w.start, w.end);
      for (const [skuId, qty] of m) {
        onPoByPeriod.set(`${skuId}:${w.start}`, qty);
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

  // Rolling supply: PO receipts in a period drain the pool for subsequent periods.
  const rollingSupply = buildRollingWholesaleSupply(
    forecast,
    { inventorySnapshots: inv, openPos: pos, receipts },
    Array.from(new Map(forecast.map((f) => [f.period_start, { period_start: f.period_start, period_end: f.period_end }])).values())
      .sort((a, b) => a.period_start.localeCompare(b.period_start)),
  );

  const rows: IpPlanningGridRow[] = forecast.map((f) => {
    const item = itemById.get(f.sku_id);
    const customer = customerById.get(f.customer_id);
    const category = f.category_id ? categoryById.get(f.category_id) : null;
    const rec = recByGrain.get(`${f.customer_id}:${f.sku_id}:${f.period_start}`);
    const supply = rollingSupply.get(`${f.sku_id}:${f.period_start}`);
    const styleFallback = item?.style_code ? masterByStyle.get(item.style_code) : null;
    const description = item?.description ?? styleFallback?.description ?? null;
    const colorDisplay = item?.color ?? styleFallback?.color ?? null;
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
      // Item-master classification — falls back to a sibling variant in
      // the same style if the variant master row hasn't been populated yet.
      group_name: readGroupName(item) ?? readGroupName(styleFallback) ?? null,
      sub_category_name: readSubCategoryName(item) ?? readSubCategoryName(styleFallback) ?? null,
      period_code: f.period_code,
      period_start: f.period_start,
      period_end: f.period_end,
      historical_trailing_qty: trailing.get(`${f.customer_id}:${f.sku_id}`) ?? 0,
      system_forecast_qty: f.system_forecast_qty,
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
      on_so_qty: onSo.get(f.sku_id) ?? 0,
      on_po_qty: onPoByPeriod.get(`${f.sku_id}:${f.period_start}`) ?? 0,
      receipts_due_qty: supply?.receipts_due_qty ?? 0,
      available_supply_qty: avail,
      projected_shortage_qty: shortage,
      projected_excess_qty: excess,
      recommended_action: liveRec.recommended_action,
      recommended_qty: liveRec.recommended_qty,
      action_reason: liveRec.action_reason,
      notes: f.notes,
    };
  });

  return rows;
}
