// Tests for the grain-aware open-PO cost fallback (BUG: RYB0412PPK blank
// Unit Cost). See ../utils/poCostFallback.ts.

import { describe, it, expect } from "vitest";
import {
  baseColorKey,
  ppkStyleKeyOf,
  resolvePackSize,
  buildPoEachCostByBaseColor,
  poFallbackCostForRow,
  resolvePlanningRowCost,
  type PoCostRow,
} from "../utils/poCostFallback";

describe("baseColorKey", () => {
  it("strips a glued PPK token from the style, keeping the color", () => {
    expect(baseColorKey("RYB0412PPK-BLACK")).toBe("RYB0412-BLACK");
  });
  it("strips a bare glued PPK style (no color)", () => {
    expect(baseColorKey("RYB0412PPK")).toBe("RYB0412");
  });
  it("strips a -PPK<n> size suffix form", () => {
    expect(baseColorKey("RYB0412-BLACK-PPK24")).toBe("RYB0412-BLACK");
  });
  it("strips a trailing numeric/letter size", () => {
    expect(baseColorKey("RYB0412-BLACK-M")).toBe("RYB0412-BLACK");
  });
  it("leaves an each-grain style+color unchanged (matches the PO base)", () => {
    expect(baseColorKey("RYB0412-BLACK")).toBe("RYB0412-BLACK");
    expect(baseColorKey("ryb0412ppk-black")).toBe("RYB0412-BLACK");
  });
  it("normalizes surrounding/internal whitespace and case", () => {
    expect(baseColorKey("  ryb0412ppk-black  ")).toBe("RYB0412-BLACK");
  });
});

describe("ppkStyleKeyOf", () => {
  it("returns the lowercased style portion before the first dash", () => {
    expect(ppkStyleKeyOf("RYB0412PPK-BLACK")).toBe("ryb0412ppk");
    expect(ppkStyleKeyOf("RYB0412PPK")).toBe("ryb0412ppk");
    expect(ppkStyleKeyOf("RYB0412-BLACK")).toBe("ryb0412");
  });
});

describe("resolvePackSize", () => {
  const matrix = new Map<string, number>([["ryb0412ppk", 24]]);
  it("prefers the prepack matrix keyed by ppk style code", () => {
    expect(resolvePackSize("RYB0412PPK-BLACK", 1, matrix)).toBe(24);
  });
  it("falls back to the item-master pack_size when no matrix row", () => {
    expect(resolvePackSize("ABC-BLUE", 6, matrix)).toBe(6);
  });
  it("returns 1 when neither is > 1", () => {
    expect(resolvePackSize("ABC-BLUE", 1, matrix)).toBe(1);
    expect(resolvePackSize("ABC-BLUE", null, null)).toBe(1);
  });
});

describe("buildPoEachCostByBaseColor + poFallbackCostForRow", () => {
  // (a) each-grain row + PPK pack PO → pack ÷ packSize.
  it("(a) each-grain row derives per-each from a PPK pack PO", () => {
    const pos: PoCostRow[] = [
      { sku_code: "RYB0412PPK-BLACK", unit_cost: 240, qty_open: 10, pack_size: 24 },
    ];
    const map = buildPoEachCostByBaseColor(pos);
    // per-each = 240 / 24 = 10
    expect(map.get("RYB0412-BLACK")).toBeCloseTo(10, 6);
    // each-grain row (pack size 1) shows the per-each price.
    expect(poFallbackCostForRow("RYB0412-BLACK", 1, map)).toBeCloseTo(10, 6);
  });

  // (b) pack-grain row + PPK PO → pack price.
  it("(b) pack-grain row re-grains back up to the pack price", () => {
    const pos: PoCostRow[] = [
      { sku_code: "RYB0412PPK-BLACK", unit_cost: 240, qty_open: 10, pack_size: 24 },
    ];
    const map = buildPoEachCostByBaseColor(pos);
    // A pack-grain row (pack size 24) shows the full pack price: 10 * 24 = 240.
    expect(poFallbackCostForRow("RYB0412PPK-BLACK", 24, map)).toBeCloseTo(240, 6);
  });

  // (c) plain each PO (pack size 1 on both sides → poUnitCost as-is).
  it("(c) plain each PO passes the unit cost straight through", () => {
    const pos: PoCostRow[] = [
      { sku_code: "ABC-BLUE", unit_cost: 7.5, qty_open: 100, pack_size: 1 },
    ];
    const map = buildPoEachCostByBaseColor(pos);
    expect(map.get("ABC-BLUE")).toBeCloseTo(7.5, 6);
    expect(poFallbackCostForRow("ABC-BLUE", 1, map)).toBeCloseTo(7.5, 6);
  });

  it("weights per-each cost by qty_open across multiple POs", () => {
    const pos: PoCostRow[] = [
      { sku_code: "RYB0412PPK-BLACK", unit_cost: 240, qty_open: 10, pack_size: 24 }, // 10/each, w=10
      { sku_code: "RYB0412-BLACK", unit_cost: 12, qty_open: 30, pack_size: 1 },      // 12/each, w=30
    ];
    const map = buildPoEachCostByBaseColor(pos);
    // (10*10 + 12*30) / (10+30) = (100 + 360)/40 = 11.5
    expect(map.get("RYB0412-BLACK")).toBeCloseTo(11.5, 6);
  });

  it("skips POs with non-positive cost or qty", () => {
    const pos: PoCostRow[] = [
      { sku_code: "ABC-BLUE", unit_cost: 0, qty_open: 100, pack_size: 1 },
      { sku_code: "ABC-BLUE", unit_cost: 5, qty_open: 0, pack_size: 1 },
      { sku_code: "ABC-BLUE", unit_cost: null, qty_open: 10, pack_size: 1 },
    ];
    const map = buildPoEachCostByBaseColor(pos);
    expect(map.has("ABC-BLUE")).toBe(false);
  });

  // (e) no PO → null.
  it("(e) returns null when there is no PO for the row's base-color", () => {
    const map = buildPoEachCostByBaseColor([]);
    expect(poFallbackCostForRow("RYB0412-BLACK", 1, map)).toBeNull();
  });
});

describe("resolvePlanningRowCost — precedence", () => {
  // (d) PO ignored when a direct/sibling avg cost exists.
  it("(d) uses the avg cascade cost when present, ignoring the PO fallback", () => {
    expect(resolvePlanningRowCost(6.7, 10)).toBe(6.7);
  });
  it("uses the PO fallback only when the avg cascade is null", () => {
    expect(resolvePlanningRowCost(null, 10)).toBe(10);
  });
  it("returns null when both are empty", () => {
    expect(resolvePlanningRowCost(null, null)).toBeNull();
  });
});
