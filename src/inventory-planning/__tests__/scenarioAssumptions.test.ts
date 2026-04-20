import { describe, it, expect } from "vitest";
import {
  scopeMatches,
  specificityRank,
  filterApplicable,
  applyAssumptionsToWholesaleRow,
  applyAssumptionsToEcomRow,
  applyReceiptDelayToDate,
  reserveQtyOverrideFor,
} from "../scenarios/compute/scenarioAssumptions";
import type { IpScenarioAssumption } from "../scenarios/types/scenarios";
import type { IpWholesaleForecast } from "../types/wholesale";
import type { IpEcomForecast } from "../ecom/types/ecom";

function assum(partial: Partial<IpScenarioAssumption>): IpScenarioAssumption {
  return {
    id: "a",
    scenario_id: "s",
    assumption_type: "demand_uplift_percent",
    applies_to_customer_id: null,
    applies_to_channel_id: null,
    applies_to_category_id: null,
    applies_to_sku_id: null,
    period_start: null,
    assumption_value: 0,
    assumption_unit: "percent",
    note: null,
    created_by: null,
    created_at: "", updated_at: "",
    ...partial,
  };
}

function wholesaleRow(partial: Partial<IpWholesaleForecast>): IpWholesaleForecast {
  return {
    id: "f",
    planning_run_id: "run",
    customer_id: "cust",
    category_id: "cat",
    sku_id: "sku",
    period_start: "2026-05-01",
    period_end: "2026-05-31",
    period_code: "2026-05",
    system_forecast_qty: 100,
    buyer_request_qty: 0,
    override_qty: 0,
    final_forecast_qty: 100,
    confidence_level: "possible",
    forecast_method: "trailing_avg_sku",
    history_months_used: 12,
    notes: null,
    created_at: "", updated_at: "",
    ...partial,
  };
}

function ecomRow(partial: Partial<IpEcomForecast>): IpEcomForecast {
  return {
    id: "e",
    planning_run_id: "run",
    channel_id: "chan",
    category_id: "cat",
    sku_id: "sku",
    week_start: "2026-05-04",
    week_end: "2026-05-10",
    period_code: "2026-W19",
    system_forecast_qty: 50,
    override_qty: 0,
    final_forecast_qty: 50,
    protected_ecom_qty: 50,
    promo_flag: false, launch_flag: false, markdown_flag: false,
    forecast_method: "trailing_13w",
    return_rate: 0.1,
    seasonality_factor: 1, promo_factor: 1, launch_factor: 1, markdown_factor: 1,
    trailing_4w_qty: 0, trailing_13w_qty: 0,
    notes: null,
    created_at: "", updated_at: "",
    ...partial,
  };
}

describe("scopeMatches", () => {
  it("null scope fields match anything", () => {
    expect(scopeMatches(assum({}), { sku_id: "x", period_start: "2026-05-01" })).toBe(true);
  });
  it("sku filter blocks non-matching rows", () => {
    expect(scopeMatches(
      assum({ applies_to_sku_id: "sku-a" }),
      { sku_id: "sku-b", period_start: "2026-05-01" },
    )).toBe(false);
  });
  it("period filter matches exactly", () => {
    const a = assum({ period_start: "2026-05-01" });
    expect(scopeMatches(a, { sku_id: "x", period_start: "2026-05-01" })).toBe(true);
    expect(scopeMatches(a, { sku_id: "x", period_start: "2026-06-01" })).toBe(false);
  });
});

describe("specificityRank", () => {
  it("sku beats category beats customer/channel", () => {
    expect(specificityRank(assum({ applies_to_sku_id: "x" })))
      .toBeGreaterThan(specificityRank(assum({ applies_to_category_id: "y" })));
    expect(specificityRank(assum({ applies_to_category_id: "y" })))
      .toBeGreaterThan(specificityRank(assum({ applies_to_customer_id: "z" })));
  });
});

