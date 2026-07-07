import { describe, it, expect } from "vitest";
import { compareSizes } from "../sizeSort";

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
