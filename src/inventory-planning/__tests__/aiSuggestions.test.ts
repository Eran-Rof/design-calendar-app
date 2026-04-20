import { describe, it, expect } from "vitest";
import {
  suggestForecastAdjustment,
  suggestConfidenceAdjustment,
  suggestProtectionAdjustment,
  suggestInspectReturnRate,
  scoreBuyerRequestConfidence,
} from "../intelligence/compute/aiSuggestions";
import type { IpForecastAccuracy } from "../accuracy/types/accuracy";

function acc(partial: Partial<IpForecastAccuracy>): IpForecastAccuracy {
  return {
    id: "",
    planning_run_id: null, scenario_id: null,
    forecast_type: "wholesale",
    sku_id: "sku-a",
    customer_id: null, channel_id: null, category_id: null,
    period_start: "2026-05-01", period_end: "2026-05-31", period_code: "2026-05",
    system_forecast_qty: 0, final_forecast_qty: 100, actual_qty: 100,
    abs_error_system: 0, abs_error_final: 0,
    pct_error_system: null, pct_error_final: null,
    bias_system: 0, bias_final: 0,
    weighted_error_system: 0, weighted_error_final: 0,
    created_at: "",
    ...partial,
  };
}

describe("suggestForecastAdjustment", () => {
  it("suggests decrease_forecast on 3 consecutive overforecasts", () => {
    const trail = [
      acc({ pct_error_final: 0.3 }),
      acc({ pct_error_final: 0.2 }),
      acc({ pct_error_final: 0.25 }),
    ];
    const out = suggestForecastAdjustment(trail, 100);
    expect(out[0].suggestion_type).toBe("decrease_forecast");
    expect(out[0].suggested_qty_delta).toBeLessThan(0);
    expect(out[0].rationale).toMatch(/overshot/);
  });
  it("suggests increase_forecast on 3 consecutive underforecasts", () => {
    const trail = [
      acc({ pct_error_final: -0.3 }),
      acc({ pct_error_final: -0.2 }),
      acc({ pct_error_final: -0.4 }),
    ];
    const out = suggestForecastAdjustment(trail, 100);
    expect(out[0].suggestion_type).toBe("increase_forecast");
    expect(out[0].suggested_qty_delta).toBeGreaterThan(0);
  });
  it("no streak → no suggestion", () => {
    const trail = [
      acc({ pct_error_final: 0.05 }),
      acc({ pct_error_final: -0.05 }),
      acc({ pct_error_final: 0.0 }),
    ];
    expect(suggestForecastAdjustment(trail, 100)).toEqual([]);
  });
});

describe("suggestConfidenceAdjustment", () => {
  it("suggests increase_confidence when WAPE over last 4 < 10%", () => {
    const trail = [
      acc({ abs_error_final: 5, actual_qty: 100 }),
      acc({ abs_error_final: 5, actual_qty: 100 }),
      acc({ abs_error_final: 5, actual_qty: 100 }),
      acc({ abs_error_final: 5, actual_qty: 100 }),
    ];
    const out = suggestConfidenceAdjustment(trail);
    expect(out[0].suggestion_type).toBe("increase_confidence");
  });
  it("suggests lower_confidence when WAPE > 40%", () => {
    const trail = [
      acc({ abs_error_final: 50, actual_qty: 100 }),
      acc({ abs_error_final: 60, actual_qty: 100 }),
      acc({ abs_error_final: 50, actual_qty: 100 }),
      acc({ abs_error_final: 70, actual_qty: 100 }),
    ];
    const out = suggestConfidenceAdjustment(trail);
    expect(out[0].suggestion_type).toBe("lower_confidence");
  });
});

describe("suggestProtectionAdjustment", () => {
  it("fires after 2+ streak", () => {
    const out = suggestProtectionAdjustment("sku-x", "2026-05-04", "2026-05-10", "2026-W19", 2, 50);
    expect(out[0].suggestion_type).toBe("protect_more_inventory");
    expect(out[0].suggested_qty_delta).toBe(10);
  });
  it("silent on short streak", () => {
    expect(suggestProtectionAdjustment("sku-x", "a", "b", "c", 1, 50)).toEqual([]);
  });
});

describe("suggestInspectReturnRate", () => {
  it("fires at 40%+ returns", () => {
    const out = suggestInspectReturnRate("sku-x", "a", "b", "c", 0.45);
    expect(out[0].suggestion_type).toBe("inspect_return_rate");
  });
  it("silent under threshold", () => {
    expect(suggestInspectReturnRate("sku-x", "a", "b", "c", 0.1)).toEqual([]);
  });
});

describe("scoreBuyerRequestConfidence", () => {
  it("review when no history", () => {
    const out = scoreBuyerRequestConfidence("sku-x", "a", "b", "c", 100, 0);
    expect(out[0].suggestion_type).toBe("review_buyer_request");
    expect(out[0].rationale).toMatch(/no SKU history/);
  });
  it("review when request ≥ 3× trailing avg", () => {
    const out = scoreBuyerRequestConfidence("sku-x", "a", "b", "c", 400, 100);
    expect(out[0].suggestion_type).toBe("review_buyer_request");
  });
  it("silent when request is close to avg", () => {
    expect(scoreBuyerRequestConfidence("sku-x", "a", "b", "c", 110, 100)).toEqual([]);
  });
});
