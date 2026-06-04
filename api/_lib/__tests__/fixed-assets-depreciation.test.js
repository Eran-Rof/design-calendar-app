import { describe, it, expect } from "vitest";
import { straightLineSchedule, monthlyAmount } from "../fixed-assets/depreciation.js";

const asset = { acquisition_cost_cents: 120000, salvage_value_cents: 0, useful_life_months: 12, acquisition_date: "2026-01-15" };

describe("monthlyAmount", () => {
  it("(cost − salvage) / life, floored", () => {
    expect(monthlyAmount(asset)).toBe(10000);
    expect(monthlyAmount({ acquisition_cost_cents: 100000, salvage_value_cents: 10000, useful_life_months: 9 })).toBe(10000);
    expect(monthlyAmount({ acquisition_cost_cents: 0, useful_life_months: 12 })).toBe(0);
  });
});

describe("straightLineSchedule", () => {
  it("emits a month-end period per month from start through the target", () => {
    const r = straightLineSchedule(asset, "2026-03-31");
    expect(r.periods.map((p) => p.period_date)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
    expect(r.periods.every((p) => p.amount_cents === 10000)).toBe(true);
    expect(r.total_cents).toBe(30000);
  });
  it("skips already-recorded periods", () => {
    const r = straightLineSchedule(asset, "2026-03-31", ["2026-01-31", "2026-02-28"], 20000);
    expect(r.periods).toEqual([{ period_date: "2026-03-31", amount_cents: 10000 }]);
  });
  it("never depreciates past the depreciable base (full life)", () => {
    const r = straightLineSchedule(asset, "2027-12-31"); // way past 12mo life
    expect(r.total_cents).toBe(120000);
    expect(r.periods).toHaveLength(12);
  });
  it("caps the final period at the remaining base when starting partway", () => {
    const r = straightLineSchedule(asset, "2027-12-31", [], 115000);
    expect(r.total_cents).toBe(5000); // only 5000 of base remains
  });
  it("returns nothing for a zero-base or zero-life asset", () => {
    expect(straightLineSchedule({ acquisition_cost_cents: 0, useful_life_months: 12, acquisition_date: "2026-01-01" }, "2026-12-31").periods).toEqual([]);
    expect(straightLineSchedule({ acquisition_cost_cents: 1000, useful_life_months: 0, acquisition_date: "2026-01-01" }, "2026-12-31").periods).toEqual([]);
  });
  it("returns nothing when through-date precedes the start", () => {
    expect(straightLineSchedule(asset, "2025-12-31").periods).toEqual([]);
  });
  it("honors an explicit depreciation_start over acquisition_date", () => {
    const r = straightLineSchedule({ ...asset, depreciation_start: "2026-02-01" }, "2026-03-31");
    expect(r.periods.map((p) => p.period_date)).toEqual(["2026-02-28", "2026-03-31"]);
  });
});
