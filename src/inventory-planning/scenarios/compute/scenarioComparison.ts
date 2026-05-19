// Diff two reconciled planning runs (base + scenario) at the
// (sku, period) grain. Pure over input row sets — the service gathers
// the rows and passes them here.

import type { IpProjectedInventory } from "../../supply/types/supply";
import type { IpInventoryRecommendation } from "../../supply/types/supply";
import type { IpItem, IpCategory } from "../../types/entities";
import type { IpWholesaleForecast } from "../../types/wholesale";
import type {
  ScenarioComparisonRow,
  ScenarioComparisonTotals,
} from "../types/scenarios";

export interface ComparisonInput {
  base: IpProjectedInventory[];
  scenario: IpProjectedInventory[];
  baseRecs: IpInventoryRecommendation[];
  scenarioRecs: IpInventoryRecommendation[];
  items: IpItem[];
  categories: IpCategory[];
  // Phase 4 spec: surface planner-typed Buy qty in the comparison.
  // Optional so existing tests don't need to construct fixtures.
  baseWholesaleForecast?: IpWholesaleForecast[];
  scenarioWholesaleForecast?: IpWholesaleForecast[];
}

export function compareScenarioToBase(input: ComparisonInput): {
  rows: ScenarioComparisonRow[];
  totals: ScenarioComparisonTotals;
} {
  const itemById = new Map(input.items.map((i) => [i.id, i]));
  const catById = new Map(input.categories.map((c) => [c.id, c]));
  const baseRecTop = topRecByGrain(input.baseRecs);
  const scenRecTop = topRecByGrain(input.scenarioRecs);
  // (sku, period) → planner-typed planned_buy_qty, summed across
  // customers. Each forecast row is per-customer; the comparison is
  // per-(sku, period), so we sum here.
  const basePlannedBuy = sumPlannedBuyByGrain(input.baseWholesaleForecast);
  const scenPlannedBuy = sumPlannedBuyByGrain(input.scenarioWholesaleForecast);

  // (sku, period) → blended margin-$/unit estimate. Forecast rows are
  // per-(customer, sku, period); we weight margin_pct by
  // final_forecast_qty so a high-volume customer dominates the
  // blended margin. Cost source is the item-master unit_cost when
  // the planner hasn't overridden it on the forecast row.
  const costBySku = new Map<string, number>();
  for (const i of input.items) {
    if (i.unit_cost != null && i.unit_cost > 0) costBySku.set(i.id, i.unit_cost);
  }
  const baseMargin = marginPerUnitByGrain(input.baseWholesaleForecast, costBySku);
  const scenMargin = marginPerUnitByGrain(input.scenarioWholesaleForecast, costBySku);

  const keys = new Set<string>();
  const baseByKey = new Map<string, IpProjectedInventory>();
  const scenByKey = new Map<string, IpProjectedInventory>();
  for (const r of input.base) {
    const k = `${r.sku_id}:${r.period_start}`;
    keys.add(k); baseByKey.set(k, r);
  }
  for (const r of input.scenario) {
    const k = `${r.sku_id}:${r.period_start}`;
    keys.add(k); scenByKey.set(k, r);
  }

  const rows: ScenarioComparisonRow[] = [];
  let demand_delta_sum = 0, supply_delta_sum = 0, shortage_delta_sum = 0, excess_delta_sum = 0;
  let buy_delta_sum = 0;
  let margin_dollars_delta_sum = 0;
  let service_risk_added = 0, service_risk_removed = 0;
  let stockouts_added = 0, stockouts_removed = 0, recs_changed = 0;

  for (const k of keys) {
    const b = baseByKey.get(k);
    const s = scenByKey.get(k);
    const base = b ?? zeroRow(s!);
    const scen = s ?? zeroRow(b!);
    const baseDem = base.wholesale_demand_qty + base.ecom_demand_qty;
    const scenDem = scen.wholesale_demand_qty + scen.ecom_demand_qty;
    const item = itemById.get(base.sku_id || scen.sku_id);
    const cat = (base.category_id || scen.category_id) ? catById.get(base.category_id || scen.category_id!) : null;

    const baseTop = baseRecTop.get(k) ?? null;
    const scenTop = scenRecTop.get(k) ?? null;
    if ((baseTop?.recommendation_type ?? null) !== (scenTop?.recommendation_type ?? null)) recs_changed++;

    if (!base.projected_stockout_flag && scen.projected_stockout_flag) stockouts_added++;
    if (base.projected_stockout_flag && !scen.projected_stockout_flag) stockouts_removed++;

    // Service-risk flag tracking: a recommendation is "at risk" when
    // its service_risk_flag is true (typically buy/expedite recs
    // facing a shortage that breaches the SHORTAGE_PCT_TRIGGER).
    const baseRisk = !!baseTop?.service_risk_flag;
    const scenRisk = !!scenTop?.service_risk_flag;
    if (!baseRisk && scenRisk) service_risk_added++;
    if (baseRisk && !scenRisk) service_risk_removed++;

    // Buy figures — planner-typed planned_buy_qty (their plan) AND
    // the engine's recommended_qty (the verdict). Surfacing both
    // lets a planner see "I planned X, the engine says I should
    // buy Y" at a glance.
    const basePlanned = basePlannedBuy.get(k) ?? 0;
    const scenPlanned = scenPlannedBuy.get(k) ?? 0;
    const baseRecQty = isBuyAction(baseTop?.recommendation_type) ? (baseTop?.recommendation_qty ?? 0) : 0;
    const scenRecQty = isBuyAction(scenTop?.recommendation_type) ? (scenTop?.recommendation_qty ?? 0) : 0;
    const buyDelta = (scenPlanned - basePlanned);

    // Margin $/unit estimate — prefer the scenario's own margin
    // signal (so a scenario that bumps a high-margin customer reads
    // its uplift correctly), fall back to base, null when neither
    // has usable data. Multiplied by demand_delta to attribute the
    // qty shift to a dollar value the planner can rank by.
    const marginPerUnit = scenMargin.get(k) ?? baseMargin.get(k) ?? null;
    const dmdDelta = scenDem - baseDem;
    const marginDelta = marginPerUnit != null ? dmdDelta * marginPerUnit : 0;

    demand_delta_sum  += dmdDelta;
    supply_delta_sum  += (scen.total_available_supply_qty - base.total_available_supply_qty);
    shortage_delta_sum += (scen.shortage_qty - base.shortage_qty);
    excess_delta_sum  += (scen.excess_qty - base.excess_qty);
    buy_delta_sum    += buyDelta;
    margin_dollars_delta_sum += marginDelta;

    rows.push({
      sku_id: base.sku_id || scen.sku_id,
      sku_code: item?.sku_code ?? "(unknown sku)",
      sku_description: item?.description ?? null,
      category_id: base.category_id ?? scen.category_id ?? null,
      category_name: cat?.name ?? null,
      period_code: base.period_code || scen.period_code,
      period_start: base.period_start || scen.period_start,
      base_demand: baseDem,
      scenario_demand: scenDem,
      demand_delta: scenDem - baseDem,
      base_supply: base.total_available_supply_qty,
      scenario_supply: scen.total_available_supply_qty,
      supply_delta: scen.total_available_supply_qty - base.total_available_supply_qty,
      base_ending: base.ending_inventory_qty,
      scenario_ending: scen.ending_inventory_qty,
      ending_delta: scen.ending_inventory_qty - base.ending_inventory_qty,
      base_shortage: base.shortage_qty,
      scenario_shortage: scen.shortage_qty,
      shortage_delta: scen.shortage_qty - base.shortage_qty,
      base_excess: base.excess_qty,
      scenario_excess: scen.excess_qty,
      excess_delta: scen.excess_qty - base.excess_qty,
      base_stockout: base.projected_stockout_flag,
      scenario_stockout: scen.projected_stockout_flag,
      base_top_rec: baseTop?.recommendation_type ?? null,
      scenario_top_rec: scenTop?.recommendation_type ?? null,
      base_planned_buy_qty: basePlanned,
      scenario_planned_buy_qty: scenPlanned,
      base_recommended_buy_qty: baseRecQty,
      scenario_recommended_buy_qty: scenRecQty,
      buy_delta: buyDelta,
      base_service_risk: baseRisk,
      scenario_service_risk: scenRisk,
      margin_per_unit_estimate: marginPerUnit,
      margin_dollars_delta: marginDelta,
    });
  }

  rows.sort((a, b) => {
    // Primary rank by abs gross-margin $ delta — bubbles the rows
    // where a scenario actually moves money to the top, even when
    // their unit delta is modest. Falls back to the unit-impact
    // sum for rows without usable margin data (so the comparison
    // still works against runs built before historical_margin_pct
    // was populated).
    const marginA = Math.abs(a.margin_dollars_delta);
    const marginB = Math.abs(b.margin_dollars_delta);
    if (marginA !== marginB) return marginB - marginA;
    const impactA = Math.abs(a.demand_delta) + Math.abs(a.shortage_delta) + Math.abs(a.buy_delta);
    const impactB = Math.abs(b.demand_delta) + Math.abs(b.shortage_delta) + Math.abs(b.buy_delta);
    return impactB - impactA;
  });

  return {
    rows,
    totals: {
      base_row_count: input.base.length,
      scenario_row_count: input.scenario.length,
      demand_delta_sum,
      supply_delta_sum,
      shortage_delta_sum,
      excess_delta_sum,
      buy_delta_sum,
      margin_dollars_delta_sum,
      service_risk_added,
      service_risk_removed,
      stockouts_added,
      stockouts_removed,
      recs_changed,
    },
  };
}

