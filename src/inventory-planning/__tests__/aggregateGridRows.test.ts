// Tests for the wholesale-grid collapse aggregation. Logic was
// previously inline in WholesalePlanningGrid.tsx; moved to
// ../panels/aggregateGridRows.ts so it's unit-testable.

import { describe, it, expect } from "vitest";
import { aggregateRows, mergeBucket, type CollapseModes } from "../panels/aggregateGridRows";
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
  };
}

const NO_COLLAPSE: CollapseModes = {
  customers: false, colors: false, category: false, subCat: false,
  customerAllStyles: false, allCustomersPerCategory: false, allCustomersPerSubCat: false,
  allCustomersPerStyle: false,
};

describe("aggregateRows — grouping key", () => {
  it("with no collapse, two distinct (style, color) rows pass through unchanged", () => {
    // Sizes are always merged (no toggle), so the base granularity is
    // (style, color, customer, period) — not sku_id. This test asserts
    // that distinct (style, color) rows do NOT merge when no collapse
    // is set; the size-merge regression is in the next test.
    const a = row({ forecast_id: "f1", customer_id: "c1", sku_id: "s1", sku_style: "STYLE1", sku_color: "Red", period_code: "2026-06" });
    const b = row({ forecast_id: "f2", customer_id: "c1", sku_id: "s2", sku_style: "STYLE1", sku_color: "Blue", period_code: "2026-06" });
    const out = aggregateRows([a, b], NO_COLLAPSE);
    expect(out).toHaveLength(2);
    expect(out.find((r) => r.forecast_id === "f1")).toEqual(a);
    expect(out.find((r) => r.forecast_id === "f2")).toEqual(b);
    expect(out.every((r) => !r.is_aggregate)).toBe(true);
  });

  it("with no collapse, two sizes of the same (style, color, customer, period) ALWAYS merge", () => {
    // No toggle — yet the bucket key uses (style, color), so different
    // sku_id sizes of the same style+color collapse into one row by
    // default. This is the always-on size-merge.
    const a = row({ forecast_id: "f1", customer_id: "c1", sku_id: "s1-S",  sku_style: "STYLE1", sku_color: "Red", final_forecast_qty: 30 });
    const b = row({ forecast_id: "f2", customer_id: "c1", sku_id: "s1-M",  sku_style: "STYLE1", sku_color: "Red", final_forecast_qty: 50 });
    const c = row({ forecast_id: "f3", customer_id: "c1", sku_id: "s1-L",  sku_style: "STYLE1", sku_color: "Red", final_forecast_qty: 20 });
    const out = aggregateRows([a, b, c], NO_COLLAPSE);
    expect(out).toHaveLength(1);
    expect(out[0].is_aggregate).toBe(true);
    expect(out[0].final_forecast_qty).toBe(100);
    expect(out[0].aggregate_count).toBe(3);
  });

  it("collapses across customers when customers=true", () => {
    const a = row({ forecast_id: "f1", customer_id: "c1", sku_id: "s1", final_forecast_qty: 10 });
    const b = row({ forecast_id: "f2", customer_id: "c2", sku_id: "s1", final_forecast_qty: 20 });
    const out = aggregateRows([a, b], { ...NO_COLLAPSE, customers: true });
    expect(out).toHaveLength(1);
    expect(out[0].is_aggregate).toBe(true);
    expect(out[0].final_forecast_qty).toBe(30);
    expect(out[0].customer_id).toBe("*");
  });

  it("propagates sku_color_inferred onto the aggregate when any child is inferred", () => {
    const a = row({ forecast_id: "f1", customer_id: "c1", sku_id: "s1", sku_color_inferred: false });
    const b = row({ forecast_id: "f2", customer_id: "c2", sku_id: "s1", sku_color_inferred: true });
    const out = aggregateRows([a, b], { ...NO_COLLAPSE, customers: true });
    expect(out[0].sku_color_inferred).toBe(true);
  });

  it("does not flag the aggregate when every child has a master-set color", () => {
    const a = row({ forecast_id: "f1", customer_id: "c1", sku_id: "s1" });
    const b = row({ forecast_id: "f2", customer_id: "c2", sku_id: "s1" });
    const out = aggregateRows([a, b], { ...NO_COLLAPSE, customers: true });
    // Field is intentionally omitted (undefined) when no child was
    // inferred — keeps the row JSON small and the warning truthy-only.
    expect(out[0].sku_color_inferred).toBeFalsy();
  });

  it("keeps customers separate when collapsing colors only", () => {
    const a = row({ forecast_id: "f1", customer_id: "c1", sku_id: "s1", sku_style: "X", final_forecast_qty: 10 });
    const b = row({ forecast_id: "f2", customer_id: "c1", sku_id: "s2", sku_style: "X", final_forecast_qty: 20 });
    const c = row({ forecast_id: "f3", customer_id: "c2", sku_id: "s1", sku_style: "X", final_forecast_qty: 5 });
    const out = aggregateRows([a, b, c], { ...NO_COLLAPSE, colors: true });
    // c1: s1 + s2 collapsed by style. c2: s1 alone.
    expect(out).toHaveLength(2);
    const c1 = out.find((r) => r.customer_id === "c1")!;
    expect(c1.is_aggregate).toBe(true);
    expect(c1.final_forecast_qty).toBe(30);
    const c2 = out.find((r) => r.customer_id === "c2")!;
    expect(c2.is_aggregate).toBeFalsy();
    expect(c2.final_forecast_qty).toBe(5);
  });

  it("category mode keys by group_name × period only (drops SKU/color/customer)", () => {
    // Two Joggers rows merge; the single Tees row stays as a non-aggregate
    // singleton (the grouping bucketed it alone, so aggregateRows passes
    // it through unchanged — same as no-collapse behavior).
    const a = row({ forecast_id: "f1", group_name: "Joggers", customer_id: "c1", sku_id: "s1", final_forecast_qty: 10 });
    const b = row({ forecast_id: "f2", group_name: "Joggers", customer_id: "c2", sku_id: "s2", final_forecast_qty: 20 });
    const c = row({ forecast_id: "f3", group_name: "Tees", customer_id: "c1", sku_id: "s3", final_forecast_qty: 30 });
    const out = aggregateRows([a, b, c], { ...NO_COLLAPSE, category: true });
    expect(out).toHaveLength(2);
    // The merged Joggers row's sku_style is overwritten with the
    // group_name as part of the rollup-labeling logic.
    const joggers = out.find((r) => r.is_aggregate)!;
    expect(joggers.sku_style).toBe("Joggers");
    expect(joggers.final_forecast_qty).toBe(30);
    // The singleton Tees row keeps its original shape (no rollup label).
    const tees = out.find((r) => !r.is_aggregate)!;
    expect(tees.forecast_id).toBe("f3");
    expect(tees.final_forecast_qty).toBe(30);
  });

  it("subCat mode keys by sub_category_name × period only", () => {
    const a = row({ forecast_id: "f1", sub_category_name: "Tech Joggers", customer_id: "c1", final_forecast_qty: 10 });
    const b = row({ forecast_id: "f2", sub_category_name: "Tech Joggers", customer_id: "c2", final_forecast_qty: 20 });
    const out = aggregateRows([a, b], { ...NO_COLLAPSE, subCat: true });
    expect(out).toHaveLength(1);
    expect(out[0].sku_style).toBe("Tech Joggers");
    expect(out[0].final_forecast_qty).toBe(30);
  });

  it("nulls in group_name fall into a '—' bucket", () => {
    const a = row({ forecast_id: "f1", group_name: null, final_forecast_qty: 10 });
    const b = row({ forecast_id: "f2", group_name: null, final_forecast_qty: 20 });
    const c = row({ forecast_id: "f3", group_name: "Joggers", final_forecast_qty: 5 });
    const out = aggregateRows([a, b, c], { ...NO_COLLAPSE, category: true });
    expect(out).toHaveLength(2);
  });

  it("keeps periods separate even when collapsing across customers", () => {
    const a = row({ forecast_id: "f1", customer_id: "c1", sku_id: "s1", period_code: "2026-06", final_forecast_qty: 10 });
    const b = row({ forecast_id: "f2", customer_id: "c2", sku_id: "s1", period_code: "2026-06", final_forecast_qty: 20 });
    const c = row({ forecast_id: "f3", customer_id: "c1", sku_id: "s1", period_code: "2026-07", final_forecast_qty: 5 });
    const out = aggregateRows([a, b, c], { ...NO_COLLAPSE, customers: true });
    expect(out).toHaveLength(2);
    const june = out.find((r) => r.period_code === "2026-06")!;
    expect(june.final_forecast_qty).toBe(30);
    const july = out.find((r) => r.period_code === "2026-07")!;
    expect(july.final_forecast_qty).toBe(5);
  });
});

