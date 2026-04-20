import { describe, it, expect } from "vitest";
import { compareScenarioToBase } from "../scenarios/compute/scenarioComparison";
import type { IpProjectedInventory, IpInventoryRecommendation } from "../supply/types/supply";
import type { IpItem, IpCategory } from "../types/entities";

function proj(partial: Partial<IpProjectedInventory>): IpProjectedInventory {
  return {
    id: "",
    planning_run_id: "run",
    sku_id: "sku-a", category_id: null,
    period_start: "2026-05-01", period_end: "2026-05-31", period_code: "2026-05",
    beginning_on_hand_qty: 0, ats_qty: 0,
    inbound_po_qty: 0, inbound_receipts_qty: 0, wip_qty: 0,
    total_available_supply_qty: 0,
    wholesale_demand_qty: 0, ecom_demand_qty: 0,
    protected_ecom_qty: 0, reserved_wholesale_qty: 0,
    allocated_wholesale_qty: 0, allocated_ecom_qty: 0, allocated_total_qty: 0,
    ending_inventory_qty: 0, shortage_qty: 0, excess_qty: 0,
    projected_stockout_flag: false, created_at: "",
    ...partial,
  };
}

function rec(partial: Partial<IpInventoryRecommendation>): IpInventoryRecommendation {
  return {
    id: "r", planning_run_id: "run", sku_id: "sku-a", category_id: null,
    period_start: "2026-05-01", period_end: "2026-05-31", period_code: "2026-05",
    recommendation_type: "hold", recommendation_qty: null, action_reason: null,
    priority_level: "low", shortage_qty: null, excess_qty: null,
    service_risk_flag: false, created_at: "",
    ...partial,
  };
}

const items: IpItem[] = [{
  id: "sku-a", sku_code: "SKU-A", style_code: null, description: null,
  category_id: null, vendor_id: null, color: null, size: null,
  uom: "each", unit_cost: null, unit_price: null,
  lead_time_days: null, moq_units: null,
  lifecycle_status: null, planning_class: null,
  active: true, external_refs: {}, attributes: {},
}];
const categories: IpCategory[] = [];

describe("compareScenarioToBase", () => {
  it("emits one row per grain with signed deltas", () => {
    const base = [proj({ sku_id: "sku-a", wholesale_demand_qty: 100, total_available_supply_qty: 50, shortage_qty: 50, projected_stockout_flag: true })];
    const scen = [proj({ sku_id: "sku-a", wholesale_demand_qty: 120, total_available_supply_qty: 150, shortage_qty: 0, excess_qty: 30, projected_stockout_flag: false })];
    const out = compareScenarioToBase({ base, scenario: scen, baseRecs: [], scenarioRecs: [], items, categories });
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].demand_delta).toBe(20);
    expect(out.rows[0].supply_delta).toBe(100);
    expect(out.rows[0].shortage_delta).toBe(-50);
    expect(out.rows[0].excess_delta).toBe(30);
    expect(out.totals.stockouts_removed).toBe(1);
    expect(out.totals.stockouts_added).toBe(0);
  });

  it("counts added stockouts", () => {
    const base = [proj({ projected_stockout_flag: false })];
    const scen = [proj({ projected_stockout_flag: true })];
    const out = compareScenarioToBase({ base, scenario: scen, baseRecs: [], scenarioRecs: [], items, categories });
    expect(out.totals.stockouts_added).toBe(1);
  });

  it("counts recs changed when top rec differs", () => {
    const base = [proj({})];
    const scen = [proj({})];
    const baseRecs = [rec({ recommendation_type: "hold" })];
    const scenRecs = [rec({ recommendation_type: "buy", priority_level: "high" })];
    const out = compareScenarioToBase({ base, scenario: scen, baseRecs, scenarioRecs: scenRecs, items, categories });
    expect(out.totals.recs_changed).toBe(1);
  });

  it("handles rows present only in base or only in scenario", () => {
    const base = [proj({ sku_id: "sku-a" })];
    const scen = [proj({ sku_id: "sku-b" })];
    const out = compareScenarioToBase({
      base, scenario: scen, baseRecs: [], scenarioRecs: [],
      items: [
        { ...items[0] },
        { ...items[0], id: "sku-b", sku_code: "SKU-B" },
      ],
      categories,
    });
    expect(out.rows).toHaveLength(2);
  });

  it("empty inputs → empty result", () => {
    const out = compareScenarioToBase({ base: [], scenario: [], baseRecs: [], scenarioRecs: [], items: [], categories: [] });
    expect(out.rows).toEqual([]);
    expect(out.totals.stockouts_added).toBe(0);
  });
});
