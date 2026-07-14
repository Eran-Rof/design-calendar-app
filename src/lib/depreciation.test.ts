import { describe, it, expect } from "vitest";
import {
  buildSchedule,
  midMonthWeights,
  monthlyStraightLineCents,
  disposalGainLossCents,
  type DepreciationAssetInput,
} from "./depreciation";

const sum = (rows: { depreciation_cents: number }[]) => rows.reduce((s, r) => s + r.depreciation_cents, 0);

describe("midMonthWeights", () => {
  it("sums to the useful life and half-loads the first & last period", () => {
    const w = midMonthWeights(12);
    expect(w.length).toBe(13);
    expect(w[0]).toBe(0.5);
    expect(w[w.length - 1]).toBe(0.5);
    expect(w.reduce((s, x) => s + x, 0)).toBe(12);
  });
  it("handles a one-month life", () => {
    expect(midMonthWeights(1)).toEqual([0.5, 0.5]);
  });
});

describe("straight_line", () => {
  const asset: DepreciationAssetInput = {
    acquisition_cost_cents: 1_200_00,
    salvage_value_cents: 0,
    useful_life_months: 12,
    method: "straight_line",
    in_service_date: "2026-01-10",
  };

  it("fully depreciates to the depreciable base to the cent", () => {
    const rows = buildSchedule(asset);
    expect(sum(rows)).toBe(1_200_00);
    expect(rows[rows.length - 1].accumulated_cents).toBe(1_200_00);
    expect(rows[rows.length - 1].book_value_cents).toBe(0);
  });

  it("spans life+1 months with half-loaded first & last months", () => {
    const rows = buildSchedule(asset);
    expect(rows.length).toBe(13);
    // first month = half of 100.00 = 50.00, middle = 100.00
    expect(rows[0].depreciation_cents).toBe(50_00);
    expect(rows[1].depreciation_cents).toBe(100_00);
    expect(rows[rows.length - 1].depreciation_cents).toBe(50_00);
    expect(rows[0].period_date).toBe("2026-01-31");
    expect(rows[1].period_date).toBe("2026-02-28");
  });

  it("respects the salvage floor", () => {
    const rows = buildSchedule({ ...asset, acquisition_cost_cents: 1_000_00, salvage_value_cents: 100_00 });
    expect(sum(rows)).toBe(900_00);
    expect(rows[rows.length - 1].book_value_cents).toBe(100_00); // cost - accum = 1000 - 900
  });

  it("returns empty for zero base or zero life", () => {
    expect(buildSchedule({ ...asset, useful_life_months: 0 })).toEqual([]);
    expect(buildSchedule({ ...asset, acquisition_cost_cents: 0 })).toEqual([]);
  });
});

describe("declining_balance_200 (double declining, SL switch-over)", () => {
  const asset: DepreciationAssetInput = {
    acquisition_cost_cents: 10_000_00,
    salvage_value_cents: 0,
    useful_life_months: 60,
    method: "declining_balance_200",
    in_service_date: "2026-01-01",
  };

  it("front-loads depreciation vs straight-line", () => {
    const db = buildSchedule(asset);
    const sl = buildSchedule({ ...asset, method: "straight_line" });
    // First full-weight period (index 1) — DB charges more than SL.
    expect(db[1].depreciation_cents).toBeGreaterThan(sl[1].depreciation_cents);
  });

  it("fully depreciates to salvage by end of life (switch-over guarantees it)", () => {
    const rows = buildSchedule(asset);
    expect(sum(rows)).toBe(10_000_00);
    expect(rows[rows.length - 1].book_value_cents).toBe(0);
  });

  it("never drops book value below salvage", () => {
    const rows = buildSchedule({ ...asset, salvage_value_cents: 1_000_00 });
    expect(sum(rows)).toBe(9_000_00);
    for (const r of rows) expect(r.book_value_cents).toBeGreaterThanOrEqual(1_000_00);
  });
});

describe("declining_balance_150", () => {
  const asset: DepreciationAssetInput = {
    acquisition_cost_cents: 10_000_00,
    salvage_value_cents: 0,
    useful_life_months: 36,
    method: "declining_balance_150",
    in_service_date: "2026-01-01",
  };
  it("depreciates the full base and is less aggressive than 200%", () => {
    const db150 = buildSchedule(asset);
    const db200 = buildSchedule({ ...asset, method: "declining_balance_200" });
    expect(sum(db150)).toBe(10_000_00);
    // 200% charges more in the first full period than 150%.
    expect(db200[1].depreciation_cents).toBeGreaterThan(db150[1].depreciation_cents);
  });
});

describe("units_of_production", () => {
  const asset: DepreciationAssetInput = {
    acquisition_cost_cents: 10_000_00,
    salvage_value_cents: 0,
    useful_life_months: 24,
    method: "units_of_production",
    in_service_date: "2026-01-01",
    units_total: 100_000,
  };

  it("charges proportional to units consumed", () => {
    const rows = buildSchedule(asset, [10_000, 20_000, 30_000]);
    expect(rows[0].depreciation_cents).toBe(1_000_00); // 10% of base
    expect(rows[1].depreciation_cents).toBe(2_000_00); // 20%
    expect(rows[2].depreciation_cents).toBe(3_000_00); // 30%
    expect(sum(rows)).toBe(6_000_00);
  });

  it("caps accumulated at the base even if usage overshoots units_total", () => {
    const rows = buildSchedule(asset, [60_000, 60_000]);
    expect(sum(rows)).toBe(10_000_00);
    expect(rows[rows.length - 1].book_value_cents).toBe(0);
  });

  it("returns empty when no usage series is supplied", () => {
    expect(buildSchedule(asset)).toEqual([]);
  });
});

describe("disposal truncation", () => {
  const asset: DepreciationAssetInput = {
    acquisition_cost_cents: 1_200_00,
    salvage_value_cents: 0,
    useful_life_months: 12,
    method: "straight_line",
    in_service_date: "2026-01-01",
    disposed_date: "2026-04-15",
  };
  it("truncates the schedule at the disposal month and reconciles accumulated", () => {
    const rows = buildSchedule(asset);
    expect(rows[rows.length - 1].period_date).toBe("2026-04-30");
    // Jan 50 + Feb 100 + Mar 100 + Apr 100 = 350.00
    expect(sum(rows)).toBe(350_00);
    expect(rows[rows.length - 1].accumulated_cents).toBe(350_00);
    expect(rows[rows.length - 1].book_value_cents).toBe(1_200_00 - 350_00);
  });
});

describe("helpers", () => {
  it("monthlyStraightLineCents floors the monthly amount", () => {
    expect(monthlyStraightLineCents({ acquisition_cost_cents: 1_000_00, salvage_value_cents: 0, useful_life_months: 3 })).toBe(33_333);
  });
  it("disposalGainLossCents = proceeds − net book value", () => {
    expect(disposalGainLossCents(1_000_00, 700_00, 200_00)).toBe(-100_00); // NBV 300, proceeds 200 → 100 loss
    expect(disposalGainLossCents(1_000_00, 900_00, 300_00)).toBe(200_00); // NBV 100, proceeds 300 → 200 gain
  });
});
