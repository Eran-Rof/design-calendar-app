import { describe, it, expect } from "vitest";
import {
  detectDemandAnomalies,
  detectRepeatedForecastMiss,
  detectChronicStockout,
  detectReturnRateSpike,
  detectChronicOverbuy,
  detectForecastVolatility,
  detectProtectedRepeatedlyUncovered,
  detectBuyerRequestConversionMiss,
  runAnomalyDetection,
} from "../intelligence/compute/anomalyDetection";
import type { IpForecastAccuracy } from "../accuracy/types/accuracy";

function acc(partial: Partial<IpForecastAccuracy>): IpForecastAccuracy {
  return {
    id: "",
    planning_run_id: null, scenario_id: null,
    forecast_type: "wholesale",
    sku_id: "sku-a",
    customer_id: null, channel_id: null, category_id: null,
    period_start: "2026-05-01", period_end: "2026-05-31", period_code: "2026-05",
    system_forecast_qty: 0, final_forecast_qty: 0, actual_qty: 0,
    abs_error_system: 0, abs_error_final: 0,
    pct_error_system: null, pct_error_final: null,
    bias_system: 0, bias_final: 0,
    weighted_error_system: 0, weighted_error_final: 0,
    created_at: "",
    ...partial,
  };
}

describe("detectDemandAnomalies", () => {
  it("demand spike fires when actual ≥ 2× trailing avg", () => {
    const out = detectDemandAnomalies(
      acc({ actual_qty: 200 }),
      [50, 50, 50],
    );
    expect(out.length).toBe(1);
    expect(out[0].anomaly_type).toBe("demand_spike");
    expect(out[0].severity === "high" || out[0].severity === "medium").toBe(true);
  });
  it("demand collapse fires when actual is ≤ 25% of trailing avg", () => {
    const out = detectDemandAnomalies(
      acc({ actual_qty: 5 }),
      [100, 100, 100],
    );
    expect(out[0].anomaly_type).toBe("demand_collapse");
  });
  it("not enough trail returns empty", () => {
    expect(detectDemandAnomalies(acc({ actual_qty: 200 }), [50]).length).toBe(0);
  });
});

describe("detectRepeatedForecastMiss", () => {
  it("fires on 3 in a row over 25% error", () => {
    const trail = [
      acc({ pct_error_final: 0.4 }),
      acc({ pct_error_final: 0.5 }),
      acc({ pct_error_final: 0.3 }),
    ];
    const out = detectRepeatedForecastMiss(trail);
    expect(out.length).toBe(1);
    expect(out[0].anomaly_type).toBe("repeated_forecast_miss");
  });
  it("does not fire when one row is under threshold", () => {
    const trail = [
      acc({ pct_error_final: 0.4 }),
      acc({ pct_error_final: 0.1 }), // miss under 25%
      acc({ pct_error_final: 0.3 }),
    ];
    expect(detectRepeatedForecastMiss(trail).length).toBe(0);
  });
});

describe("detectChronicStockout", () => {
  it("fires on 3 trailing stockouts", () => {
    const out = detectChronicStockout("sku-x", [false, true, true, true], "2026-05-01", "2026-05-31", "2026-05");
    expect(out.length).toBe(1);
  });
  it("does not fire if the last isn't stockout", () => {
    const out = detectChronicStockout("sku-x", [true, true, true, false], "2026-05-01", "2026-05-31", "2026-05");
    expect(out.length).toBe(0);
  });
});

describe("detectReturnRateSpike", () => {
  it("fires when latest return rate ≥ threshold", () => {
    const out = detectReturnRateSpike("sku-x", [0.1, 0.15, 0.5], "2026-05-05", "2026-05-11", "2026-W19");
    expect(out[0].anomaly_type).toBe("return_rate_spike");
  });
});

describe("detectChronicOverbuy / volatility / buyer-request miss", () => {
  it("chronic overbuy fires when bias_final > 25% of actual for 3 in a row", () => {
    const trail = [
      acc({ bias_final: 40, actual_qty: 100 }),
      acc({ bias_final: 40, actual_qty: 100 }),
      acc({ bias_final: 40, actual_qty: 100 }),
    ];
    const out = detectChronicOverbuy(trail);
    expect(out[0].anomaly_type).toBe("chronic_overbuy");
  });
  it("forecast_volatility fires when CV > 1", () => {
    // CV = stdev / mean. Symmetric alternations max out at ~1.0; use
    // an asymmetric tail (5 quiet weeks + 1 spike) to push CV above 1.
    const trail = [
      acc({ final_forecast_qty: 5 }),
      acc({ final_forecast_qty: 5 }),
      acc({ final_forecast_qty: 5 }),
      acc({ final_forecast_qty: 5 }),
      acc({ final_forecast_qty: 5 }),
      acc({ final_forecast_qty: 1000 }),
    ];
    expect(detectForecastVolatility(trail).length).toBe(1);
  });
  it("buyer_request_conversion_miss fires when actual < 60% of requested", () => {
    const row = {
      ...acc({ actual_qty: 20 }),
      buyer_request_qty: 100,
    };
    expect(detectBuyerRequestConversionMiss(row).length).toBe(1);
  });
});

describe("detectProtectedRepeatedlyUncovered", () => {
  it("fires after 3 uncovered periods", () => {
    const out = detectProtectedRepeatedlyUncovered(
      "sku-x", [false, true, true, true], "2026-05-04", "2026-05-10", "2026-W19",
    );
    expect(out.length).toBe(1);
  });
});

describe("runAnomalyDetection (composed)", () => {
  it("doesn't explode on empty input", () => {
    const out = runAnomalyDetection({
      actualsBySku: new Map(),
      accuracyBySku: new Map(),
      stockoutsBySku: new Map(),
      returnRateBySku: new Map(),
      protectedUncoveredBySku: new Map(),
    }, []);
    expect(out).toEqual([]);
  });
});
