// Tests for the sales-grain helper module — the inference rule + the
// cost-grain rule + margin/cogs math that every nightly run leans on.
// Pure functions, no DB.

import { describe, it, expect } from "vitest";
import {
  inferQtyGrain,
  toQtyUnits,
  computeRowMargin,
  resolvePerUnitCost,
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

describe("resolvePerUnitCost", () => {
  it("divides per-pack master cost by pack_size for pack-grain sales", () => {
    const c = resolvePerUnitCost({
      masterUnitCost: 240, packSize: 60, grain: "pack",
      netAmount: 4800, qtyUnits: 1200,
    });
    expect(c).toBeCloseTo(4, 5);
  });

  it("uses master cost as-is for unit-grain sales with plausible cost vs price", () => {
    const c = resolvePerUnitCost({
      masterUnitCost: 5, packSize: 1, grain: "unit",
      netAmount: 87.5, qtyUnits: 10,
    });
    expect(c).toBe(5);
  });

  it("divides per-pack master cost by pack_size for unit-grain sale when master cost > 2x unit price", () => {
    // Variant SKU mis-tagged with pack_size=24, master cost $158 (per-pack).
    // Sold at $8.75/unit. 158 > 8.75*2 -> divide.
    const c = resolvePerUnitCost({
      masterUnitCost: 158, packSize: 24, grain: "unit",
      netAmount: 87.5, qtyUnits: 10,
    });
    expect(c).toBeCloseTo(158 / 24, 5);
  });

  it("uses master cost as-is when cost just slightly above price (within 2x threshold)", () => {
    const c = resolvePerUnitCost({
      masterUnitCost: 10, packSize: 24, grain: "unit",
      netAmount: 70, qtyUnits: 10,
    });
    expect(c).toBe(10);
  });

  it("falls back to as-is when sale price is missing / non-positive (can't sanity-check)", () => {
    const c = resolvePerUnitCost({
      masterUnitCost: 158, packSize: 24, grain: "unit",
      netAmount: null, qtyUnits: 0,
    });
    expect(c).toBe(158);
  });

  it("returns null when master cost is missing or non-numeric", () => {
    expect(resolvePerUnitCost({ masterUnitCost: null, packSize: 1, grain: "unit", netAmount: 10, qtyUnits: 1 })).toBe(null);
    expect(resolvePerUnitCost({ masterUnitCost: undefined, packSize: 1, grain: "unit", netAmount: 10, qtyUnits: 1 })).toBe(null);
    expect(resolvePerUnitCost({ masterUnitCost: "not a number", packSize: 1, grain: "unit", netAmount: 10, qtyUnits: 1 })).toBe(null);
  });

  it("returns null when master cost is zero (data quality gap, not a free-cost good)", () => {
    expect(resolvePerUnitCost({ masterUnitCost: 0, packSize: 1, grain: "unit", netAmount: 10, qtyUnits: 1 })).toBe(null);
    expect(resolvePerUnitCost({ masterUnitCost: 0, packSize: 60, grain: "pack", netAmount: 4800, qtyUnits: 1200 })).toBe(null);
  });

  it("returns null when master cost is negative (impossible — treat as missing)", () => {
    expect(resolvePerUnitCost({ masterUnitCost: -1, packSize: 1, grain: "unit", netAmount: 10, qtyUnits: 1 })).toBe(null);
  });
});

describe("deriveSalesGrainFields — zero-cost suppression", () => {
  it("suppresses cogs/margin when master.unit_cost is 0 (the RCB0975N-* 100% margin pollution)", () => {
    const r = deriveSalesGrainFields({
      rawItemNumber: "RCB0975N-GREY",
      qty: 736,
      netAmount: 4674,
      master: { pack_size: 60, unit_cost: 0 },
    });
    expect(r.qty_grain).toBe("unit");
    expect(r.qty_units).toBe(736);
    expect(r.unit_cost_at_sale).toBe(null);
    expect(r.cogs_amount).toBe(null);
    expect(r.margin_amount).toBe(null);
    expect(r.margin_pct).toBe(null);
  });
});

describe("deriveSalesGrainFields", () => {
  // The screenshot scenario: RYG1768PPK, pack_size=60, master $240/pack ($4/unit).
  // LY row: 20 PACKS at $240/pack = $4,800.
  it("normalises pack-grain Xoro line + persists cogs (the LY case)", () => {
    const r = deriveSalesGrainFields({
      rawItemNumber: "RYG1768PPK-Black",
      qty: 20,
      netAmount: 4800,
      master: { pack_size: 60, unit_cost: 240 },
    });
    expect(r.qty_grain).toBe("pack");
    expect(r.qty_units).toBe(1200);
    expect(r.unit_cost_at_sale).toBeCloseTo(4, 5);
    expect(r.cogs_amount).toBeCloseTo(4800, 2);
    expect(r.margin_amount).toBeCloseTo(0, 2);
    expect(r.margin_pct).toBeCloseTo(0, 4);
  });

  it("preserves unit-grain Xoro line + computes cogs (the TY case)", () => {
    const r = deriveSalesGrainFields({
      rawItemNumber: "RYG1768-Black-XL",
      qty: 1200,
      netAmount: 4800,
      master: { pack_size: 60, unit_cost: 4 },
    });
    expect(r.qty_grain).toBe("unit");
    expect(r.qty_units).toBe(1200);
    expect(r.unit_cost_at_sale).toBe(4);
    expect(r.cogs_amount).toBe(4800);
    expect(r.margin_amount).toBeCloseTo(0, 2);
  });

  // The anomaly from the spot-check: variant sku tagged pack_size=24
  // but actually unit-grain with master cost stored at per-unit grain.
  // Smart cost rule avoids the spurious 96.87% margin.
  it("handles the unit-grain anomaly: variant SKU, pack_size>1 mis-tag, per-unit master cost", () => {
    const r = deriveSalesGrainFields({
      rawItemNumber: "RYB059430-ALGAE-DARKWASH",
      qty: 4078,
      netAmount: 35682.50,
      master: { pack_size: 24, unit_cost: 6.58 },
    });
    expect(r.qty_grain).toBe("unit");
    expect(r.qty_units).toBe(4078);
    expect(r.unit_cost_at_sale).toBe(6.58);
    expect(r.cogs_amount).toBeCloseTo(4078 * 6.58, 2);
    expect(r.margin_amount).toBeCloseTo(35682.50 - 4078 * 6.58, 2);
    expect(r.margin_pct).toBeGreaterThan(0.20);
    expect(r.margin_pct).toBeLessThan(0.30);
  });

  it("handles the converse anomaly: unit-grain sale with per-pack master cost (sanity check divides)", () => {
    const r = deriveSalesGrainFields({
      rawItemNumber: "RYB059430-LOOSE-XL",
      qty: 100,
      netAmount: 800,
      master: { pack_size: 24, unit_cost: 158 },
    });
    expect(r.qty_grain).toBe("unit");
    expect(r.unit_cost_at_sale).toBeCloseTo(158 / 24, 5);
    expect(r.cogs_amount).toBeCloseTo(100 * (158 / 24), 2);
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
    expect(r.cogs_amount).toBe(180);
    expect(r.margin_amount).toBe(180);
    expect(r.margin_pct).toBeCloseTo(0.5, 4);
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
    expect(r.cogs_amount).toBe(null);
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
    expect(r.cogs_amount).toBe(null);
    expect(r.margin_amount).toBe(null);
    expect(r.margin_pct).toBe(null);
  });
});
