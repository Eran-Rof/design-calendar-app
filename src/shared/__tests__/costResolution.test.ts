import { describe, expect, it } from "vitest";
import { resolveCost, buildSiblingMap } from "../costResolution";

describe("resolveCost", () => {
  it("returns direct hit from avgCostMap", () => {
    const r = resolveCost("RYB001-BLACK", {
      avgCostMap: new Map([["RYB001-BLACK", 6.75]]),
    });
    expect(r).toEqual({ cost: 6.75, source: "direct" });
  });

  it("falls through direct when value is zero or negative", () => {
    // Zero / negative avg cost is treated as missing — Xoro emits blank
    // (read as null) for items that haven't moved, but the row is still
    // upserted so brand can be written. The cascade must treat the empty
    // cost the same way regardless of whether it's null or a sentinel 0.
    const r = resolveCost("RYB001-BLACK", {
      avgCostMap: new Map([["RYB001-BLACK", 0]]),
      siblingsBySku: new Map([["RYB001-BLACK", ["RYB001-NAVY"]]]),
    });
    expect(r.source).not.toBe("direct");
  });

  it("uses sibling avg_cost when SKU itself is missing", () => {
    const avgCostMap = new Map<string, number>([
      ["RYB001-NAVY", 6.50],
      ["RYB001-GREY", 6.55],
    ]);
    const siblingsBySku = new Map<string, string[]>([
      ["RYB001-BLACK", ["RYB001-BLACK", "RYB001-NAVY", "RYB001-GREY"]],
    ]);
    const r = resolveCost("RYB001-BLACK", { avgCostMap, siblingsBySku });
    // Picks the first usable sibling in the list (NAVY, $6.50).
    expect(r).toEqual({ cost: 6.50, source: "sibling" });
  });

  it("averages open PO costs as third fallback", () => {
    const r = resolveCost("RYB099-NEW", {
      avgCostMap: new Map(),
      siblingsBySku: new Map(),
      openPoCostsBySku: new Map([["RYB099-NEW", [7.00, 8.00, 9.00]]]),
    });
    expect(r.source).toBe("po");
    expect(r.cost).toBeCloseTo(8.00, 5);
  });

  it("ignores non-positive open PO costs in the average", () => {
    const r = resolveCost("RYB099-NEW", {
      openPoCostsBySku: new Map([["RYB099-NEW", [0, -1, 7.00, 9.00]]]),
    });
    expect(r.cost).toBeCloseTo(8.00, 5);
  });

  it("derives cost from sale price + general margin as last resort", () => {
    const r = resolveCost("RYB077-UNK", {
      salePrice: 10.00,
      generalMarginPct: 30,
    });
    expect(r.source).toBe("margin");
    expect(r.cost).toBeCloseTo(7.00, 5);
  });

  it("does not invoke the margin fallback when sale price is missing", () => {
    const r = resolveCost("RYB077-UNK", { generalMarginPct: 30 });
    expect(r).toEqual({ cost: null, source: "unknown" });
  });

  it("rejects nonsensical margin percentages (>=100)", () => {
    const r = resolveCost("RYB077-UNK", { salePrice: 10, generalMarginPct: 100 });
    expect(r.source).toBe("unknown");
  });

  it("returns unknown when every cascade step fails", () => {
    const r = resolveCost("MYSTERY", {});
    expect(r).toEqual({ cost: null, source: "unknown" });
  });

  it("prefers direct over sibling even when sibling has a value", () => {
    const r = resolveCost("RYB001-BLACK", {
      avgCostMap: new Map([
        ["RYB001-BLACK", 6.75],
        ["RYB001-NAVY", 5.00], // would tempt the sibling step
      ]),
      siblingsBySku: new Map([["RYB001-BLACK", ["RYB001-BLACK", "RYB001-NAVY"]]]),
    });
    expect(r).toEqual({ cost: 6.75, source: "direct" });
  });

  it("guards against empty sku input", () => {
    const r = resolveCost("", { avgCostMap: new Map([["RYB001", 5]]) });
    expect(r).toEqual({ cost: null, source: "unknown" });
  });
});

describe("buildSiblingMap", () => {
  it("groups SKUs sharing a base part and excludes lone-child groups", () => {
    const map = buildSiblingMap([
      { sku: "RYB001-BLACK", basePart: "RYB001" },
      { sku: "RYB001-NAVY", basePart: "RYB001" },
      { sku: "RYB001-GREY", basePart: "RYB001" },
      { sku: "RYB002-RED",  basePart: "RYB002" }, // only child — excluded
    ]);
    expect(map.get("RYB001-BLACK")).toEqual([
      "RYB001-BLACK", "RYB001-NAVY", "RYB001-GREY",
    ]);
    expect(map.has("RYB002-RED")).toBe(false);
  });

  it("ignores records with empty sku or empty basePart", () => {
    const map = buildSiblingMap([
      { sku: "RYB001-BLACK", basePart: "RYB001" },
      { sku: "",             basePart: "RYB001" },
      { sku: "RYB001-NAVY",  basePart: null },
    ]);
    // Only one valid entry remains; the group has < 2 so it's dropped.
    expect(map.size).toBe(0);
  });
});
