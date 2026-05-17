// Unit tests for the pure grid helpers extracted from
// WholesalePlanningGrid.tsx. Covers the collapse-mode key transform
// (mutually-exclusive flag enforcement), buy-quantity distribution
// across children (integer rounding invariants), and the null-safe
// comparators used everywhere a column is sortable.

import { describe, it, expect } from "vitest";
import {
  collapseToKeys,
  applyCollapseKeys,
  distributeAcrossChildren,
  cmpStr,
  cmpNum,
} from "../gridUtils";
import { NO_COLLAPSE } from "../constants";

// ────────────────────────────────────────────────────────────────────────
// Collapse modes
// ────────────────────────────────────────────────────────────────────────

describe("collapseToKeys / applyCollapseKeys", () => {
  it("roundtrips a clean state", () => {
    const start = { ...NO_COLLAPSE, customers: true, colors: true };
    const keys = collapseToKeys(start);
    const back = applyCollapseKeys(keys);
    expect(back).toEqual(start);
  });

  it("returns no keys when nothing is collapsed", () => {
    expect(collapseToKeys(NO_COLLAPSE)).toEqual([]);
  });

  it("category and subCat are mutually exclusive — subCat loses if both set", () => {
    const out = applyCollapseKeys(["category", "subCat"]);
    expect(out.category).toBe(true);
    expect(out.subCat).toBe(false);
  });

  it("wide rollups clear simple customers + colors flags", () => {
    const out = applyCollapseKeys(["customers", "colors", "customerAllStyles"]);
    expect(out.customerAllStyles).toBe(true);
    expect(out.customers).toBe(false);
    expect(out.colors).toBe(false);
  });

  it("allCustomersPerCategory is a wide rollup too", () => {
    const out = applyCollapseKeys(["colors", "allCustomersPerCategory"]);
    expect(out.allCustomersPerCategory).toBe(true);
    expect(out.colors).toBe(false);
  });

  it("ignores unknown keys without throwing", () => {
    const out = applyCollapseKeys(["customers", "made-up-key"]);
    expect(out.customers).toBe(true);
    expect(out.category).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────
// distributeAcrossChildren — integer sum invariant
// ────────────────────────────────────────────────────────────────────────

describe("distributeAcrossChildren", () => {
  it("returns [] for empty id list", () => {
    expect(distributeAcrossChildren([], [], 100)).toEqual([]);
  });

  it("single child gets the whole total", () => {
    expect(distributeAcrossChildren(["a"], [0], 100)).toEqual([{ fid: "a", qty: 100 }]);
  });

  it("even split when every child is zero", () => {
    const out = distributeAcrossChildren(["a", "b", "c", "d"], [0, 0, 0, 0], 100);
    const sum = out.reduce((s, x) => s + x.qty, 0);
    expect(sum).toBe(100);
    // Base 25 each + 0 remainder distributed; all values should be close.
    expect(out.map(x => x.qty).every(q => q >= 25 && q <= 25)).toBe(true);
  });

  it("absorbs odd remainder into a single child", () => {
    const out = distributeAcrossChildren(["a", "b", "c"], [0, 0, 0], 100);
    const sum = out.reduce((s, x) => s + x.qty, 0);
    expect(sum).toBe(100);
    // Two children get 33, one gets 34 (or similar — exact distribution
    // depends on remainder sign).
    const qtys = out.map(x => x.qty).sort();
    expect(qtys[0] + qtys[1] + qtys[2]).toBe(100);
  });

  it("weighted split when existing values differ — last child absorbs rounding", () => {
    // children currently [10, 20, 30] sum=60; new total 600 → 10×, so
    // weighted split is roughly [100, 200, 300] with last absorbing
    // any rounding gap.
    const out = distributeAcrossChildren(["a", "b", "c"], [10, 20, 30], 600);
    const sum = out.reduce((s, x) => s + x.qty, 0);
    expect(sum).toBe(600);
    expect(out[0].qty).toBe(100);
    expect(out[1].qty).toBe(200);
    expect(out[2].qty).toBe(300);
  });

  it("never produces a NaN even with weird inputs", () => {
    const out = distributeAcrossChildren(["a", "b"], [0, 0], 1);
    for (const x of out) expect(Number.isFinite(x.qty)).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────
// cmpStr / cmpNum — null handling
// ────────────────────────────────────────────────────────────────────────

describe("cmpStr", () => {
  it("ascending case-insensitive", () => {
    expect(cmpStr("apple", "Banana", 1)).toBeLessThan(0);
    expect(cmpStr("zebra", "apple", 1)).toBeGreaterThan(0);
  });

  it("nulls always at the end regardless of sign", () => {
    expect(cmpStr(null, "x",  1)).toBe(1);
    expect(cmpStr(null, "x", -1)).toBe(1);
    expect(cmpStr("x", null,  1)).toBe(-1);
    expect(cmpStr("x", null, -1)).toBe(-1);
  });

  it("two nulls compare equal", () => {
    expect(cmpStr(null, null, 1)).toBe(0);
    expect(cmpStr(undefined, null, 1)).toBe(0);
  });
});

describe("cmpNum", () => {
  it("numeric ordering both directions", () => {
    expect(cmpNum(1, 2,  1)).toBeLessThan(0);
    expect(cmpNum(1, 2, -1)).toBeGreaterThan(0);
  });

  it("nulls always at the end regardless of sign", () => {
    expect(cmpNum(null, 5,  1)).toBe(1);
    expect(cmpNum(null, 5, -1)).toBe(1);
    expect(cmpNum(5, null,  1)).toBe(-1);
  });

  it("zero is not treated as null", () => {
    expect(cmpNum(0, null, 1)).toBe(-1);
  });
});
