import { describe, it, expect } from "vitest";
import { distribute, addBySize } from "../sizeMatrixDistribute";

const sum = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0);

describe("distribute — totals always reconcile to the main report", () => {
  const sizes = ["28", "30", "32", "34", "36", "38", "40", "42"];

  it("splits proportional to the size shape and sums EXACTLY to total", () => {
    const shape = { "30": 564, "32": 1112, "34": 1107, "36": 564, "38": 568 };
    const out = distribute(3493, shape, sizes);
    expect(sum(out)).toBe(3493);                 // exact tie-out
    expect(out["32"]).toBeGreaterThan(out["30"]); // 32 is the biggest size
    expect(out["28"]).toBeUndefined();            // 0 weight → no cell
  });

  it("returns empty for a zero/negative total (fully-committed color shows blank)", () => {
    expect(distribute(0, { "30": 100 }, sizes)).toEqual({});
    expect(distribute(-5, { "30": 100 }, sizes)).toEqual({});
  });

  it("even-splits when there is no size shape but a positive total (new PO color)", () => {
    const out = distribute(41, {}, ["28", "30", "32", "34"]);
    expect(sum(out)).toBe(41);                    // still exact
    // 41 / 4 = 10 r1 → 11,10,10,10
    expect(Object.values(out).sort((a, b) => b - a)).toEqual([11, 10, 10, 10]);
  });

  it("handles a tiny total smaller than the size count", () => {
    const out = distribute(2, { "30": 1, "32": 1, "34": 1 }, ["30", "32", "34"]);
    expect(sum(out)).toBe(2);
  });

  it("rounds via largest remainder (no systematic bias, exact sum)", () => {
    const shape = { "30": 1, "32": 1, "34": 1 };
    const out = distribute(10, shape, ["30", "32", "34"]);
    expect(sum(out)).toBe(10);                    // 3.33 each → 4,3,3
    expect(Object.values(out).sort((a, b) => b - a)).toEqual([4, 3, 3]);
  });
});

describe("addBySize — folds period cells into the snapshot", () => {
  it("sums two maps key-wise", () => {
    expect(addBySize({ "30": 100, "32": 50 }, { "30": 20, "34": 5 })).toEqual({ "30": 120, "32": 50, "34": 5 });
  });
});
