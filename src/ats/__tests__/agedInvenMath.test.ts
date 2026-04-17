import { describe, it, expect } from "vitest";
import {
  calcAgedCosts, calcAgedDays, parseSku,
  INTEREST_RATE, PALLET_PCS, STORAGE_PER_PALLET_MONTH, DEFAULT_LAST_RECEIVED,
} from "../agedInvenMath";

// ── parseSku ───────────────────────────────────────────────────────────────────

describe("parseSku", () => {
  describe("ATS format (space-dash-space separator)", () => {
    it("splits base and color on ' - '", () => {
      expect(parseSku("CMO0002 - Black/Red")).toEqual({ base: "CMO0002", color: "Black/Red" });
    });

    it("handles multi-word color", () => {
      expect(parseSku("RYB0413 - Light Grey")).toEqual({ base: "RYB0413", color: "Light Grey" });
    });

    it("trims whitespace from base and color", () => {
      expect(parseSku("  CMO0002  -  Black  ")).toEqual({ base: "CMO0002", color: "Black" });
    });

    it("uses only the first ' - ' as delimiter (color can contain ' - ')", () => {
      // If a color name itself contains ' - ', only the first occurrence splits
      const { base, color } = parseSku("BASE - Color - Extra");
      expect(base).toBe("BASE");
      expect(color).toBe("Color - Extra");
    });
  });

  describe("Xoro raw format (plain dash separator)", () => {
    it("two-part SKU: base + color, no size", () => {
      // Only 2 parts → color = parts[1]
      expect(parseSku("CMO0002-Black")).toEqual({ base: "CMO0002", color: "Black" });
    });

    it("three-part SKU: strips trailing size segment", () => {
      // BASE-Color-SM → base=BASE, color=Color (SM stripped as last part)
      expect(parseSku("CMO0002-Black-SM")).toEqual({ base: "CMO0002", color: "Black" });
    });

    it("four-part SKU: strips trailing size segment, joins color parts", () => {
      // BASE-Light-Grey-MD → base=BASE, color=Light-Grey (MD stripped)
      expect(parseSku("CMO0002-Light-Grey-MD")).toEqual({ base: "CMO0002", color: "Light-Grey" });
    });

    it("size segment with parens marks the split point", () => {
      // BASE-Color-SM(10) → size segment contains '(', so sizeIdx found
      expect(parseSku("CMO0002-Black-SM(10)")).toEqual({ base: "CMO0002", color: "Black" });
    });

    it("no dashes at all: returns full string as base with empty color", () => {
      expect(parseSku("SIMPLESKU")).toEqual({ base: "SIMPLESKU", color: "" });
    });

    it("trims base part", () => {
      expect(parseSku(" CMO0002-Black-SM ").base).toBe("CMO0002");
    });
  });
});

// ── calcAgedCosts ──────────────────────────────────────────────────────────────

describe("calcAgedCosts", () => {
  it("interest: daily = value × rate / 360", () => {
    const { intDaily } = calcAgedCosts(0, 36000);
    expect(intDaily).toBeCloseTo(36000 * INTEREST_RATE / 360);
  });

  it("interest: monthly = value × rate / 12", () => {
    const { intMonthly } = calcAgedCosts(0, 36000);
    expect(intMonthly).toBeCloseTo(36000 * INTEREST_RATE / 12);
  });

  it("interest: annual = value × rate", () => {
    const { intAnnual } = calcAgedCosts(0, 36000);
    expect(intAnnual).toBeCloseTo(36000 * INTEREST_RATE);
  });

  it("storage: monthly = qty / palletPcs × storageCost", () => {
    const { stoMonthly } = calcAgedCosts(PALLET_PCS, 0);
    expect(stoMonthly).toBeCloseTo(STORAGE_PER_PALLET_MONTH);
  });

  it("storage: daily = monthly / 30", () => {
    const { stoDaily, stoMonthly } = calcAgedCosts(PALLET_PCS, 0);
    expect(stoDaily).toBeCloseTo(stoMonthly / 30);
  });

  it("storage: annual = monthly × 12", () => {
    const { stoMonthly, stoAnnual } = calcAgedCosts(PALLET_PCS, 0);
    expect(stoAnnual).toBeCloseTo(stoMonthly * 12);
  });

  it("combined pct = (intAnnual + stoAnnual) / totalVal", () => {
    const qty = 864, val = 10000;
    const { intAnnual, stoAnnual, pctCost } = calcAgedCosts(qty, val);
    expect(pctCost).toBeCloseTo((intAnnual + stoAnnual) / val);
  });

  it("combined $ per item = (intAnnual + stoAnnual) / totalQty", () => {
    const qty = 864, val = 10000;
    const { intAnnual, stoAnnual, dolCost } = calcAgedCosts(qty, val);
    expect(dolCost).toBeCloseTo((intAnnual + stoAnnual) / qty);
  });

  it("pctCost is 0 when totalVal is 0 (no division by zero)", () => {
    expect(calcAgedCosts(100, 0).pctCost).toBe(0);
  });

  it("dolCost is 0 when totalQty is 0 (no division by zero)", () => {
    expect(calcAgedCosts(0, 1000).dolCost).toBe(0);
  });

  it("one full pallet for one year: storage annual = $240", () => {
    // 864 pcs = 1 pallet, $20/month × 12 = $240/year
    const { stoAnnual } = calcAgedCosts(PALLET_PCS, 0);
    expect(stoAnnual).toBeCloseTo(240);
  });

  it("monthly sums: intDaily × 30 ≈ intMonthly (360-day year)", () => {
    const { intDaily, intMonthly } = calcAgedCosts(0, 50000);
    expect(intDaily * 30).toBeCloseTo(intMonthly, 2);
  });
});

// ── calcAgedDays ───────────────────────────────────────────────────────────────

describe("calcAgedDays", () => {
  const today = new Date("2026-04-16T12:00:00");

  it("ISO date: counts days from lastReceived to today", () => {
    const days = calcAgedDays("2026-04-06", today);
    expect(days).toBe(10);
  });

  it("MM/DD/YYYY format is normalised correctly", () => {
    const days = calcAgedDays("04/06/2026", today);
    expect(days).toBe(10);
  });

  it("undefined falls back to DEFAULT_LAST_RECEIVED", () => {
    const fallback = calcAgedDays(undefined, today);
    const expected = calcAgedDays(DEFAULT_LAST_RECEIVED, today);
    expect(fallback).toBe(expected);
  });

  it("invalid date string returns 0 without throwing", () => {
    expect(calcAgedDays("not-a-date", today)).toBe(0);
  });

  it("same-day returns 0", () => {
    expect(calcAgedDays("2026-04-16", today)).toBe(0);
  });

  it("future date returns negative (not aged)", () => {
    expect(calcAgedDays("2026-04-20", today)).toBeLessThan(0);
  });
});
