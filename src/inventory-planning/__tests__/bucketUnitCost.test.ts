// Tests for the aggregate Unit Cost fan-out target resolution.
// See ../utils/bucketUnitCost.ts.

import { describe, it, expect } from "vitest";
import { collectUnitCostBucketTargets } from "../utils/bucketUnitCost";
import type { IpPlanningGridRow } from "../types/wholesale";

function row(p: Partial<IpPlanningGridRow>): IpPlanningGridRow {
  return {
    forecast_id: "f-1",
    planning_run_id: "run-1",
    customer_id: "cust-a",
    customer_name: "Customer A",
    category_id: null,
    category_name: null,
    group_name: null,
    sub_category_name: null,
    sku_id: "sku-1",
    sku_code: "STYLE1-RED",
    sku_description: null,
    sku_style: "STYLE1",
    sku_color: "Red",
    sku_size: null,
    period_code: "2026-06",
    period_start: "2026-06-01",
    period_end: "2026-06-30",
    historical_trailing_qty: 0,
    system_forecast_qty: 0,
    buyer_request_qty: 0,
    override_qty: 0,
    final_forecast_qty: 0,
    confidence_level: "estimate",
    forecast_method: "zero_floor",
    ly_reference_qty: null,
    item_cost: null,
    ats_avg_cost: null,
    avg_cost: null,
    unit_cost_override: null,
    unit_cost: null,
    planned_buy_qty: null,
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
    notes: null,
    ...p,
  } as IpPlanningGridRow;
}

function byId(rows: IpPlanningGridRow[]): Map<string, IpPlanningGridRow> {
  return new Map(rows.map((r) => [r.forecast_id, r] as const));
}

describe("collectUnitCostBucketTargets", () => {
  it("returns null for a non-aggregate row (caller uses single-row path)", () => {
    const r = row({ forecast_id: "f-1", is_aggregate: false });
    expect(collectUnitCostBucketTargets(r, byId([r]))).toBeNull();
  });

  it("returns null when an aggregate carries no underlying ids", () => {
    const r = row({ forecast_id: "agg", is_aggregate: true, aggregate_underlying_ids: [] });
    expect(collectUnitCostBucketTargets(r, byId([r]))).toBeNull();
  });

  it("splits leaf children into forecast ids and TBD rows", () => {
    const c1 = row({ forecast_id: "f-1" });
    const c2 = row({ forecast_id: "f-2" });
    const t1 = row({ forecast_id: "tbd:1", is_tbd: true });
    const agg = row({
      forecast_id: "agg",
      is_aggregate: true,
      aggregate_underlying_ids: ["f-1", "f-2", "tbd:1"],
    });
    const res = collectUnitCostBucketTargets(agg, byId([c1, c2, t1, agg]));
    expect(res).not.toBeNull();
    expect(res!.forecastIds).toEqual(["f-1", "f-2"]);
    expect(res!.tbdRows.map((r) => r.forecast_id)).toEqual(["tbd:1"]);
  });

  it("skips ids that don't resolve in the row map", () => {
    const c1 = row({ forecast_id: "f-1" });
    const agg = row({
      forecast_id: "agg",
      is_aggregate: true,
      aggregate_underlying_ids: ["f-1", "missing"],
    });
    const res = collectUnitCostBucketTargets(agg, byId([c1, agg]));
    expect(res!.forecastIds).toEqual(["f-1"]);
    expect(res!.tbdRows).toEqual([]);
  });

  it("resolves a nested aggregate child down to its leaves", () => {
    const leaf1 = row({ forecast_id: "f-1" });
    const leafTbd = row({ forecast_id: "tbd:9", is_tbd: true });
    const nested = row({
      forecast_id: "agg-inner",
      is_aggregate: true,
      aggregate_underlying_ids: ["f-1", "tbd:9"],
    });
    const outer = row({
      forecast_id: "agg-outer",
      is_aggregate: true,
      aggregate_underlying_ids: ["agg-inner"],
    });
    const res = collectUnitCostBucketTargets(outer, byId([leaf1, leafTbd, nested, outer]));
    expect(res!.forecastIds).toEqual(["f-1"]);
    expect(res!.tbdRows.map((r) => r.forecast_id)).toEqual(["tbd:9"]);
  });

  it("visits each leaf at most once", () => {
    const c1 = row({ forecast_id: "f-1" });
    const agg = row({
      forecast_id: "agg",
      is_aggregate: true,
      aggregate_underlying_ids: ["f-1", "f-1"],
    });
    const res = collectUnitCostBucketTargets(agg, byId([c1, agg]));
    expect(res!.forecastIds).toEqual(["f-1"]);
  });
});
