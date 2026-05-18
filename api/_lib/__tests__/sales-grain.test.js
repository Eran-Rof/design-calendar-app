// Tests for the sales-grain helper module — the inference rule + the
// margin math that every nightly run leans on. These are pure functions
// so the tests are pure: no DB, no fixtures.

import { describe, it, expect } from "vitest";
import {
  inferQtyGrain,
  toQtyUnits,
  computeRowMargin,
  deriveSalesGrainFields,
} from "../sales-grain.js";

describe("inferQtyGrain", () => {
  describe("non-prepacks (pack_size <= 1)", () => {
    it("returns 'unit' for any item with pack_size 1", () => {
      expect(inferQtyGrain("RBB1234-RED-L", 1)).toBe("unit");
      expect(inferQtyGrain("RBB1234-PPK-RED", 1)).toBe("unit");
    });
    it("returns 'unit' when pack_size is null/undefined/0", () => {
      expect(inferQtyGrain("RYG1768PPK", null)).toBe("unit");
      expect(inferQtyGrain("RYG1768PPK", undefined)).toBe("unit");
      expect(inferQtyGrain("RYG1768PPK", 0)).toBe("unit");
    });
  });

  describe("prepacks (pack_size > 1)", () => {
    it("returns 'pack' when PPK is in the style code (modern prepacks)", () => {
      expect(inferQtyGrain("RYG1768PPK", 81)).toBe("pack");
      expect(inferQtyGrain("RYG1768PPK-Black", 81)).toBe("pack");
      expect(inferQtyGrain("RYB0412PPK24-RED-XL", 24)).toBe("pack");
    });
    it("returns 'pack' when PPK is in the size suffix (legacy prepacks)", () => {
      expect(inferQtyGrain("RYG0123-Black-PPK24", 24)).toBe("pack");
      expect(inferQtyGrain("ABC-RED-PPK", 18)).toBe("pack");
      expect(inferQtyGrain("ABC_RED_PPK6", 6)).toBe("pack");
    });
    it("returns 'unit' for a prepack-master line sold as a size variant (PPK token absent)", () => {
      // A prepack STYLE may have variant rows with no PPK token — e.g. a
      // single size pulled out of the pack. Those are at unit grain.
      expect(inferQtyGrain("RYG1768-Black-XL", 24)).toBe("unit");
      expect(inferQtyGrain("RYB0412-Red-M", 24)).toBe("unit");
    });
    it("is case-insensitive on the PPK token", () => {
      expect(inferQtyGrain("ryg1768ppk", 81)).toBe("pack");
      expect(inferQtyGrain("RYG1768Ppk-Black", 81)).toBe("pack");
    });
    it("does NOT match PPK embedded in a longer word (e.g. APPKEEPER)", () => {
      expect(inferQtyGrain("APPKEEPER-RED-L", 24)).toBe("unit");
    });
  });

  it("returns 'unit' for empty / missing Item Number", () => {
    expect(inferQtyGrain(null, 24)).toBe("unit");
    expect(inferQtyGrain(undefined, 24)).toBe("unit");
    expect(inferQtyGrain("", 24)).toBe("unit");
  });
});

describe("toQtyUnits", () => {
  it("multiplies by pack_size for pack-grain rows", () => {
    expect(toQtyUnits(20, "pack", 81)).toBe(1620);
    expect(toQtyUnits(5, "pack", 24)).toBe(120);
  });
  it("returns qty as-is for unit-grain rows", () => {
    expect(toQtyUnits(1620, "unit", 81)).toBe(1620);
    expect(toQtyUnits(100, "unit", 1)).toBe(100);
  });
  it("treats missing pack_size as 1 (no inflation)", () => {
    expect(toQtyUnits(50, "pack", null)).toBe(50);
    expect(toQtyUnits(50, "pack", undefined)).toBe(50);
    expect(toQtyUnits(50, "pack", 0)).toBe(50);
  });
  it("coerces string qty + handles negatives", () => {
    expect(toQtyUnits("20", "pack", 24)).toBe(480);
    expect(toQtyUnits(-5, "pack", 24)).toBe(-120);
  });
});

