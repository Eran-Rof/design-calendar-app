import { describe, it, expect } from "vitest";
import { compareSizes, sizeSortKey, mergeSizesIntoScaleOrder } from "../styleMatrix.js";

describe("compareSizes — fallback size-column ordering", () => {
  it("orders kids age-range labels XS→XL (the reported matrix bug)", () => {
    const scrambled = ["XS(5-6)", "L(14-16)", "M(10-12)", "S(7-8)", "XL(18-20)"];
    expect([...scrambled].sort(compareSizes)).toEqual([
      "XS(5-6)", "S(7-8)", "M(10-12)", "L(14-16)", "XL(18-20)",
    ]);
  });

  it("orders canonical + short letter sizes XS→3XL", () => {
    const scrambled = ["XLARGE", "SMALL", "3XLARGE", "MEDIUM", "XSMALL", "LARGE", "2XLARGE"];
    expect([...scrambled].sort(compareSizes)).toEqual([
      "XSMALL", "SMALL", "MEDIUM", "LARGE", "XLARGE", "2XLARGE", "3XLARGE",
    ]);
    expect(["XL", "S", "M", "L", "XS"].sort(compareSizes)).toEqual(["XS", "S", "M", "L", "XL"]);
  });

  it("orders numeric waist sizes by value, after letter sizes", () => {
    expect(["36", "30", "34", "32"].sort(compareSizes)).toEqual(["30", "32", "34", "36"]);
    // letters precede numerics when a style mixes them
    expect(["30", "M", "28"].sort(compareSizes)).toEqual(["M", "28", "30"]);
  });

  it("sorts unknown tokens last, alphabetically", () => {
    const r = ["O/S", "M", "XS(5-6)", "PPK48"].sort(compareSizes);
    expect(r[0]).toBe("XS(5-6)");
    expect(r[1]).toBe("M");
    expect(r.slice(2)).toEqual(["O/S", "PPK48"]);
  });

  it("sizeSortKey tuple shape", () => {
    expect(sizeSortKey("XS(5-6)")).toEqual([0, -1, 5]);
    expect(sizeSortKey("XL(18-20)")).toEqual([0, 3, 18]);
    expect(sizeSortKey("32")).toEqual([1, 32, 0]);
    expect(sizeSortKey("")).toEqual([3, Infinity, ""]);
  });
});

describe("mergeSizesIntoScaleOrder — off-scale sizes slotted INTO the scale sequence", () => {
  it("keeps the scale order when the data adds nothing new", () => {
    expect(mergeSizesIntoScaleOrder(["30", "32", "36"], ["30", "32"])).toEqual(["30", "32", "36"]);
  });
  it("interleaves a numeric waist the scale is missing (34 between 32 and 36)", () => {
    // The headline bug: a 34 the scale skipped used to render AFTER 36 (or vanish).
    expect(mergeSizesIntoScaleOrder(["30", "32", "36"], ["34"])).toEqual(["30", "32", "34", "36"]);
  });
  it("interleaves several missing numeric waists at once", () => {
    expect(mergeSizesIntoScaleOrder(["30", "34", "38"], ["36", "32", "40"]))
      .toEqual(["30", "32", "34", "36", "38", "40"]);
  });
  it("interleaves a missing LETTER size (LARGE between MEDIUM and XLARGE)", () => {
    expect(mergeSizesIntoScaleOrder(["SMALL", "MEDIUM", "XLARGE"], ["LARGE"]))
      .toEqual(["SMALL", "MEDIUM", "LARGE", "XLARGE"]);
  });
  it("drops an extra already covered by the scale (SML/S == SMALL, MED == MEDIUM)", () => {
    expect(mergeSizesIntoScaleOrder(["SMALL", "MEDIUM", "LARGE"], ["SML", "S", "MED"]))
      .toEqual(["SMALL", "MEDIUM", "LARGE"]);
  });
  it("dedupes extras by canonical size, keeping the first-seen spelling (order-only helper)", () => {
    // Positions labels without re-spelling them; L/LRG/LARGE collapse to one
    // column — the first seen ("L"). Real callers pass canonical labels already.
    expect(mergeSizesIntoScaleOrder(["SMALL"], ["L", "LRG", "LARGE"])).toEqual(["SMALL", "L"]);
  });
  it("a stray LETTER size on a numeric waist scale sorts to the FRONT (backend letters-first tier)", () => {
    // Backend compareSizes ranks letters (tier 0) before numerics (tier 1) — the
    // established matrix convention — so a stray MED on a denim-waist style leads.
    expect(mergeSizesIntoScaleOrder(["28", "30", "32"], ["MED"])).toEqual(["MED", "28", "30", "32"]);
  });
  it("PPK / unknown pack tokens sort last (tier 2), after real letter + numeric sizes", () => {
    expect(mergeSizesIntoScaleOrder(["SMALL", "MEDIUM"], ["LARGE", "PPK24"]))
      .toEqual(["SMALL", "MEDIUM", "LARGE", "PPK24"]);
  });
  it("empty / missing scale degrades to a plain canonical sort", () => {
    expect(mergeSizesIntoScaleOrder([], ["36", "28", "30"])).toEqual(["28", "30", "36"]);
    expect(mergeSizesIntoScaleOrder(null, ["M", "S", "L"])).toEqual(["S", "M", "L"]);
  });
  it("ignores null / blank tokens on both sides", () => {
    expect(mergeSizesIntoScaleOrder(["30", "", "32"], [null, "", "34"])).toEqual(["30", "32", "34"]);
  });
});
