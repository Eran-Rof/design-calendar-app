// Tests for the grain-aware open-PO cost fallback (BUG: RYB0412PPK blank
// Unit Cost). See ../utils/poCostFallback.ts.

import { describe, it, expect } from "vitest";
import {
  baseColorKey,
  styleKey,
  ppkStyleKeyOf,
  resolvePackSize,
  buildPoEachCostByBaseColor,
  buildPoEachCostByStyle,
  cascadePlanningCostForItem,
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

describe("styleKey", () => {
  it("strips the color segment, keeping the base style", () => {
    expect(styleKey("RYB0412-BLACK")).toBe("RYB0412");
    expect(styleKey("RYB0412-NAVY")).toBe("RYB0412");
  });
  it("strips a glued PPK token AND the color (PPK glued form)", () => {
    expect(styleKey("RYB0412PPK-BLACK")).toBe("RYB0412");
  });
  it("strips a bare glued PPK style with no color", () => {
    expect(styleKey("RYB0412PPK")).toBe("RYB0412");
    expect(styleKey("RYB0412")).toBe("RYB0412");
  });
  it("strips a -PPK<n> size suffix then the color", () => {
    expect(styleKey("RYB0412-BLACK-PPK24")).toBe("RYB0412");
  });
  it("strips a trailing numeric/letter size then the color", () => {
    expect(styleKey("RYB0412-BLACK-M")).toBe("RYB0412");
  });
  it("normalizes surrounding/internal whitespace and case", () => {
    expect(styleKey("  ryb0412ppk-black  ")).toBe("RYB0412");
  });
  it("returns empty string for empty input", () => {
    expect(styleKey("")).toBe("");
    expect(styleKey(null)).toBe("");
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

describe("buildPoEachCostByStyle", () => {
  it("weights per-each cost by qty_open ACROSS colors of the style", () => {
    const pos: PoCostRow[] = [
      { sku_code: "RYB0412PPK-BLACK", unit_cost: 240, qty_open: 10, pack_size: 24 }, // 10/each, w=10
      { sku_code: "RYB0412-NAVY", unit_cost: 12, qty_open: 30, pack_size: 1 },        // 12/each, w=30
    ];
    const map = buildPoEachCostByStyle(pos);
    // both colors collapse into the single style bucket RYB0412:
    // (10*10 + 12*30) / (10+30) = (100 + 360)/40 = 11.5
    expect(map.get("RYB0412")).toBeCloseTo(11.5, 6);
    expect(map.has("RYB0412-BLACK")).toBe(false); // keyed by style, not base-color
  });

  it("skips POs with non-positive cost or qty", () => {
    const pos: PoCostRow[] = [
      { sku_code: "ABC-BLUE", unit_cost: 0, qty_open: 100, pack_size: 1 },
      { sku_code: "ABC-RED", unit_cost: 5, qty_open: 0, pack_size: 1 },
      { sku_code: "ABC-GREEN", unit_cost: null, qty_open: 10, pack_size: 1 },
    ];
    const map = buildPoEachCostByStyle(pos);
    expect(map.has("ABC")).toBe(false);
  });
});

describe("poFallbackCostForRow — base-color then style tiering", () => {
  // (a) the row's own color has a PO → uses the color-specific cost, NOT the
  //     style-wide average, even when a style map is supplied.
  it("(a) prefers the exact base-color PO over the style tier", () => {
    const pos: PoCostRow[] = [
      { sku_code: "RYB0412-BLACK", unit_cost: 10, qty_open: 5, pack_size: 1 },  // BLACK color PO
      { sku_code: "RYB0412-NAVY", unit_cost: 20, qty_open: 5, pack_size: 1 },   // NAVY color PO
    ];
    const byColor = buildPoEachCostByBaseColor(pos);
    const byStyle = buildPoEachCostByStyle(pos); // style avg = (10+20)/2 = 15
    // BLACK row resolves to its own PO (10), not the style average (15).
    expect(poFallbackCostForRow("RYB0412-BLACK", 1, byColor, byStyle)).toBeCloseTo(10, 6);
  });

  // (b) the row's color has NO PO but a sibling color does → uses the style tier.
  it("(b) falls back to the style tier when the color has no PO of its own", () => {
    const pos: PoCostRow[] = [
      { sku_code: "RYB0412-BLACK", unit_cost: 10, qty_open: 5, pack_size: 1 },
    ];
    const byColor = buildPoEachCostByBaseColor(pos);
    const byStyle = buildPoEachCostByStyle(pos);
    // NAVY has no PO of its own; base-color tier misses, style tier (10) hits.
    expect(poFallbackCostForRow("RYB0412-NAVY", 1, byColor, byStyle)).toBeCloseTo(10, 6);
  });

  // (c) re-graining on the STYLE tier respects the row's grain.
  it("(c) re-grains the style-tier per-each cost by the row's pack size", () => {
    const pos: PoCostRow[] = [
      { sku_code: "RYB0412PPK-BLACK", unit_cost: 240, qty_open: 10, pack_size: 24 }, // 10/each
    ];
    const byColor = buildPoEachCostByBaseColor(pos);
    const byStyle = buildPoEachCostByStyle(pos); // style per-each = 10
    // NAVY (no color PO): each-grain row shows per-each 10; pack-grain shows 240.
    expect(poFallbackCostForRow("RYB0412-NAVY", 1, byColor, byStyle)).toBeCloseTo(10, 6);
    expect(poFallbackCostForRow("RYB0412PPK-NAVY", 24, byColor, byStyle)).toBeCloseTo(240, 6);
  });

  // (d) neither tier has a cost → null.
  it("(d) returns null when neither base-color nor style has a PO", () => {
    const byColor = buildPoEachCostByBaseColor([]);
    const byStyle = buildPoEachCostByStyle([]);
    expect(poFallbackCostForRow("RYB0412-NAVY", 1, byColor, byStyle)).toBeNull();
  });

  // 3-arg (base-color-only) call sites keep working with no style tier.
  it("stays base-color-only when no style map is passed (existing callers)", () => {
    const pos: PoCostRow[] = [
      { sku_code: "RYB0412-BLACK", unit_cost: 10, qty_open: 5, pack_size: 1 },
    ];
    const byColor = buildPoEachCostByBaseColor(pos);
    // NAVY has no color PO and no style map → null (no sibling inheritance).
    expect(poFallbackCostForRow("RYB0412-NAVY", 1, byColor)).toBeNull();
    expect(poFallbackCostForRow("RYB0412-BLACK", 1, byColor)).toBeCloseTo(10, 6);
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


// ── cascadePlanningCostForItem — the ONE cascade both row families use ──
// Models the RYB0185PPK bug: a planner-added TBD stock-buy row on a PPK
// style whose Charcoal colorway has NO direct avg cost must still resolve
// via (a) a sibling color avg, else (b) its own open-PO line, exactly like
// the equivalent forecast row would.
describe("cascadePlanningCostForItem", () => {
  const packMap = new Map<string, number>([["ryb0185ppk", 24]]);
  const emptyMaps = {
    avgCostMap: new Map<string, number>(),
    siblingsBySku: new Map<string, string[]>(),
    openPoCostsBySku: new Map<string, number[]>(),
    poEachCostByBaseColor: new Map<string, number>(),
    poEachCostByStyle: new Map<string, number>(),
    prepackUnitsPerPack: packMap,
  };

  it("null item / missing sku_code resolves null", () => {
    expect(cascadePlanningCostForItem(null, emptyMaps)).toBeNull();
    expect(cascadePlanningCostForItem({ sku_code: null, pack_size: 1 }, emptyMaps)).toBeNull();
  });

  it("direct avg wins", () => {
    const maps = { ...emptyMaps, avgCostMap: new Map([["RYB0185PPK-CHARCOAL", 121.2]]) };
    expect(cascadePlanningCostForItem({ sku_code: "RYB0185PPK-CHARCOAL", pack_size: 1 }, maps)).toBeCloseTo(121.2, 6);
  });

  it("sibling color avg fills when the row's own sku has no avg (RYB0185PPK-CHARCOAL)", () => {
    const maps = {
      ...emptyMaps,
      avgCostMap: new Map([["RYB0185PPK-TONALBLACKCAMO", 121.2]]),
      siblingsBySku: new Map([
        ["RYB0185PPK-CHARCOAL", ["RYB0185PPK-CHARCOAL", "RYB0185PPK-TONALBLACKCAMO"]],
      ]),
    };
    expect(cascadePlanningCostForItem({ sku_code: "RYB0185PPK-CHARCOAL", pack_size: 1 }, maps)).toBeCloseTo(121.2, 6);
  });

  it("open-PO grain-aware fallback fires when the whole avg cascade is empty", () => {
    // PO on the pack sku at $117.36/pack; item-master pack_size is WRONG (1)
    // but the active prepack matrix (24) wins via resolvePackSize, so the
    // pack-grain row re-grains to the full pack price.
    const pos: PoCostRow[] = [
      { sku_code: "RYB0185PPK-CHARCOAL", unit_cost: 117.36, qty_open: 163, pack_size: 24 },
    ];
    const maps = {
      ...emptyMaps,
      poEachCostByBaseColor: buildPoEachCostByBaseColor(pos),
      poEachCostByStyle: buildPoEachCostByStyle(pos),
    };
    expect(cascadePlanningCostForItem({ sku_code: "RYB0185PPK-CHARCOAL", pack_size: 1 }, maps)).toBeCloseTo(117.36, 6);
  });

  it("avg cascade beats the PO fallback (precedence preserved)", () => {
    const pos: PoCostRow[] = [
      { sku_code: "RYB0185PPK-CHARCOAL", unit_cost: 117.36, qty_open: 163, pack_size: 24 },
    ];
    const maps = {
      ...emptyMaps,
      avgCostMap: new Map([["RYB0185PPK-TONALBLACKCAMO", 121.2]]),
      siblingsBySku: new Map([
        ["RYB0185PPK-CHARCOAL", ["RYB0185PPK-CHARCOAL", "RYB0185PPK-TONALBLACKCAMO"]],
      ]),
      poEachCostByBaseColor: buildPoEachCostByBaseColor(pos),
      poEachCostByStyle: buildPoEachCostByStyle(pos),
    };
    expect(cascadePlanningCostForItem({ sku_code: "RYB0185PPK-CHARCOAL", pack_size: 1 }, maps)).toBeCloseTo(121.2, 6);
  });

  it("each-grain sibling row of a PPK style gets the per-each PO price", () => {
    const pos: PoCostRow[] = [
      { sku_code: "RYB0185PPK-CHARCOAL", unit_cost: 117.36, qty_open: 163, pack_size: 24 },
    ];
    const maps = {
      ...emptyMaps,
      poEachCostByBaseColor: buildPoEachCostByBaseColor(pos),
      poEachCostByStyle: buildPoEachCostByStyle(pos),
    };
    // Base garment row (RYB0185-CHARCOAL, pack 1, style not in the matrix)
    // reads the per-each price: 117.36 / 24 = 4.89.
    expect(cascadePlanningCostForItem({ sku_code: "RYB0185-CHARCOAL", pack_size: 1 }, maps)).toBeCloseTo(4.89, 6);
  });
});
