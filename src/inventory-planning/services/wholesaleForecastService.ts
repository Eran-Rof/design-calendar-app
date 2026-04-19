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
  generateWholesaleRecommendations,
  latestOnHandBySku,
  monthOf,
  monthsBetween,
  openPoQtyBySku,
  supplyForPeriod,
  supplyKey,
} from "../compute";
import { wholesaleRepo } from "./wholesalePlanningRepository";

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

  const [items, sales, requests, overrides, inv, pos, receipts] = await Promise.all([
    wholesaleRepo.listItems(),
    wholesaleRepo.listWholesaleSales(lookbackFrom),
    wholesaleRepo.listOpenRequests(),
    wholesaleRepo.listOverrides(run.id),
    wholesaleRepo.listInventorySnapshots(),
    wholesaleRepo.listOpenPos(),
    wholesaleRepo.listReceipts(lookbackFrom),
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

  const pairs = resolvePairs(historyInput, requestInput, itemCategoryBySku);

  const computeInput: IpForecastComputeInput = {
    planning_run_id: run.id,
    source_snapshot_date: snapshotDate,
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

  // Recompute supply × forecast to land recommendations.
  const horizon = monthsBetween(run.horizon_start, run.horizon_end);
  const supplyBySkuPeriod = new Map<string, ReturnType<typeof supplyForPeriod>>();
  const skuSet = new Set(forecastRows.map((r) => r.sku_id));
  for (const skuId of skuSet) {
    for (const p of horizon) {
      supplyBySkuPeriod.set(supplyKey(skuId, p.period_start), supplyForPeriod(
        { inventorySnapshots: inv, openPos: pos, receipts },
        skuId,
        p.period_start,
        p.period_end,
      ));
    }
  }
  const asOf = new Date().toISOString().slice(0, 10);

  // The forecast rows we just wrote need ids to persist recommendations;
  // re-read them so recommendations carry proper grain back.
  const persisted = await wholesaleRepo.listForecast(run.id);
  const recs = generateWholesaleRecommendations(persisted, supplyBySkuPeriod, asOf);
  await wholesaleRepo.replaceRecommendations(run.id, recs);

  const methods: Record<IpForecastMethod, number> = {
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
  const [items, customers, categories, forecast, recs, sales, inv, pos, receipts] = await Promise.all([
    wholesaleRepo.listItems(),
    wholesaleRepo.listCustomers(),
    wholesaleRepo.listCategories(),
    wholesaleRepo.listForecast(run.id),
    wholesaleRepo.listRecommendations(run.id),
    wholesaleRepo.listWholesaleSales(historySince(run.source_snapshot_date, 3)),
    wholesaleRepo.listInventorySnapshots(),
    wholesaleRepo.listOpenPos(),
    wholesaleRepo.listReceipts(historySince(run.source_snapshot_date, 3)),
  ]);

  const itemById = new Map(items.map((i) => [i.id, i]));
  const customerById = new Map(customers.map((c) => [c.id, c]));
  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const recByGrain = new Map(recs.map((r) => [
    `${r.customer_id}:${r.sku_id}:${r.period_start}`,
    r,
  ]));

  const onHand = latestOnHandBySku(inv);
  const onPo = openPoQtyBySku(pos);

  // Trailing-3 per (customer, sku).
  const trailing = new Map<string, number>();
  for (const s of sales) {
    const key = `${s.customer_id}:${s.sku_id}`;
    trailing.set(key, (trailing.get(key) ?? 0) + s.qty);
  }

  const rows: IpPlanningGridRow[] = forecast.map((f) => {
    const item = itemById.get(f.sku_id);
    const customer = customerById.get(f.customer_id);
    const category = f.category_id ? categoryById.get(f.category_id) : null;
    const rec = recByGrain.get(`${f.customer_id}:${f.sku_id}:${f.period_start}`);
    const supply = supplyForPeriod(
      { inventorySnapshots: inv, openPos: pos, receipts },
      f.sku_id,
      f.period_start,
      f.period_end,
    );
    const avail = rec?.available_supply_qty ?? supply.available_supply_qty;
    const shortage = rec?.projected_shortage_qty ?? Math.max(0, f.final_forecast_qty - avail);
    const excess = rec?.projected_excess_qty ?? Math.max(0, avail - f.final_forecast_qty);
    return {
      forecast_id: f.id,
      planning_run_id: f.planning_run_id,
      customer_id: f.customer_id,
      customer_name: customer?.name ?? "(unknown customer)",
      category_id: f.category_id,
      category_name: category?.name ?? null,
      sku_id: f.sku_id,
      sku_code: item?.sku_code ?? "(unknown sku)",
      sku_description: item?.description ?? null,
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
      on_hand_qty: onHand.get(f.sku_id) ?? 0,
      on_po_qty: onPo.get(f.sku_id) ?? 0,
      receipts_due_qty: supply.receipts_due_qty,
      available_supply_qty: avail,
      projected_shortage_qty: shortage,
      projected_excess_qty: excess,
      recommended_action: rec?.recommended_action ?? "hold",
      recommended_qty: rec?.recommended_qty ?? null,
      action_reason: rec?.action_reason ?? null,
      notes: f.notes,
    };
  });

  return rows;
}
