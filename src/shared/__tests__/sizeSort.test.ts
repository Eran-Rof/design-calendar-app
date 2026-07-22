import { describe, it, expect } from "vitest";
import { canonSizeLabel, compareSizes, mergeSizesIntoScaleOrder } from "../sizeSort";

describe("canonSizeLabel — backend-canon display labels (the P001044 phantom-columns bug)", () => {
  it("maps legacy SKU spellings onto the scale labels", () => {
    expect(["SML", "MED", "LRG", "XLG", "XXL"].map(canonSizeLabel))
      .toEqual(["SMALL", "MEDIUM", "LARGE", "XLARGE", "2XLARGE"]);
    expect(["S", "M", "L", "XL"].map(canonSizeLabel))
      .toEqual(["SMALL", "MEDIUM", "LARGE", "XLARGE"]);
  });
  it("passes non-letter tokens through unchanged", () => {
    expect(canonSizeLabel("32")).toBe("32");
    expect(canonSizeLabel("PPK24")).toBe("PPK24");
    expect(canonSizeLabel("XS(5-6)")).toBe("XS(5-6)"); // age-range: whole-token only
    expect(canonSizeLabel("OS")).toBe("OS");
  });
});

describe("compareSizes — canonical size ordering", () => {
  it("letter sizes order XS→…→XL", () => {
    expect(["XL", "S", "M", "XS", "L"].sort(compareSizes)).toEqual(["XS", "S", "M", "L", "XL"]);
  });
  it("kids AGE-RANGE forms order by size, not alpha (the P000930 bug)", () => {
    // Alpha sort gave L,M,S,XL,XS — wrong. Canonical gives XS,S,M,L,XL.
    expect(["L(14-16)", "M(10-12)", "S(7-8)", "XL(18-20)", "XS(5-6)"].sort(compareSizes))
      .toEqual(["XS(5-6)", "S(7-8)", "M(10-12)", "L(14-16)", "XL(18-20)"]);
  });
  it("numeric waists order numerically", () => {
    expect(["32", "28", "30", "34"].sort(compareSizes)).toEqual(["28", "30", "32", "34"]);
  });
  it("numeric before letters before PPK before alpha", () => {
    expect(["PPK24", "30", "M", "ZZZ"].sort(compareSizes)).toEqual(["30", "M", "PPK24", "ZZZ"]);
  });
  it("abbreviations (SML/MED/LRG/XLG) normalize", () => {
    expect(["XLG", "SML", "LRG", "MED"].sort(compareSizes)).toEqual(["SML", "MED", "LRG", "XLG"]);
  });
});

describe("mergeSizesIntoScaleOrder — off-scale sizes slotted INTO sequence", () => {
  it("keeps the scale order when the data adds nothing new", () => {
    expect(mergeSizesIntoScaleOrder(["30", "32", "36"], ["30", "32"])).toEqual(["30", "32", "36"]);
  });
  it("interleaves a numeric waist the scale is missing (34 between 32 and 36)", () => {
    // The headline bug: a 34 the scale skipped used to render AFTER 36.
    expect(mergeSizesIntoScaleOrder(["30", "32", "36"], ["34"])).toEqual(["30", "32", "34", "36"]);
  });
  it("interleaves several missing numeric waists at once", () => {
    expect(mergeSizesIntoScaleOrder(["30", "34", "38"], ["32", "36", "40"]))
      .toEqual(["30", "32", "34", "36", "38", "40"]);
  });
  it("interleaves a missing LETTER size (LARGE between MEDIUM and XLARGE)", () => {
    expect(mergeSizesIntoScaleOrder(["SMALL", "MEDIUM", "XLARGE"], ["LARGE"]))
      .toEqual(["SMALL", "MEDIUM", "LARGE", "XLARGE"]);
  });
  it("drops an extra already covered by the scale (SML == SMALL, S == SMALL)", () => {
    expect(mergeSizesIntoScaleOrder(["SMALL", "MEDIUM", "LARGE"], ["SML", "S", "MED"]))
      .toEqual(["SMALL", "MEDIUM", "LARGE"]);
  });
  it("kids age-range: an XL(18-20) the Girls-Kid scale lacks lands last, in size order", () => {
    expect(mergeSizesIntoScaleOrder(["XS(5-6)", "S(7-8)", "M(10-12)", "L(14-16)"], ["XL(18-20)"]))
      .toEqual(["XS(5-6)", "S(7-8)", "M(10-12)", "L(14-16)", "XL(18-20)"]);
  });
  it("a stray letter size on a NUMERIC waist scale sorts to the end (cross-family)", () => {
    // A denim-waist style carrying a stray MED SKU: numeric tier precedes letters,
    // so MED lands after every waist — surfacing the anomaly without scrambling.
    expect(mergeSizesIntoScaleOrder(["28", "30", "32"], ["MED"])).toEqual(["28", "30", "32", "MED"]);
  });
  it("PPK pack tokens sort last, after real sizes", () => {
    expect(mergeSizesIntoScaleOrder(["SMALL", "MEDIUM"], ["LARGE", "PPK24"]))
      .toEqual(["SMALL", "MEDIUM", "LARGE", "PPK24"]);
  });
  it("never re-sorts the scale's own labels; an extra lands before the first label it precedes", () => {
    // A scale entered deliberately out of strict order keeps its order exactly
    // (30 stays after 36); the extra is placed at the first label it sorts before.
    expect(mergeSizesIntoScaleOrder(["36", "30", "32"], ["34"])).toEqual(["34", "36", "30", "32"]);
  });
  it("empty / missing scale degrades to a plain canonical sort", () => {
    expect(mergeSizesIntoScaleOrder([], ["32", "28", "30"])).toEqual(["28", "30", "32"]);
    expect(mergeSizesIntoScaleOrder(null, ["M", "S", "L"])).toEqual(["S", "M", "L"]);
  });
  it("dedupes extras by canonical size, keeping the first-seen spelling (order-only helper)", () => {
    // The helper positions labels; it does NOT re-spell them (callers pass
    // canonical labels). L/LRG/LARGE collapse to one column — the first seen ("L").
    expect(mergeSizesIntoScaleOrder(["SMALL"], ["L", "LRG", "LARGE"])).toEqual(["SMALL", "L"]);
  });
  it("ignores null / blank tokens on both sides", () => {
    expect(mergeSizesIntoScaleOrder(["30", "", "32"], [null as unknown as string, "", "34"]))
      .toEqual(["30", "32", "34"]);
  });
});
