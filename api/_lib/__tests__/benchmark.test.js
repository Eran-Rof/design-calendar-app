import { describe, it, expect } from "vitest";
import { percentile, percentiles, priorMonthRange, aggregateByCategory, MIN_VENDORS_FOR_PUBLISH } from "../benchmark.js";

describe("percentile", () => {
  it("returns null for empty arrays", () => {
    expect(percentile([], 0.5)).toBe(null);
  });
  it("returns the single value for a 1-element array", () => {
    expect(percentile([42], 0.25)).toBe(42);
  });
  it("computes linear-interpolated percentiles", () => {
    const s = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    // n=10, rank at p=0.5 = 4.5 → between sorted[4]=50 and sorted[5]=60 → 55
    expect(percentile(s, 0.50)).toBe(55);
    expect(percentile(s, 0.25)).toBeCloseTo(32.5);
    expect(percentile(s, 0.75)).toBeCloseTo(77.5);
    expect(percentile(s, 0.90)).toBeCloseTo(91);
  });
});

describe("percentiles", () => {
  it("returns nulls + n=0 for empty input", () => {
    expect(percentiles([])).toEqual({ p25: null, p50: null, p75: null, p90: null, n: 0 });
  });
  it("drops non-finite values before computing", () => {
    const out = percentiles([10, "x", NaN, 20, null, 30, undefined, 40, 50]);
    expect(out.n).toBe(5);
    expect(out.p50).toBeCloseTo(30);
  });
  it("sorts internally so unsorted input works", () => {
    expect(percentiles([90, 10, 50, 20, 70]).p50).toBeCloseTo(50);
  });
});

describe("priorMonthRange", () => {
  it("returns the full calendar month before the given date", () => {
    expect(priorMonthRange(new Date("2026-05-15T00:00:00Z")))
      .toEqual({ period_start: "2026-04-01", period_end: "2026-04-30" });
  });
  it("crosses year boundaries cleanly", () => {
    expect(priorMonthRange(new Date("2026-01-10T00:00:00Z")))
      .toEqual({ period_start: "2025-12-01", period_end: "2025-12-31" });
  });
  it("handles 28-day February correctly", () => {
    expect(priorMonthRange(new Date("2026-03-05T00:00:00Z")))
      .toEqual({ period_start: "2026-02-01", period_end: "2026-02-28" });
  });
});

describe("aggregateByCategory", () => {
  it("groups rows by category, keeps distinct vendors, filters invalid values", () => {
    const rows = [
      { vendor_id: "v1", category: "cnc",   value: 100 },
      { vendor_id: "v2", category: "cnc",   value: 120 },
      { vendor_id: "v3", category: "cnc",   value: 0 },    // dropped by minPositive
      { vendor_id: "v4", category: "cnc",   value: "not" }, // dropped by NaN
      { vendor_id: "v5", category: "steel", value: 50 },
      { vendor_id: "v1", category: null,    value: 999 },  // dropped by missing category
    ];
    const out = aggregateByCategory(rows, { valueField: "value" });
    expect(out.cnc.values.sort()).toEqual([100, 120]);
    expect(out.cnc.vendorIds.size).toBe(2);
    expect(out.steel.vendorIds.size).toBe(1);
  });

  it("minPositive=false keeps zeros", () => {
    const out = aggregateByCategory(
      [{ vendor_id: "v1", category: "x", value: 0 }],
      { valueField: "value", minPositive: false },
    );
    expect(out.x.values).toEqual([0]);
  });
});

describe("publishing threshold", () => {
  it("MIN_VENDORS_FOR_PUBLISH is 5 to avoid thin-sample leaks", () => {
    expect(MIN_VENDORS_FOR_PUBLISH).toBe(5);
  });
});
