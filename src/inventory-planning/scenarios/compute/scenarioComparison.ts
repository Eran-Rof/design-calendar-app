// Diff two reconciled planning runs (base + scenario) at the
// (sku, period) grain. Pure over input row sets — the service gathers
// the rows and passes them here.

import type { IpProjectedInventory } from "../../supply/types/supply";
import type { IpInventoryRecommendation } from "../../supply/types/supply";
import type { IpItem, IpCategory } from "../../types/entities";
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
}

export function compareScenarioToBase(input: ComparisonInput): {
  rows: ScenarioComparisonRow[];
  totals: ScenarioComparisonTotals;
} {
  const itemById = new Map(input.items.map((i) => [i.id, i]));
  const catById = new Map(input.categories.map((c) => [c.id, c]));
  const baseRecTop = topRecByGrain(input.baseRecs);
  const scenRecTop = topRecByGrain(input.scenarioRecs);

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
    if ((baseTop ?? null) !== (scenTop ?? null)) recs_changed++;

    if (!base.projected_stockout_flag && scen.projected_stockout_flag) stockouts_added++;
    if (base.projected_stockout_flag && !scen.projected_stockout_flag) stockouts_removed++;

    demand_delta_sum  += (scenDem - baseDem);
    supply_delta_sum  += (scen.total_available_supply_qty - base.total_available_supply_qty);
    shortage_delta_sum += (scen.shortage_qty - base.shortage_qty);
    excess_delta_sum  += (scen.excess_qty - base.excess_qty);

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
      base_top_rec: baseTop,
      scenario_top_rec: scenTop,
    });
  }

  rows.sort((a, b) => {
    const impactA = Math.abs(a.demand_delta) + Math.abs(a.shortage_delta);
    const impactB = Math.abs(b.demand_delta) + Math.abs(b.shortage_delta);
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
      stockouts_added,
      stockouts_removed,
      recs_changed,
    },
  };
}

function topRecByGrain(recs: IpInventoryRecommendation[]): Map<string, string> {
  const rank = { critical: 0, high: 1, medium: 2, low: 3 } as const;
  const byKey = new Map<string, IpInventoryRecommendation>();
  for (const r of recs) {
    const k = `${r.sku_id}:${r.period_start}`;
    const prev = byKey.get(k);
    if (!prev || rank[r.priority_level] < rank[prev.priority_level]) byKey.set(k, r);
  }
  const out = new Map<string, string>();
  for (const [k, r] of byKey) out.set(k, r.recommendation_type);
  return out;
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
