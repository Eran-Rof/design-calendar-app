// Tests for the aggregate Unit Cost fan-out target resolution.
// See ../utils/bucketUnitCost.ts.

import { describe, it, expect } from "vitest";
import { collectUnitCostBucketTargets, collectStyleColorPropagationTargets } from "../utils/bucketUnitCost";
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

describe("collectStyleColorPropagationTargets", () => {
  it("gathers mixed forecast + TBD siblings of the same style/color", () => {
    const edited = row({ forecast_id: "f-1", sku_style: "RYB0412PPK", sku_color: "Black" });
    const sib1 = row({ forecast_id: "f-2", sku_style: "RYB0412PPK", sku_color: "Black" });
    const sibTbd = row({ forecast_id: "tbd:9", sku_style: "RYB0412PPK", sku_color: "Black", is_tbd: true });
    const res = collectStyleColorPropagationTargets(edited, [edited, sib1, sibTbd]);
    expect(res.forecastIds).toEqual(["f-2"]);
    expect(res.tbdRows.map((r) => r.forecast_id)).toEqual(["tbd:9"]);
  });

  it("excludes the edited row itself", () => {
    const edited = row({ forecast_id: "f-1", sku_style: "S1", sku_color: "Red" });
    const res = collectStyleColorPropagationTargets(edited, [edited]);
    expect(res.forecastIds).toEqual([]);
    expect(res.tbdRows).toEqual([]);
  });

  it("excludes the same style with a different color", () => {
    const edited = row({ forecast_id: "f-1", sku_style: "S1", sku_color: "Black" });
    const other = row({ forecast_id: "f-2", sku_style: "S1", sku_color: "White" });
    const res = collectStyleColorPropagationTargets(edited, [edited, other]);
    expect(res.forecastIds).toEqual([]);
  });

  it("excludes a different style with the same color", () => {
    const edited = row({ forecast_id: "f-1", sku_style: "S1", sku_color: "Black" });
    const other = row({ forecast_id: "f-2", sku_style: "S2", sku_color: "Black" });
    const res = collectStyleColorPropagationTargets(edited, [edited, other]);
    expect(res.forecastIds).toEqual([]);
  });

  it("excludes aggregate rows (their leaf children match instead)", () => {
    const edited = row({ forecast_id: "f-1", sku_style: "S1", sku_color: "Black" });
    const agg = row({ forecast_id: "agg", sku_style: "S1", sku_color: "Black", is_aggregate: true });
    const leaf = row({ forecast_id: "f-2", sku_style: "S1", sku_color: "Black" });
    const res = collectStyleColorPropagationTargets(edited, [edited, agg, leaf]);
    expect(res.forecastIds).toEqual(["f-2"]);
  });

  it("matches case-insensitively and trims whitespace on style and color", () => {
    const edited = row({ forecast_id: "f-1", sku_style: " ryb0412ppk ", sku_color: "black" });
    const sib = row({ forecast_id: "f-2", sku_style: "RYB0412PPK", sku_color: " Black" });
    const res = collectStyleColorPropagationTargets(edited, [edited, sib]);
    expect(res.forecastIds).toEqual(["f-2"]);
  });

  it("does not propagate when the edited row's color is the TBD placeholder", () => {
    const edited = row({ forecast_id: "f-1", sku_style: "S1", sku_color: "TBD" });
    const other = row({ forecast_id: "f-2", sku_style: "S1", sku_color: "TBD", is_tbd: true });
    const res = collectStyleColorPropagationTargets(edited, [edited, other]);
    expect(res.forecastIds).toEqual([]);
    expect(res.tbdRows).toEqual([]);
  });

  it("excludes TBD-placeholder-color siblings when the edited row has a real color", () => {
    const edited = row({ forecast_id: "f-1", sku_style: "S1", sku_color: "Black" });
    const realSib = row({ forecast_id: "f-2", sku_style: "S1", sku_color: "Black" });
    const tbdPlaceholder = row({ forecast_id: "tbd:1", sku_style: "S1", sku_color: "TBD", is_tbd: true });
    const res = collectStyleColorPropagationTargets(edited, [edited, realSib, tbdPlaceholder]);
    expect(res.forecastIds).toEqual(["f-2"]);
    expect(res.tbdRows).toEqual([]);
  });

  it("returns empty when the edited row has an empty style or color", () => {
    const noStyle = row({ forecast_id: "f-1", sku_style: "  ", sku_color: "Black" });
    const noColor = row({ forecast_id: "f-2", sku_style: "S1", sku_color: null });
    const sib = row({ forecast_id: "f-3", sku_style: "S1", sku_color: "Black" });
    expect(collectStyleColorPropagationTargets(noStyle, [noStyle, sib]).forecastIds).toEqual([]);
    expect(collectStyleColorPropagationTargets(noColor, [noColor, sib]).forecastIds).toEqual([]);
  });

  it("selects the SAME targets whether the caller applies a number or a null (symmetric clear)", () => {
    // The write value (number vs null) never changes which rows are targeted —
    // clearing reverts exactly the group a number would have set.
    const edited = row({ forecast_id: "f-1", sku_style: "S1", sku_color: "Black" });
    const sib1 = row({ forecast_id: "f-2", sku_style: "S1", sku_color: "Black" });
    const sib2 = row({ forecast_id: "tbd:2", sku_style: "S1", sku_color: "Black", is_tbd: true });
    const all = [edited, sib1, sib2];
    const a = collectStyleColorPropagationTargets(edited, all);
    const b = collectStyleColorPropagationTargets(edited, all);
    expect(a.forecastIds).toEqual(b.forecastIds);
    expect(a.tbdRows.map((r) => r.forecast_id)).toEqual(b.tbdRows.map((r) => r.forecast_id));
    expect(a.forecastIds).toEqual(["f-2"]);
    expect(a.tbdRows.map((r) => r.forecast_id)).toEqual(["tbd:2"]);
  });
});
