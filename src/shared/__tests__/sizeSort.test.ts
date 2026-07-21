import { describe, it, expect } from "vitest";
import { canonSizeLabel, compareSizes, sizeDisplayLabel } from "../sizeSort";

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

describe("sizeDisplayLabel — house DISPLAY label (never surface a canonical token)", () => {
  it("renders every canonical letter tier as its house form (XL/XLG/XLARGE → XLG)", () => {
    // Both raw spellings of one logical size resolve to the SAME house label, so a
    // grid that keys columns by the canonical token shows ONE header, not two.
    expect(["XL", "XLG", "XLARGE"].map(sizeDisplayLabel)).toEqual(["XLG", "XLG", "XLG"]);
    expect(["S", "SML", "SMALL"].map(sizeDisplayLabel)).toEqual(["SML", "SML", "SML"]);
    expect(["M", "MED", "MEDIUM"].map(sizeDisplayLabel)).toEqual(["MED", "MED", "MED"]);
    expect(["L", "LRG", "LARGE"].map(sizeDisplayLabel)).toEqual(["LRG", "LRG", "LRG"]);
    expect(["XXL", "2XL", "2XLARGE"].map(sizeDisplayLabel)).toEqual(["XXL", "XXL", "XXL"]);
    expect(["XS", "XSM", "XSMALL"].map(sizeDisplayLabel)).toEqual(["XS", "XS", "XS"]);
  });
  it("NEVER emits an internal canonical token (XLARGE / SMALL / X-Large)", () => {
    for (const raw of ["XL", "XLG", "XLARGE", "X-LARGE", "S", "SML", "SMALL", "M", "MED", "L", "LRG"]) {
      expect(["SMALL", "MEDIUM", "LARGE", "XLARGE", "2XLARGE", "XSMALL", "3XLARGE"]).not.toContain(sizeDisplayLabel(raw));
    }
  });
  it("passes numeric waists, PPK tokens and kids age-range forms through UNCHANGED", () => {
    expect(sizeDisplayLabel("28")).toBe("28");
    expect(sizeDisplayLabel("30")).toBe("30");
    expect(sizeDisplayLabel("PPK24")).toBe("PPK24");
    expect(sizeDisplayLabel("XS(5-6)")).toBe("XS(5-6)"); // kids: whole-token pass-through
    expect(sizeDisplayLabel("M(10-12)")).toBe("M(10-12)");
    expect(sizeDisplayLabel("O/S")).toBe("O/S");
    expect(sizeDisplayLabel("S/8")).toBe("S/8");
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
