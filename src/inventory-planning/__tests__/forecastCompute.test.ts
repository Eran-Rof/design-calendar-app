import { describe, it, expect } from "vitest";
import {
  buildWholesaleBaselineForecast,
  applyBuyerRequests,
  applyPlannerOverrides,
  buildFinalWholesaleForecast,
} from "../compute/forecast";
import type { IpForecastComputeInput } from "../types/wholesale";

const RUN = "run-1";
const CUST = "cust-1";
const SKU_A = "sku-a";
const SKU_B = "sku-b";
const CAT = "cat-1";

// Build a history row generator keyed by month.
function h(customer: string, sku: string, month: string, qty: number, category: string | null = CAT) {
  return { customer_id: customer, sku_id: sku, category_id: category, txn_date: `${month}-15`, qty };
}

const SNAPSHOT = "2026-04-30";
const HORIZON_START = "2026-05-01";
const HORIZON_END = "2026-06-30";

const baseInput = (overrides: Partial<IpForecastComputeInput> = {}): IpForecastComputeInput => ({
  planning_run_id: RUN,
  source_snapshot_date: SNAPSHOT,
  horizon_start: HORIZON_START,
  horizon_end: HORIZON_END,
  pairs: [{ customer_id: CUST, sku_id: SKU_A, category_id: CAT }],
  history: [],
  requests: [],
  overrides: [],
  ...overrides,
});

describe("buildWholesaleBaselineForecast", () => {
  it("emits zero_floor rows when there is no history", () => {
    const rows = buildWholesaleBaselineForecast(baseInput());
    expect(rows).toHaveLength(2); // May + June
    expect(rows.every((r) => r.forecast_method === "zero_floor")).toBe(true);
    expect(rows.every((r) => r.system_forecast_qty === 0)).toBe(true);
    expect(rows.every((r) => r.confidence_level === "estimate")).toBe(true);
  });

  it("picks trailing_avg_sku when history is dense and flat", () => {
    // 12 months of 100 each → avg 100
    const history = [];
    for (let m = 4; m >= 0; m--) history.push(h(CUST, SKU_A, `2026-0${m || 1}`.slice(0, 7), 100));
    const months = ["2025-05","2025-06","2025-07","2025-08","2025-09","2025-10","2025-11","2025-12","2026-01","2026-02","2026-03","2026-04"];
    const rich = months.map((m) => h(CUST, SKU_A, m, 100));
    const rows = buildWholesaleBaselineForecast(baseInput({ history: rich }));
    expect(rows[0].forecast_method).toBe("trailing_avg_sku");
    expect(rows[0].system_forecast_qty).toBe(100);
    expect(rows[0].confidence_level).toBe("probable");
  });

  it("picks weighted_recent_sku when recent months exceed average", () => {
    // 12 months, ramp: 10,10,10,10,10,10,10,10,10,200,200,200 → recent3 avg=200, 12-avg=42
    const months = ["2025-05","2025-06","2025-07","2025-08","2025-09","2025-10","2025-11","2025-12","2026-01","2026-02","2026-03","2026-04"];
    const qtys =   [10,10,10,10,10,10,10,10,10,200,200,200];
    const history = months.map((m, i) => h(CUST, SKU_A, m, qtys[i]));
    const rows = buildWholesaleBaselineForecast(baseInput({ history }));
    expect(rows[0].forecast_method).toBe("weighted_recent_sku");
    expect(rows[0].system_forecast_qty).toBe(200);
  });

  it("uses weighted_recent_sku when 3 nonzero months pass the 30% recency gate", () => {
    // Orders in 2025-10, 2026-01, 2026-04 at 90 units each.
    // last12=270, last3=90 (≥ 30% × 270), recent3/3=30 > avg=22.5 → weighted wins.
    const history = [
      h(CUST, SKU_A, "2025-10", 90),
      h(CUST, SKU_A, "2026-01", 90),
      h(CUST, SKU_A, "2026-04", 90),
    ];
    const rows = buildWholesaleBaselineForecast(baseInput({ history }));
    expect(rows[0].forecast_method).toBe("weighted_recent_sku");
    expect(rows[0].system_forecast_qty).toBe(30);
    // 3 nonzero months lands below the 6-month "probable" threshold.
    expect(rows[0].confidence_level).toBe("possible");
  });

  it("uses cadence_sku on very sparse history (≤ 2 orders in a year)", () => {
    // Only 2025-10 and 2026-02 orders at 90 units each.
    // 2 nonzero months → nonZeroMonths < 3 → skips avg/weighted.
    // cadence = 4 months between orders, avg qty = 90 → 90/4 = 22.5 → 23
    const history = [
      h(CUST, SKU_A, "2025-10", 90),
      h(CUST, SKU_A, "2026-02", 90),
    ];
    const rows = buildWholesaleBaselineForecast(baseInput({ history }));
    expect(rows[0].forecast_method).toBe("cadence_sku");
    expect(rows[0].system_forecast_qty).toBe(23);
  });

  it("falls back to category when SKU has no history but category does", () => {
    const history = [
      h(CUST, SKU_B, "2026-02", 60, CAT),
      h(CUST, SKU_B, "2026-03", 60, CAT),
      h(CUST, SKU_B, "2026-04", 60, CAT),
    ];
    const rows = buildWholesaleBaselineForecast(baseInput({ history }));
    // No SKU_A history → category_fallback: 180/6/1 = 30
    expect(rows[0].forecast_method).toBe("category_fallback");
    expect(rows[0].system_forecast_qty).toBe(30);
    expect(rows[0].confidence_level).toBe("estimate");
  });

  it("returns zero_floor when even category is empty", () => {
    const rows = buildWholesaleBaselineForecast(baseInput({
      pairs: [{ customer_id: CUST, sku_id: SKU_A, category_id: null }],
    }));
    expect(rows[0].forecast_method).toBe("zero_floor");
  });
});

