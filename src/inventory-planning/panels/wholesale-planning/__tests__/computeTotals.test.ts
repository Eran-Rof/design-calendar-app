// Unit tests for computeTotals — the pure aggregation behind the
// grid's totals strip + action / method chips.

import { describe, it, expect } from "vitest";
import { computeTotals } from "../computeTotals";
import type { IpPlanningGridRow } from "../../../types/wholesale";

function row(over: Partial<IpPlanningGridRow> = {}): IpPlanningGridRow {
  return {
    forecast_id: "f1",
    sku_id: "s1", sku_code: "S1", sku_style: "S1", sku_color: null, sku_size: null,
    sku_description: null, group_name: null, sub_category_name: null, category_id: null,
    customer_id: null, customer_name: null, channel_id: null,
    period_start: "2026-05-01", period_end: "2026-05-31", period_code: "2026-05",
    abc_class: null, xyz_class: null,
    historical_trailing_qty: 0, ly_reference_qty: 0, historical_margin_pct: null, historical_receipts_qty: 0,
    system_forecast_qty: 0, buyer_request_qty: 0, override_qty: 0,
    final_forecast_qty: 0,
    confidence_level: "", forecast_method: "system",
    on_hand_qty: 0, on_so_qty: 0, on_po_qty: 0, receipts_due_qty: 0,
    available_supply_qty: 0, planned_buy_qty: 0,
    avg_cost: null, ats_avg_cost: null, item_cost: null, unit_cost: null, unit_cost_override: null,
    projected_shortage_qty: 0, projected_excess_qty: 0,
    recommended_action: "hold",
    ...over,
  } as IpPlanningGridRow;
}

describe("computeTotals", () => {
  it("sums final_forecast_qty across rows", () => {
    const t = computeTotals(
      [
        row({ forecast_id: "a", final_forecast_qty: 100 }),
        row({ forecast_id: "b", final_forecast_qty: 50 }),
        row({ forecast_id: "c", final_forecast_qty: 25 }),
      ],
      new Map(),
    );
    expect(t.final).toBe(175);
  });

  it("counts rows per recommended_action", () => {
    const t = computeTotals(
      [
        row({ recommended_action: "buy" }),
        row({ recommended_action: "buy" }),
        row({ recommended_action: "hold" }),
        row({ recommended_action: "expedite" }),
      ],
      new Map(),
    );
    expect(t.actions).toEqual({ buy: 2, hold: 1, expedite: 1 });
  });

  it("counts rows per forecast_method", () => {
    const t = computeTotals(
      [
        row({ forecast_method: "system" }),
        row({ forecast_method: "system" }),
        row({ forecast_method: "manual" }),
      ],
      new Map(),
    );
    expect(t.methods).toEqual({ system: 2, manual: 1 });
  });

  it("sums excess + shortage from skuPeriodMath, not from rows", () => {
    const t = computeTotals(
      [
        row({ projected_excess_qty: 99, projected_shortage_qty: 99 }),  // ignored
      ],
      new Map([
        ["sku1|2026-05", { excess: 10, shortage:  0 }],
        ["sku1|2026-06", { excess:  0, shortage:  5 }],
        ["sku2|2026-05", { excess:  4, shortage:  2 }],
      ]),
    );
    expect(t.excess).toBe(14);
    expect(t.shortage).toBe(7);
  });

  it("returns zeros for empty input", () => {
    const t = computeTotals([], new Map());
    // `columns` always carries the deduped supply totals (shortage/excess),
    // which are 0 for empty input but still present as keys.
    expect(t).toEqual({ final: 0, shortage: 0, excess: 0, actions: {}, methods: {}, columns: { shortage: 0, excess: 0 } });
  });
});