// Estimate margin-$ per incremental unit at the (sku, period) grain.
// margin_pct is gross-margin as a fraction of revenue, so:
//   price_per_unit         = unit_cost / (1 - margin_pct)
//   margin_$_per_unit      = price × margin_pct = unit_cost × pct / (1 - pct)
// Forecast rows are per-customer; we weight each customer's
// (pct, cost) by their final_forecast_qty so a 10k-unit customer
// dominates a 100-unit one. Margin_pct clamped below 0.95 to avoid
// the asymptote when a row looks like 95%+ margin (almost always a
// data error — cost field missing/zero).
function marginPerUnitByGrain(
  rows: IpWholesaleForecast[] | undefined,
  costBySku: Map<string, number>,
): Map<string, number> {
  if (!rows) return new Map();
  type Acc = { weightedPct: number; weight: number; cost: number };
  const acc = new Map<string, Acc>();
  for (const f of rows) {
    if (f.historical_margin_pct == null) continue;
    // Prefer the planner's per-row cost override; fall back to the
    // item master cost. No usable cost → skip the row (can't put
    // a $ on a margin %).
    const cost = (f.unit_cost_override != null && f.unit_cost_override > 0)
      ? f.unit_cost_override
      : (costBySku.get(f.sku_id) ?? 0);
    if (cost <= 0) continue;
    const w = f.final_forecast_qty;
    if (!w || w <= 0) continue;
    const k = `${f.sku_id}:${f.period_start}`;
    const cur = acc.get(k);
    if (cur) {
      cur.weightedPct += f.historical_margin_pct * w;
      cur.weight += w;
      // Cost is per-sku and stable across customers at the same
      // grain; keep the first seen as the representative.
      if (cur.cost <= 0) cur.cost = cost;
    } else {
      acc.set(k, { weightedPct: f.historical_margin_pct * w, weight: w, cost });
    }
  }
  const out = new Map<string, number>();
  for (const [k, a] of acc) {
    if (a.weight <= 0 || a.cost <= 0) continue;
    const pct = Math.min(0.95, Math.max(-1, a.weightedPct / a.weight));
    const denom = 1 - pct;
    if (denom <= 0) continue;
    out.set(k, (a.cost * pct) / denom);
  }
  return out;
}