describe("mergeBucket — weighted-cost computation", () => {
  it("weights unit_cost by planned_buy_qty when buy>0 rows have a cost", () => {
    const out = mergeBucket(
      [
        row({ planned_buy_qty: 100, unit_cost: 10 }),
        row({ planned_buy_qty: 200, unit_cost: 20 }),
        // ignored: no buy
        row({ planned_buy_qty: null, unit_cost: 99 }),
      ],
      { ...NO_COLLAPSE, customers: true },
    );
    // (100*10 + 200*20) / (100+200) = 5000/300 ≈ 16.667
    expect(out.unit_cost).toBeCloseTo(16.667, 2);
  });

  it("falls back to plain mean of present unit_costs when no buy>0 row has a cost", () => {
    const out = mergeBucket(
      [
        row({ planned_buy_qty: 0, unit_cost: 10 }),
        row({ planned_buy_qty: null, unit_cost: 20 }),
        row({ planned_buy_qty: null, unit_cost: null }),
      ],
      { ...NO_COLLAPSE, customers: true },
    );
    expect(out.unit_cost).toBe(15);
  });

  it("returns null for unit_cost when nothing has a cost", () => {
    const out = mergeBucket(
      [row({ unit_cost: null }), row({ unit_cost: null })],
      { ...NO_COLLAPSE, customers: true },
    );
    expect(out.unit_cost).toBeNull();
  });

  it("populates avg_cost / item_cost from weightedCost (or first row's value as fallback)", () => {
    const out = mergeBucket(
      [
        row({ planned_buy_qty: 50, unit_cost: 12, avg_cost: 999, item_cost: 999 }),
        row({ planned_buy_qty: 50, unit_cost: 8 }),
      ],
      { ...NO_COLLAPSE, colors: true },
    );
    expect(out.unit_cost).toBe(10);
    expect(out.avg_cost).toBe(10);
    expect(out.item_cost).toBe(10);
  });
});

