import { describe, it, expect } from "vitest";
import {
  computePerRowMetrics,
  overrideHelped,
  errorDelta,
  aggregateAccuracy,
  aggregateOverrideEffectiveness,
  HELPED_EPSILON,
} from "../accuracy/compute/accuracyMetrics";
import type { IpForecastAccuracy, IpOverrideEffectiveness } from "../accuracy/types/accuracy";

function baseAccuracy(partial: Partial<IpForecastAccuracy>): IpForecastAccuracy {
  return {
    id: "a",
    planning_run_id: null, scenario_id: null,
    forecast_type: "wholesale",
    sku_id: "sku-a",
    customer_id: null, channel_id: null, category_id: null,
    period_start: "2026-05-01", period_end: "2026-05-31", period_code: "2026-05",
    forecast_method: null,
    system_forecast_qty: 0, final_forecast_qty: 0, actual_qty: 0,
    abs_error_system: 0, abs_error_final: 0,
    pct_error_system: null, pct_error_final: null,
    bias_system: 0, bias_final: 0,
    weighted_error_system: 0, weighted_error_final: 0,
    created_at: "2026-05-01T00:00:00Z",
    ...partial,
  };
}

describe("computePerRowMetrics", () => {
  it("forecast exactly matches actual → zero error everywhere", () => {
    const m = computePerRowMetrics({ system_forecast_qty: 50, final_forecast_qty: 50, actual_qty: 50 });
    expect(m.abs_error_system).toBe(0);
    expect(m.abs_error_final).toBe(0);
    expect(m.pct_error_system).toBe(0);
    expect(m.bias_system).toBe(0);
  });
  it("forecast overstates actual → positive bias, positive abs", () => {
    const m = computePerRowMetrics({ system_forecast_qty: 120, final_forecast_qty: 110, actual_qty: 100 });
    expect(m.bias_system).toBe(20);
    expect(m.bias_final).toBe(10);
    expect(m.abs_error_system).toBe(20);
    expect(m.pct_error_final).toBeCloseTo(0.1, 5);
  });
  it("forecast understates actual → negative bias", () => {
    const m = computePerRowMetrics({ system_forecast_qty: 80, final_forecast_qty: 90, actual_qty: 100 });
    expect(m.bias_system).toBe(-20);
    expect(m.bias_final).toBe(-10);
    expect(m.pct_error_final).toBeCloseTo(-0.1, 5);
  });
  it("divide-by-zero: actual=0 leaves pct errors null", () => {
    const m = computePerRowMetrics({ system_forecast_qty: 10, final_forecast_qty: 5, actual_qty: 0 });
    expect(m.pct_error_system).toBeNull();
    expect(m.pct_error_final).toBeNull();
    expect(m.abs_error_system).toBe(10);
  });
  it("non-numeric inputs are coerced to 0 safely", () => {
    const m = computePerRowMetrics({ system_forecast_qty: NaN as unknown as number, final_forecast_qty: 10, actual_qty: 10 });
    expect(m.abs_error_system).toBe(10);
    expect(m.abs_error_final).toBe(0);
  });
});

describe("overrideHelped + errorDelta", () => {
  it("override improves the result → true", () => {
    // system = 100, final = 85, actual = 80. |100-80|=20, |85-80|=5 → helped.
    const inp = { system_forecast_qty: 100, final_forecast_qty: 85, actual_qty: 80 };
    expect(overrideHelped(inp)).toBe(true);
    expect(errorDelta(inp)).toBe(15);
  });
  it("override worsens the result → false", () => {
    const inp = { system_forecast_qty: 80, final_forecast_qty: 120, actual_qty: 80 };
    expect(overrideHelped(inp)).toBe(false);
    expect(errorDelta(inp)).toBe(-40);
  });
  it("tiny difference within epsilon → null (neutral)", () => {
    const inp = { system_forecast_qty: 80, final_forecast_qty: 80 + HELPED_EPSILON * 0.5, actual_qty: 80 };
    expect(overrideHelped(inp)).toBe(null);
  });
  it("no override (system == final) → null", () => {
    expect(overrideHelped({ system_forecast_qty: 50, final_forecast_qty: 50, actual_qty: 30 })).toBe(null);
  });
});

describe("aggregateAccuracy", () => {
  it("computes WAPE and mean bias", () => {
    const rows = [
      baseAccuracy({ abs_error_system: 10, abs_error_final: 5,
                     bias_system: 10, bias_final: 5,
                     actual_qty: 100 }),
      baseAccuracy({ id: "b", abs_error_system: 20, abs_error_final: 15,
                     bias_system: -20, bias_final: -15,
                     actual_qty: 100 }),
    ];
    const agg = aggregateAccuracy(rows);
    expect(agg.row_count).toBe(2);
    expect(agg.total_actual).toBe(200);
    expect(agg.wape_system).toBeCloseTo(0.15, 5); // 30/200
    expect(agg.wape_final).toBeCloseTo(0.1, 5);   // 20/200
    expect(agg.bias_final).toBe(-5);
    expect(agg.mae_delta).toBe(15 - 10);          // overrides helped by 5
  });
  it("empty set returns zeros", () => {
    const agg = aggregateAccuracy([]);
    expect(agg.row_count).toBe(0);
    expect(agg.wape_system).toBe(0);
  });
});

describe("aggregateOverrideEffectiveness", () => {
  it("buckets by override reason", () => {
    const rows: IpOverrideEffectiveness[] = [
      { id: "1", planning_run_id: null, scenario_id: null, forecast_type: "wholesale",
        sku_id: "a", customer_id: null, channel_id: null, category_id: null,
        period_start: "2026-05-01", period_end: "2026-05-31", period_code: "2026-05",
        override_reason: "buyer_request", system_forecast_qty: 100, final_forecast_qty: 90, actual_qty: 85,
        override_helped_flag: true, error_delta: 5, created_at: "x" },
      { id: "2", planning_run_id: null, scenario_id: null, forecast_type: "wholesale",
        sku_id: "a", customer_id: null, channel_id: null, category_id: null,
        period_start: "2026-05-01", period_end: "2026-05-31", period_code: "2026-05",
        override_reason: "planner_estimate", system_forecast_qty: 50, final_forecast_qty: 200, actual_qty: 60,
        override_helped_flag: false, error_delta: -140, created_at: "x" },
    ];
    const agg = aggregateOverrideEffectiveness(rows);
    const byReason = Object.fromEntries(agg.map((a) => [a.key, a]));
    expect(byReason.buyer_request.helped_count).toBe(1);
    expect(byReason.planner_estimate.hurt_count).toBe(1);
    expect(byReason.buyer_request.avg_error_delta).toBe(5);
    expect(byReason.planner_estimate.avg_error_delta).toBe(-140);
  });
});
