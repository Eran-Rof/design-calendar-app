import { describe, it, expect } from "vitest";
import { compareSizes, sizeSortKey } from "../styleMatrix.js";

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
