import { describe, it, expect } from "vitest";
import {
  varianceCents,
  variancePct,
  isFavorable,
  favorableWhenPositive,
  expandBudgetToMonths,
  grownBudgetCents,
  seedRowsFromActuals,
} from "../budget";

describe("varianceCents", () => {
  it("is actual minus budget, rounded to whole cents", () => {
    expect(varianceCents(10000, 8000)).toBe(2000);
    expect(varianceCents(8000, 10000)).toBe(-2000);
    expect(varianceCents(100.4, 0)).toBe(100);
  });
  it("treats missing values as zero", () => {
    expect(varianceCents(NaN as unknown as number, 0)).toBe(0);
    expect(varianceCents(500, undefined as unknown as number)).toBe(500);
  });
});

describe("variancePct", () => {
  it("is variance over the absolute budget", () => {
    expect(variancePct(12000, 10000)).toBeCloseTo(20);
    expect(variancePct(9000, 10000)).toBeCloseTo(-10);
  });
  it("is null when budget is zero (undefined percentage)", () => {
    expect(variancePct(5000, 0)).toBeNull();
  });
});

describe("isFavorable", () => {
  it("revenue is favorable when actual meets or beats budget", () => {
    expect(isFavorable("revenue", 12000, 10000)).toBe(true);
    expect(isFavorable("revenue", 10000, 10000)).toBe(true);
    expect(isFavorable("revenue", 8000, 10000)).toBe(false);
  });
  it("expense is favorable when actual is at or below budget", () => {
    expect(isFavorable("expense", 8000, 10000)).toBe(true);
    expect(isFavorable("expense", 12000, 10000)).toBe(false);
  });
  it("contra_revenue behaves like a cost (less is better)", () => {
    expect(isFavorable("contra_revenue", 500, 1000)).toBe(true);
    expect(isFavorable("contra_revenue", 1500, 1000)).toBe(false);
  });
});

describe("favorableWhenPositive", () => {
  it("is true only for revenue-like lines", () => {
    expect(favorableWhenPositive("revenue")).toBe(true);
    expect(favorableWhenPositive("expense")).toBe(false);
    expect(favorableWhenPositive("contra_revenue")).toBe(false);
  });
});

describe("expandBudgetToMonths", () => {
  it("spreads a full-year (period 0) budget evenly across 12 months", () => {
    const m = expandBudgetToMonths(120000, 0);
    expect(m.length).toBe(12);
    expect(m.every((x) => x === 10000)).toBe(true);
  });
  it("places a single-month (period N) budget in that month only", () => {
    const m = expandBudgetToMonths(50000, 3); // March
    expect(m[2]).toBe(50000);
    expect(m.filter((x) => x !== 0).length).toBe(1);
  });
  it("rounds the per-month share to the cent", () => {
    const m = expandBudgetToMonths(100, 0); // 100 / 12 = 8.33 → 8
    expect(m[0]).toBe(8);
  });
  it("returns all zeros for an out-of-range period", () => {
    expect(expandBudgetToMonths(100, 13).every((x) => x === 0)).toBe(true);
  });
});

describe("grownBudgetCents", () => {
  it("applies a positive growth percent", () => {
    expect(grownBudgetCents(100000, 5)).toBe(105000);
  });
  it("applies a negative growth percent", () => {
    expect(grownBudgetCents(100000, -10)).toBe(90000);
  });
  it("zero growth is identity", () => {
    expect(grownBudgetCents(123456, 0)).toBe(123456);
  });
});

describe("seedRowsFromActuals", () => {
  it("produces one full-year row per account with growth applied", () => {
    const rows = seedRowsFromActuals(
      [
        { gl_account_id: "a", amount_cents: 100000 },
        { gl_account_id: "b", amount_cents: 200000 },
      ],
      10,
    );
    expect(rows).toEqual([
      { gl_account_id: "a", period_number: 0, amount_cents: 110000 },
      { gl_account_id: "b", period_number: 0, amount_cents: 220000 },
    ]);
  });
  it("skips rows without an account id", () => {
    const rows = seedRowsFromActuals([{ gl_account_id: "", amount_cents: 5 }], 0);
    expect(rows.length).toBe(0);
  });
});
