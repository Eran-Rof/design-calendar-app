// src/lib/inventoryAging.test.ts
import { describe, it, expect } from "vitest";
import {
  bucketLabels, bucketIndex, ageDays, distributeLayers, carryingCost,
  weeksOfSupply, daysSinceLastSale, DEFAULT_BUCKET_DAYS, BUCKET_COUNT,
  type AgingLayer,
} from "./inventoryAging";
import { calcAgedCosts } from "../ats/agedInvenMath";

describe("bucketLabels", () => {
  it("labels the default 5 cut-offs into 6 human ranges", () => {
    expect(bucketLabels(DEFAULT_BUCKET_DAYS)).toEqual(["0-30", "31-60", "61-90", "91-180", "181-365", "366+"]);
  });
  it("honors custom cut-offs", () => {
    expect(bucketLabels([7, 14, 30, 60, 120])).toEqual(["0-7", "8-14", "15-30", "31-60", "61-120", "121+"]);
  });
});

describe("bucketIndex", () => {
  it("maps ages to 1..6 on the ≤ ladder", () => {
    expect(bucketIndex(0)).toBe(1);
    expect(bucketIndex(30)).toBe(1);
    expect(bucketIndex(31)).toBe(2);
    expect(bucketIndex(60)).toBe(2);
    expect(bucketIndex(90)).toBe(3);
    expect(bucketIndex(180)).toBe(4);
    expect(bucketIndex(365)).toBe(5);
    expect(bucketIndex(366)).toBe(6);
    expect(bucketIndex(9999)).toBe(6);
  });
});

describe("ageDays", () => {
  it("computes whole days as of the as-of date", () => {
    expect(ageDays("2024-01-01", "2024-01-31")).toBe(30);
    expect(ageDays("2024-01-01T12:00:00Z", "2024-03-01")).toBe(60); // 2024 leap year
  });
  it("clamps future receipts to 0", () => {
    expect(ageDays("2025-01-01", "2024-01-01")).toBe(0);
  });
  it("is 0 on invalid input", () => {
    expect(ageDays("", "2024-01-01")).toBe(0);
  });
});

describe("distributeLayers", () => {
  const layers: AgingLayer[] = [
    { received_at: "2024-06-01", remaining_qty: 100, unit_cost_cents: 500 },  // fresh
    { received_at: "2024-01-01", remaining_qty: 50, unit_cost_cents: 400 },   // old
    { received_at: "2099-01-01", remaining_qty: 999, unit_cost_cents: 1 },    // future → ignored
    { received_at: "2024-05-01", remaining_qty: 0, unit_cost_cents: 700 },    // zero → ignored
  ];
  const asOf = "2024-06-30";

  it("sums on-hand and value across non-future, non-zero layers", () => {
    const d = distributeLayers(layers, asOf);
    expect(d.onHandQty).toBe(150);
    expect(d.valueCents).toBe(100 * 500 + 50 * 400); // 70,000
    expect(d.avgUnitCostCents).toBeCloseTo(70000 / 150, 6);
  });

  it("splits each layer whole into its own age bucket", () => {
    const d = distributeLayers(layers, asOf);
    // 2024-06-01 → 29d → bucket 1 (idx 0); 2024-01-01 → 181d → bucket 5 (idx 4)
    expect(d.bucketQty[0]).toBe(100);
    expect(d.bucketQty[4]).toBe(50);
    expect(d.bucketQty.reduce((a, b) => a + b, 0)).toBe(150);
    expect(d.bucketQty).toHaveLength(BUCKET_COUNT);
  });

  it("weights average age by quantity and tracks the oldest", () => {
    const d = distributeLayers(layers, asOf);
    const age1 = ageDays("2024-06-01", asOf); // 29
    const age2 = ageDays("2024-01-01", asOf); // 181
    expect(d.wavgAgeDays).toBeCloseTo((100 * age1 + 50 * age2) / 150, 6);
    expect(d.oldestAgeDays).toBe(age2);
  });

  it("returns zeros for an empty layer set", () => {
    const d = distributeLayers([], asOf);
    expect(d.onHandQty).toBe(0);
    expect(d.avgUnitCostCents).toBe(0);
    expect(d.wavgAgeDays).toBe(0);
  });
});

describe("carryingCost — parity with ATS calcAgedCosts", () => {
  it("matches ATS dollar math ×100 (cents), for interest and storage", () => {
    const qty = 1728; // 2 pallets
    const valDollars = 12345.67;
    const valCents = Math.round(valDollars * 100);
    const ats = calcAgedCosts(qty, valDollars);
    const ours = carryingCost(qty, valCents);

    expect(ours.intAnnualCents).toBeCloseTo(ats.intAnnual * 100, 4);
    expect(ours.intDailyCents).toBeCloseTo(ats.intDaily * 100, 4);
    expect(ours.intMonthlyCents).toBeCloseTo(ats.intMonthly * 100, 4);
    expect(ours.stoAnnualCents).toBeCloseTo(ats.stoAnnual * 100, 4);
    expect(ours.stoMonthlyCents).toBeCloseTo(ats.stoMonthly * 100, 4);
  });

  it("carry % and per-unit are guarded against divide-by-zero", () => {
    const z = carryingCost(0, 0);
    expect(z.carryPct).toBe(0);
    expect(z.carryPerUnitCents).toBe(0);
  });
});

describe("weeksOfSupply / daysSinceLastSale", () => {
  it("computes weeks of supply from the 90-day velocity", () => {
    // 90 units sold in 90 days = 7 units/week; 140 on-hand → 20 weeks
    expect(weeksOfSupply(140, 90)).toBeCloseTo(20, 6);
  });
  it("returns null with no velocity", () => {
    expect(weeksOfSupply(100, 0)).toBeNull();
  });
  it("days since last sale honors as-of, null when never sold", () => {
    expect(daysSinceLastSale("2024-01-01", "2024-01-31")).toBe(30);
    expect(daysSinceLastSale(null, "2024-01-31")).toBeNull();
  });
});