describe("mergeBucket — totals", () => {
  it("sums non-nullable numeric fields across the bucket", () => {
    const out = mergeBucket(
      [
        row({ historical_trailing_qty: 1, system_forecast_qty: 10, final_forecast_qty: 7 }),
        row({ historical_trailing_qty: 2, system_forecast_qty: 20, final_forecast_qty: 13 }),
      ],
      { ...NO_COLLAPSE, customers: true },
    );
    expect(out.historical_trailing_qty).toBe(3);
    expect(out.system_forecast_qty).toBe(30);
    expect(out.final_forecast_qty).toBe(20);
  });

  it("dedupes SKU-scoped fields (excess/shortage/on_hand/receipts) by (sku, period) across the bucket", () => {
    // Two rows sharing the same (sku, period) — projected_shortage_qty
    // is SKU-level, so the bucket should count it once, not twice.
    const out = mergeBucket(
      [
        row({ sku_id: "s1", period_start: "2026-06-01", projected_shortage_qty: 5, projected_excess_qty: 0, on_hand_qty: 100 }),
        row({ sku_id: "s1", period_start: "2026-06-01", projected_shortage_qty: 5, projected_excess_qty: 0, on_hand_qty: 100 }),
      ],
      { ...NO_COLLAPSE, customers: true },
    );
    expect(out.projected_shortage_qty).toBe(5);
    expect(out.projected_excess_qty).toBe(0);
    expect(out.on_hand_qty).toBe(100);
  });

  it("sumNullable returns null when no row has a non-null value", () => {
    const out = mergeBucket(
      [row({ planned_buy_qty: null }), row({ planned_buy_qty: null })],
      { ...NO_COLLAPSE, customers: true },
    );
    expect(out.planned_buy_qty).toBeNull();
  });

  it("sumNullable returns the sum of present values, ignoring nulls", () => {
    const out = mergeBucket(
      [
        row({ planned_buy_qty: 100 }),
        row({ planned_buy_qty: null }),
        row({ planned_buy_qty: 50 }),
      ],
      { ...NO_COLLAPSE, customers: true },
    );
    expect(out.planned_buy_qty).toBe(150);
  });
});

describe("mergeBucket — labels", () => {
  it("subCat rollup labels", () => {
    const out = mergeBucket(
      [
        row({ customer_name: "A", sub_category_name: "Tech Joggers", sku_style: "X" }),
        row({ customer_name: "B", sub_category_name: "Tech Joggers", sku_style: "Y" }),
      ],
      { ...NO_COLLAPSE, subCat: true },
    );
    expect(out.sku_style).toBe("Tech Joggers");
    expect(out.sku_color).toBeNull();
    expect(out.customer_name).toMatch(/2 cust · 2 styles/);
    expect(out.sku_description).toMatch(/Sub Cat rollup — 2 forecast rows/);
  });

  it("category rollup labels", () => {
    const out = mergeBucket(
      [
        row({ customer_name: "A", group_name: "Joggers", sku_style: "X" }),
        row({ customer_name: "A", group_name: "Joggers", sku_style: "X" }),
      ],
      { ...NO_COLLAPSE, category: true },
    );
    expect(out.sku_style).toBe("Joggers");
    expect(out.customer_name).toMatch(/1 cust · 1 styles/);
  });

  it("customer collapse with multiple customers shows count", () => {
    const out = mergeBucket(
      [row({ customer_name: "A" }), row({ customer_name: "B" })],
      { ...NO_COLLAPSE, customers: true },
    );
    expect(out.customer_name).toBe("(2 customers)");
  });

  it("color collapse with multiple colors shows count", () => {
    const out = mergeBucket(
      [row({ sku_color: "Red" }), row({ sku_color: "Blue" })],
      { ...NO_COLLAPSE, colors: true },
    );
    expect(out.sku_color).toBe("(2 colors)");
  });
});

describe("mergeBucket — invariants", () => {
  it("sets is_aggregate + aggregate_count on every merged row", () => {
    const out = mergeBucket([row({}), row({}), row({})], { ...NO_COLLAPSE, customers: true });
    expect(out.is_aggregate).toBe(true);
    expect(out.aggregate_count).toBe(3);
    expect(out.forecast_id).toMatch(/^agg:.*:3$/);
  });

  it("clears unit_cost_override on the rollup row", () => {
    const out = mergeBucket(
      [row({ unit_cost_override: 42 }), row({ unit_cost_override: 7 })],
      { ...NO_COLLAPSE, customers: true },
    );
    expect(out.unit_cost_override).toBeNull();
  });
});