function sumPlannedBuyByGrain(rows: IpWholesaleForecast[] | undefined): Map<string, number> {
  const out = new Map<string, number>();
  if (!rows) return out;
  for (const f of rows) {
    const buy = f.planned_buy_qty ?? 0;
    if (buy === 0) continue;
    const k = `${f.sku_id}:${f.period_start}`;
    out.set(k, (out.get(k) ?? 0) + buy);
  }
  return out;
}

function isBuyAction(t: string | null | undefined): boolean {
  return t === "buy" || t === "expedite";
}

// Returns the highest-priority recommendation per (sku, period_start)
// grain. Now exposes the full row (not just the type) so the
// comparison can read service_risk_flag and recommendation_qty.
function topRecByGrain(recs: IpInventoryRecommendation[]): Map<string, IpInventoryRecommendation> {
  const rank = { critical: 0, high: 1, medium: 2, low: 3 } as const;
  const byKey = new Map<string, IpInventoryRecommendation>();
  for (const r of recs) {
    const k = `${r.sku_id}:${r.period_start}`;
    const prev = byKey.get(k);
    if (!prev || rank[r.priority_level] < rank[prev.priority_level]) byKey.set(k, r);
  }
  return byKey;
}

function zeroRow(ref: IpProjectedInventory): IpProjectedInventory {
  return {
    ...ref,
    beginning_on_hand_qty: 0, ats_qty: 0,
    inbound_po_qty: 0, inbound_receipts_qty: 0, wip_qty: 0,
    total_available_supply_qty: 0,
    wholesale_demand_qty: 0, ecom_demand_qty: 0,
    protected_ecom_qty: 0, reserved_wholesale_qty: 0,
    allocated_wholesale_qty: 0, allocated_ecom_qty: 0, allocated_total_qty: 0,
    ending_inventory_qty: 0, shortage_qty: 0, excess_qty: 0,
    projected_stockout_flag: false,
  };
}