describe("applyAssumptionsToWholesaleRow", () => {
  it("demand_uplift_percent lifts system and recomputes final", () => {
    const out = applyAssumptionsToWholesaleRow(wholesaleRow({ system_forecast_qty: 100 }), [
      assum({ assumption_type: "demand_uplift_percent", assumption_value: 20 }),
    ]);
    expect(out.system_forecast_qty).toBe(120);
    expect(out.final_forecast_qty).toBe(120);
  });
  it("stacks multiple uplifts (scope-sorted)", () => {
    const out = applyAssumptionsToWholesaleRow(wholesaleRow({ system_forecast_qty: 100 }), [
      assum({ assumption_type: "demand_uplift_percent", assumption_value: 10 }),
      assum({ assumption_type: "demand_uplift_percent", assumption_value: 20, applies_to_sku_id: "sku" }),
    ]);
    // 100 * 1.1 = 110, then 110 * 1.2 = 132
    expect(out.system_forecast_qty).toBe(132);
  });
  it("override_qty — most specific wins", () => {
    const out = applyAssumptionsToWholesaleRow(wholesaleRow({ system_forecast_qty: 100 }), [
      assum({ assumption_type: "override_qty", assumption_value: 5 }),
      assum({ assumption_type: "override_qty", assumption_value: 15, applies_to_sku_id: "sku" }),
    ]);
    expect(out.override_qty).toBe(15);
    expect(out.final_forecast_qty).toBe(115);
  });
  it("negative uplift floors final at 0", () => {
    const out = applyAssumptionsToWholesaleRow(wholesaleRow({ system_forecast_qty: 100 }), [
      assum({ assumption_type: "demand_uplift_percent", assumption_value: -200 }),
    ]);
    expect(out.system_forecast_qty).toBe(0);
    expect(out.final_forecast_qty).toBe(0);
  });
});

describe("applyAssumptionsToEcomRow", () => {
  it("promo/markdown flags + protection_percent", () => {
    const out = applyAssumptionsToEcomRow(ecomRow({ system_forecast_qty: 100 }), [
      assum({ assumption_type: "promo_flag", assumption_value: 1 }),
      assum({ assumption_type: "markdown_flag", assumption_value: 1 }),
      assum({ assumption_type: "protection_percent", assumption_value: 50 }),
    ]);
    expect(out.promo_flag).toBe(true);
    expect(out.markdown_flag).toBe(true);
    expect(out.protected_ecom_qty).toBe(50); // 50% of 100
  });
  it("no protection_percent → MVP default = final", () => {
    const out = applyAssumptionsToEcomRow(ecomRow({ system_forecast_qty: 80, protected_ecom_qty: 0 }), []);
    expect(out.protected_ecom_qty).toBe(80);
  });
});

describe("applyReceiptDelayToDate", () => {
  it("shifts forward", () => {
    expect(applyReceiptDelayToDate("2026-05-01", 7)).toBe("2026-05-08");
  });
  it("shifts back with negative", () => {
    expect(applyReceiptDelayToDate("2026-05-10", -9)).toBe("2026-05-01");
  });
  it("null passthrough", () => {
    expect(applyReceiptDelayToDate(null, 5)).toBeNull();
  });
});

describe("reserveQtyOverrideFor + filterApplicable", () => {
  it("returns most-specific match", () => {
    const out = reserveQtyOverrideFor([
      assum({ assumption_type: "reserve_qty_override", assumption_value: 10 }),
      assum({ assumption_type: "reserve_qty_override", assumption_value: 50, applies_to_sku_id: "sku" }),
    ], null, null, "sku");
    expect(out).toBe(50);
  });
  it("null when no match", () => {
    expect(reserveQtyOverrideFor([
      assum({ assumption_type: "reserve_qty_override", assumption_value: 50, applies_to_sku_id: "other" }),
    ], null, null, "sku")).toBeNull();
  });
  it("filterApplicable respects type filter", () => {
    const rows = filterApplicable([
      assum({ assumption_type: "demand_uplift_percent", assumption_value: 10 }),
      assum({ assumption_type: "reserve_qty_override", assumption_value: 50 }),
    ], { sku_id: "sku", period_start: "2026-05-01" }, "demand_uplift_percent");
    expect(rows.length).toBe(1);
  });
});
