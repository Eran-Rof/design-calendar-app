import { describe, it, expect } from "vitest";
import {
  distributeByPack,
  isNestedPack,
  packForInseam,
  hasUsablePack,
  type NestedSizePack,
} from "../sizeScale";

describe("isNestedPack", () => {
  it("treats a flat size→qty pack as NOT nested", () => {
    expect(isNestedPack({ S: 2, M: 3, L: 3 })).toBe(false);
  });
  it("treats a per-inseam pack (values are objects) as nested", () => {
    expect(isNestedPack({ "30": { "30": 2, "32": 3 }, "32": { "34": 1 } })).toBe(true);
  });
  it("is false for empty / nullish", () => {
    expect(isNestedPack({})).toBe(false);
    expect(isNestedPack(null)).toBe(false);
    expect(isNestedPack(undefined)).toBe(false);
  });
});

describe("packForInseam", () => {
  const flat = { "30": 2, "32": 3, "34": 2 };
  const nested: NestedSizePack = {
    "30": { "28": 3, "30": 3, "32": 2 },
    "32": { "30": 1, "32": 4, "34": 2 },
  };

  it("returns a flat pack as-is for any inseam (applies to all)", () => {
    expect(packForInseam(flat, "30")).toEqual(flat);
    expect(packForInseam(flat, null)).toEqual(flat);
    expect(packForInseam(flat, undefined)).toEqual(flat);
  });

  it("returns the matching inseam column from a nested pack", () => {
    expect(packForInseam(nested, "30")).toEqual({ "28": 3, "30": 3, "32": 2 });
    expect(packForInseam(nested, "32")).toEqual({ "30": 1, "32": 4, "34": 2 });
  });

  it("falls back to the first column when the inseam is missing or unspecified", () => {
    expect(packForInseam(nested, "99")).toEqual({ "28": 3, "30": 3, "32": 2 });
    expect(packForInseam(nested, null)).toEqual({ "28": 3, "30": 3, "32": 2 });
  });

  it("returns {} for nullish input", () => {
    expect(packForInseam(null, "30")).toEqual({});
    expect(packForInseam(undefined, null)).toEqual({});
  });

  it("each inseam distributes a total by its OWN ratio (carton-rounded)", () => {
    const sizes = ["28", "30", "32", "34"];
    const d30 = distributeByPack(240, sizes, packForInseam(nested, "30"));
    const d32 = distributeByPack(240, sizes, packForInseam(nested, "32"));
    // The two inseams skew to different sizes — distributions must differ.
    expect(d30).not.toEqual(d32);
    // 30" has no 34 ratio → 0; 32" has no 28 ratio → 0.
    expect(d30["34"]).toBe(0);
    expect(d32["28"]).toBe(0);
    // Every cell is a full carton of 24.
    for (const v of [...Object.values(d30), ...Object.values(d32)]) expect(v % 24).toBe(0);
  });

  it("usability check works through the resolved per-inseam pack", () => {
    const sizes = ["28", "30", "32", "34"];
    expect(hasUsablePack(sizes, packForInseam(nested, "30"))).toBe(true);
    expect(hasUsablePack(sizes, packForInseam({}, "30"))).toBe(false);
  });
});