describe("computeRowMargin", () => {
  it("computes amount + pct for valid inputs", () => {
    // 100 units × $5 cost = $500 cost. $700 revenue → $200 margin, 28.57%.
    const m = computeRowMargin({ netAmount: 700, qtyUnits: 100, perUnitCost: 5 });
    expect(m.amount).toBe(200);
    expect(m.pct).toBeCloseTo(0.2857, 4);
  });
  it("handles zero margin (sale at cost)", () => {
    const m = computeRowMargin({ netAmount: 100, qtyUnits: 20, perUnitCost: 5 });
    expect(m.amount).toBe(0);
    expect(m.pct).toBe(0);
  });
  it("handles negative margin (sale below cost)", () => {
    const m = computeRowMargin({ netAmount: 80, qtyUnits: 20, perUnitCost: 5 });
    expect(m.amount).toBe(-20);
    expect(m.pct).toBeCloseTo(-0.25, 5);
  });
  it("returns null fields when netAmount is zero or negative", () => {
    expect(computeRowMargin({ netAmount: 0,   qtyUnits: 10, perUnitCost: 1 })).toEqual({ amount: null, pct: null });
    expect(computeRowMargin({ netAmount: -10, qtyUnits: 10, perUnitCost: 1 })).toEqual({ amount: null, pct: null });
  });
  it("returns null fields when any input is missing / non-numeric", () => {
    expect(computeRowMargin({ netAmount: null, qtyUnits: 10,   perUnitCost: 1 })).toEqual({ amount: null, pct: null });
    expect(computeRowMargin({ netAmount: 100,  qtyUnits: null, perUnitCost: 1 })).toEqual({ amount: null, pct: null });
    expect(computeRowMargin({ netAmount: 100,  qtyUnits: 10,   perUnitCost: null })).toEqual({ amount: null, pct: null });
    expect(computeRowMargin({ netAmount: 100,  qtyUnits: 10,   perUnitCost: NaN })).toEqual({ amount: null, pct: null });
  });
});

describe("deriveSalesGrainFields", () => {
  // The screenshot scenario from the bug report:
  // RYG1768PPK, pack_size=81, master unit_cost=$240/pack ($2.96/unit).
  // LY row: Xoro recorded as 20 PACKS at $240/pack = $4,800.
  // TY row: Xoro recorded as 1,620 UNITS at $2.96/unit = $4,800.
  // Both should normalise to 1,620 qty_units and same revenue.
  it("normalises pack-grain Xoro line to unit qty (the LY case)", () => {
    const r = deriveSalesGrainFields({
      rawItemNumber: "RYG1768PPK-Black",
      qty: 20,
      netAmount: 4800,
      master: { pack_size: 81, unit_cost: 240 },
    });
    expect(r.qty_grain).toBe("pack");
    expect(r.qty_units).toBe(1620);
    // per-unit cost = 240 / 81 = 2.962962…
    expect(r.unit_cost_at_sale).toBeCloseTo(2.9630, 4);
    // margin = 4800 - 1620 * 2.9630 = 4800 - 4800 = 0
    expect(r.margin_amount).toBeCloseTo(0, 2);
    expect(r.margin_pct).toBeCloseTo(0, 4);
  });

  it("preserves unit-grain Xoro line (the TY case)", () => {
    const r = deriveSalesGrainFields({
      rawItemNumber: "RYG1768-Black-XL", // size variant, no PPK token
      qty: 1620,
      netAmount: 4800,
      master: { pack_size: 81, unit_cost: 240 },
    });
    expect(r.qty_grain).toBe("unit");
    expect(r.qty_units).toBe(1620);
    // Same per-unit cost, same margin
    expect(r.margin_amount).toBeCloseTo(0, 2);
  });

  it("returns 'unit' grain + qty_units=qty for non-prepacks", () => {
    const r = deriveSalesGrainFields({
      rawItemNumber: "RBB1234-RED-L",
      qty: 12,
      netAmount: 360,
      master: { pack_size: 1, unit_cost: 15 },
    });
    expect(r.qty_grain).toBe("unit");
    expect(r.qty_units).toBe(12);
    expect(r.unit_cost_at_sale).toBe(15);
    expect(r.margin_amount).toBe(360 - 12 * 15);
    expect(r.margin_pct).toBeCloseTo((360 - 180) / 360, 4);
  });

  it("returns nulls for cost-dependent fields when master.unit_cost is missing", () => {
    const r = deriveSalesGrainFields({
      rawItemNumber: "RBB1234-RED-L",
      qty: 12,
      netAmount: 360,
      master: { pack_size: 1, unit_cost: null },
    });
    expect(r.qty_grain).toBe("unit");
    expect(r.qty_units).toBe(12);
    expect(r.unit_cost_at_sale).toBe(null);
    expect(r.margin_amount).toBe(null);
    expect(r.margin_pct).toBe(null);
  });

  it("survives a null master (e.g. item not in master cache yet)", () => {
    const r = deriveSalesGrainFields({
      rawItemNumber: "NEWITEM-X",
      qty: 5,
      netAmount: 50,
      master: null,
    });
    expect(r.qty_grain).toBe("unit");
    expect(r.qty_units).toBe(5);
    expect(r.unit_cost_at_sale).toBe(null);
    expect(r.margin_amount).toBe(null);
    expect(r.margin_pct).toBe(null);
  });
});