describe("applyBuyerRequests", () => {
  it("synthesizes rows for requests that have no history", () => {
    const rows = buildWholesaleBaselineForecast(baseInput());
    const req = {
      customer_id: CUST,
      sku_id: "sku-new",
      period_code: "2026-05",
      period_start: "2026-05-01",
      period_end: "2026-05-31",
      requested_qty: 150,
      confidence_level: "committed" as const,
    };
    const withReq = applyBuyerRequests(rows, [req]);
    const synth = withReq.find((r) => r.sku_id === "sku-new");
    expect(synth?.buyer_request_qty).toBe(150);
    expect(synth?.system_forecast_qty).toBe(0);
    expect(synth?.final_forecast_qty).toBe(150);
    expect(synth?.confidence_level).toBe("committed");
    expect(synth?.forecast_method).toBe("zero_floor");
    expect(synth?.notes).toContain("buyer request");
  });

  it("upgrades confidence when a committed request meets an estimate baseline", () => {
    const rows = buildWholesaleBaselineForecast(baseInput());
    // baseline is zero_floor/estimate
    const withReq = applyBuyerRequests(rows, [{
      customer_id: CUST, sku_id: SKU_A,
      period_code: "2026-05", period_start: "2026-05-01", period_end: "2026-05-31",
      requested_qty: 40, confidence_level: "committed",
    }]);
    const may = withReq.find((r) => r.sku_id === SKU_A && r.period_start === "2026-05-01");
    expect(may?.confidence_level).toBe("committed");
    expect(may?.buyer_request_qty).toBe(40);
    expect(may?.final_forecast_qty).toBe(40);
  });
});

describe("applyPlannerOverrides", () => {
  it("override on top of request preserves both sources", () => {
    const rows = buildWholesaleBaselineForecast(baseInput());
    const withReq = applyBuyerRequests(rows, [{
      customer_id: CUST, sku_id: SKU_A,
      period_code: "2026-05", period_start: "2026-05-01", period_end: "2026-05-31",
      requested_qty: 40, confidence_level: "possible",
    }]);
    const withOv = applyPlannerOverrides(withReq, [{
      customer_id: CUST, sku_id: SKU_A, period_start: "2026-05-01", override_qty: 10,
    }]);
    const may = withOv.find((r) => r.sku_id === SKU_A && r.period_start === "2026-05-01");
    expect(may?.system_forecast_qty).toBe(0);
    expect(may?.buyer_request_qty).toBe(40);
    expect(may?.override_qty).toBe(10);
    expect(may?.final_forecast_qty).toBe(50);
  });

  it("negative override never produces negative final", () => {
    const rows = buildWholesaleBaselineForecast(baseInput());
    const withOv = applyPlannerOverrides(rows, [{
      customer_id: CUST, sku_id: SKU_A, period_start: "2026-05-01", override_qty: -99,
    }]);
    const may = withOv.find((r) => r.period_start === "2026-05-01");
    expect(may?.override_qty).toBe(-99);
    expect(may?.final_forecast_qty).toBe(0);
  });
});

