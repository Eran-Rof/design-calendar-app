// Unit tests for computeTotals — the pure aggregation behind the
// grid's totals strip + action / method chips.

import { describe, it, expect } from "vitest";
import { computeTotals, lastPeriodAtsTotal } from "../computeTotals";
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
    // which are 0 for empty input but still present as keys. The `ats` key is
    // omitted entirely when there are no rows (mirrors the other supply keys).
    expect(t).toEqual({ final: 0, shortage: 0, excess: 0, actions: {}, methods: {}, columns: { shortage: 0, excess: 0 } });
  });

  // ── ATS column total: last-period-per-style/color, NOT sum-of-all-months ──

  it("ATS total takes only the last period of a single style/color (no month double-count)", () => {
    // One style/color rolling across 3 months. Summing all three would be
    // 300; the ending position is the June ATS = 60.
    const t = computeTotals(
      [
        row({ forecast_id: "a", sku_id: "s1", sku_style: "STY", sku_color: "RED", period_start: "2026-04-01", period_code: "2026-04", available_supply_qty: 100 }),
        row({ forecast_id: "b", sku_id: "s1", sku_style: "STY", sku_color: "RED", period_start: "2026-05-01", period_code: "2026-05", available_supply_qty: 80 }),
        row({ forecast_id: "c", sku_id: "s1", sku_style: "STY", sku_color: "RED", period_start: "2026-06-01", period_code: "2026-06", available_supply_qty: 60 }),
      ],
      new Map(),
    );
    expect(t.columns.ats).toBe(60);
  });

  it("ATS total sums the ending ATS across distinct style/color groups", () => {
    // Two style/colors, each rolling two months. Ending = 60 + 30 = 90.
    const t = computeTotals(
      [
        row({ forecast_id: "a", sku_id: "s1", sku_style: "STY", sku_color: "RED", period_start: "2026-05-01", period_code: "2026-05", available_supply_qty: 90 }),
        row({ forecast_id: "b", sku_id: "s1", sku_style: "STY", sku_color: "RED", period_start: "2026-06-01", period_code: "2026-06", available_supply_qty: 60 }),
        row({ forecast_id: "c", sku_id: "s2", sku_style: "STY", sku_color: "BLU", period_start: "2026-05-01", period_code: "2026-05", available_supply_qty: 50 }),
        row({ forecast_id: "d", sku_id: "s2", sku_style: "STY", sku_color: "BLU", period_start: "2026-06-01", period_code: "2026-06", available_supply_qty: 30 }),
      ],
      new Map(),
    );
    expect(t.columns.ats).toBe(90);
  });

  it("ATS total sums sizes (distinct sku_ids) within a style/color's ending period", () => {
    // Same style/color, two sizes, each its own rolling pool. Ending period is
    // June for both → 60 (size S) + 25 (size M) = 85.
    const t = computeTotals(
      [
        row({ forecast_id: "a", sku_id: "s1", sku_style: "STY", sku_color: "RED", sku_size: "S", period_start: "2026-05-01", period_code: "2026-05", available_supply_qty: 100 }),
        row({ forecast_id: "b", sku_id: "s1", sku_style: "STY", sku_color: "RED", sku_size: "S", period_start: "2026-06-01", period_code: "2026-06", available_supply_qty: 60 }),
        row({ forecast_id: "c", sku_id: "s2", sku_style: "STY", sku_color: "RED", sku_size: "M", period_start: "2026-05-01", period_code: "2026-05", available_supply_qty: 40 }),
        row({ forecast_id: "d", sku_id: "s2", sku_style: "STY", sku_color: "RED", sku_size: "M", period_start: "2026-06-01", period_code: "2026-06", available_supply_qty: 25 }),
      ],
      new Map(),
    );
    expect(t.columns.ats).toBe(85);
  });

  it("ATS total dedupes multi-customer rows in the ending period (one supply figure, not summed)", () => {
    // Same SKU + period appears on 3 customer rows carrying the SAME ATS
    // supply figure. It must count ONCE (60), not 3×60.
    const t = computeTotals(
      [
        row({ forecast_id: "a", sku_id: "s1", customer_id: "c1", sku_style: "STY", sku_color: "RED", period_start: "2026-06-01", period_code: "2026-06", available_supply_qty: 60 }),
        row({ forecast_id: "b", sku_id: "s1", customer_id: "c2", sku_style: "STY", sku_color: "RED", period_start: "2026-06-01", period_code: "2026-06", available_supply_qty: 60 }),
        row({ forecast_id: "c", sku_id: "s1", customer_id: "c3", sku_style: "STY", sku_color: "RED", period_start: "2026-06-01", period_code: "2026-06", available_supply_qty: 60 }),
      ],
      new Map(),
    );
    expect(t.columns.ats).toBe(60);
  });

  it("ATS total groups style/color case-insensitively and trimmed", () => {
    // "STY"/"Red" and " sty "/" RED " are the same group → one ending period,
    // deduped per sku → 70 (not 140).
    const t = computeTotals(
      [
        row({ forecast_id: "a", sku_id: "s1", sku_style: "STY", sku_color: "Red", period_start: "2026-06-01", period_code: "2026-06", available_supply_qty: 70 }),
        row({ forecast_id: "b", sku_id: "s1", sku_style: " sty ", sku_color: " RED ", period_start: "2026-06-01", period_code: "2026-06", available_supply_qty: 70 }),
      ],
      new Map(),
    );
    expect(t.columns.ats).toBe(70);
  });

  it("ATS total follows the filtered window (last period = max in view)", () => {
    // Same rows as the single-style test but the June row filtered out of the
    // view — the ending period becomes May, so the total is the May ATS (80).
    const inView = [
      row({ forecast_id: "a", sku_id: "s1", sku_style: "STY", sku_color: "RED", period_start: "2026-04-01", period_code: "2026-04", available_supply_qty: 100 }),
      row({ forecast_id: "b", sku_id: "s1", sku_style: "STY", sku_color: "RED", period_start: "2026-05-01", period_code: "2026-05", available_supply_qty: 80 }),
    ];
    expect(lastPeriodAtsTotal(inView)).toBe(80);
    expect(computeTotals(inView, new Map()).columns.ats).toBe(80);
  });

  it("lastPeriodAtsTotal returns 0 for empty input", () => {
    expect(lastPeriodAtsTotal([])).toBe(0);
  });
});
