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

    demand_delta_sum  += (scenDem - baseDem);
    supply_delta_sum  += (scen.total_available_supply_qty - base.total_available_supply_qty);
    shortage_delta_sum += (scen.shortage_qty - base.shortage_qty);
    excess_delta_sum  += (scen.excess_qty - base.excess_qty);
    buy_delta_sum    += buyDelta;

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
    });
  }

  rows.sort((a, b) => {
    // Buy delta now factors into impact ranking — a row whose buy
    // qty changes by 1,000 deserves attention even if its demand
    // delta is small (e.g., a reserve rule changed how much was
    // committed).
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
      service_risk_added,
      service_risk_removed,
      stockouts_added,
      stockouts_removed,
      recs_changed,
    },
  };
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