describe("methodPreference", () => {
  // Snapshot "2026-04-30" → LY codes: 2025-03 (13 back), 2025-04 (12 back), 2025-05 (11 back).
  // Standard 12-month lookback covers months 11-0 back = 2025-05 → 2026-04.
  // So 2025-04 and 2025-03 are only visible to the LY method.

  it("ly_sales uses data outside the standard lookback window", () => {
    // History exists only at month 12 back (2025-04) — invisible to standard waterfall.
    const history = [h(CUST, SKU_A, "2025-04", 120)];
    const withoutPref = buildWholesaleBaselineForecast(baseInput({ history }));
    expect(withoutPref[0].forecast_method).toBe("zero_floor"); // standard sees nothing

    const withPref = buildWholesaleBaselineForecast(baseInput({ history, methodPreference: "ly_sales" }));
    expect(withPref[0].forecast_method).toBe("ly_sales");
    expect(withPref[0].system_forecast_qty).toBe(120);
    expect(withPref[0].confidence_level).toBe("possible"); // 1 nonzero LY month
  });

  it("ly_sales with two LY months produces probable confidence", () => {
    const history = [h(CUST, SKU_A, "2025-03", 80), h(CUST, SKU_A, "2025-04", 120)];
    const rows = buildWholesaleBaselineForecast(baseInput({ history, methodPreference: "ly_sales" }));
    expect(rows[0].forecast_method).toBe("ly_sales");
    expect(rows[0].system_forecast_qty).toBe(100); // avg(80, 120)
    expect(rows[0].confidence_level).toBe("probable"); // ≥ 2 nonzero LY months
  });

  it("ly_sales falls through to standard waterfall when no LY data exists", () => {
    // Dense recent history but nothing 11-13 months back.
    const months = ["2025-06","2025-07","2025-08","2025-09","2025-10","2025-11","2025-12","2026-01","2026-02","2026-03","2026-04"];
    const history = months.map((m) => h(CUST, SKU_A, m, 50));
    const rows = buildWholesaleBaselineForecast(baseInput({ history, methodPreference: "ly_sales" }));
    expect(rows[0].forecast_method).toBe("trailing_avg_sku"); // LY null → fell through
    expect(rows[0].system_forecast_qty).toBe(46); // 11 months × 50 / 12 = 45.8 → 46
  });

  it("weighted_recent forces recent-3 result even when below the 30% recency gate", () => {
    // 9 months of 90, last 3 months of 10 → last3/last12 = 3.6% (below 30% gate).
    // Standard: trailing_avg (70). weighted_recent: forces recent3/3 = 10.
    const history = [
      h(CUST, SKU_A, "2025-05", 90), h(CUST, SKU_A, "2025-06", 90), h(CUST, SKU_A, "2025-07", 90),
      h(CUST, SKU_A, "2025-08", 90), h(CUST, SKU_A, "2025-09", 90), h(CUST, SKU_A, "2025-10", 90),
      h(CUST, SKU_A, "2025-11", 90), h(CUST, SKU_A, "2025-12", 90), h(CUST, SKU_A, "2026-01", 90),
      h(CUST, SKU_A, "2026-02", 10), h(CUST, SKU_A, "2026-03", 10), h(CUST, SKU_A, "2026-04", 10),
    ];
    const standard = buildWholesaleBaselineForecast(baseInput({ history }));
    expect(standard[0].forecast_method).toBe("trailing_avg_sku");
    expect(standard[0].system_forecast_qty).toBe(70);

    const withPref = buildWholesaleBaselineForecast(baseInput({ history, methodPreference: "weighted_recent" }));
    expect(withPref[0].forecast_method).toBe("weighted_recent_sku");
    expect(withPref[0].system_forecast_qty).toBe(10);
  });

  it("cadence pref skips step 1 and falls to cadence_sku even with dense history", () => {
    // 12 months of 100 → standard gives trailing_avg_sku/probable.
    // cadence pref: step 1 skipped → cadence_sku/possible.
    const months = ["2025-05","2025-06","2025-07","2025-08","2025-09","2025-10","2025-11","2025-12","2026-01","2026-02","2026-03","2026-04"];
    const history = months.map((m) => h(CUST, SKU_A, m, 100));
    const standard = buildWholesaleBaselineForecast(baseInput({ history }));
    expect(standard[0].forecast_method).toBe("trailing_avg_sku");
    expect(standard[0].confidence_level).toBe("probable");

    const withPref = buildWholesaleBaselineForecast(baseInput({ history, methodPreference: "cadence" }));
    expect(withPref[0].forecast_method).toBe("cadence_sku");
    expect(withPref[0].confidence_level).toBe("possible");
  });
});

describe("buildFinalWholesaleForecast", () => {
  it("layers system + request + override end-to-end", () => {
    const out = buildFinalWholesaleForecast(baseInput({
      history: [
        h(CUST, SKU_A, "2026-01", 50),
        h(CUST, SKU_A, "2026-02", 60),
        h(CUST, SKU_A, "2026-03", 70),
        h(CUST, SKU_A, "2026-04", 80),
      ],
      requests: [{
        customer_id: CUST, sku_id: SKU_A,
        period_code: "2026-06", period_start: "2026-06-01", period_end: "2026-06-30",
        requested_qty: 100, confidence_level: "committed",
      }],
      overrides: [{
        customer_id: CUST, sku_id: SKU_A, period_start: "2026-06-01", override_qty: 5,
      }],
    }));
    const june = out.find((r) => r.period_code === "2026-06");
    expect(june?.system_forecast_qty).toBeGreaterThan(0);
    expect(june?.buyer_request_qty).toBe(100);
    expect(june?.override_qty).toBe(5);
    expect(june?.final_forecast_qty).toBe(
      (june!.system_forecast_qty) + 100 + 5,
    );
  });
});
