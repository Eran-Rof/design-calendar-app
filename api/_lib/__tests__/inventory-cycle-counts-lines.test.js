// Tests for P3-6 cycle-counts lines.js PATCH validator.

import { describe, it, expect } from "vitest";
import { validateLinePatch } from "../../_handlers/internal/inventory-cycle-counts/lines.js";

describe("cycle-count lines validateLinePatch", () => {
  it("rejects missing counted_qty", () => {
    expect(validateLinePatch({}).error).toMatch(/counted_qty/);
  });

  it("accepts a positive number", () => {
    const v = validateLinePatch({ counted_qty: 10 });
    expect(v.error).toBeUndefined();
    expect(v.data.counted_qty).toBe(10);
  });

  it("accepts zero", () => {
    const v = validateLinePatch({ counted_qty: 0 });
    expect(v.error).toBeUndefined();
    expect(v.data.counted_qty).toBe(0);
  });

  it("accepts a fractional number", () => {
    const v = validateLinePatch({ counted_qty: 1.5 });
    expect(v.error).toBeUndefined();
    expect(v.data.counted_qty).toBe(1.5);
  });

  it("rejects negative", () => {
    expect(validateLinePatch({ counted_qty: -1 }).error).toMatch(/non-negative/);
  });

  it("rejects NaN / Infinity", () => {
    expect(validateLinePatch({ counted_qty: NaN }).error).toMatch(/finite/);
    expect(validateLinePatch({ counted_qty: Infinity }).error).toMatch(/finite/);
    expect(validateLinePatch({ counted_qty: -Infinity }).error).toMatch(/finite/);
  });

  it("rejects non-numeric string", () => {
    expect(validateLinePatch({ counted_qty: "abc" }).error).toMatch(/finite/);
  });

  it("coerces numeric string", () => {
    const v = validateLinePatch({ counted_qty: "42" });
    expect(v.error).toBeUndefined();
    expect(v.data.counted_qty).toBe(42);
  });

  it("allows explicit null to clear count", () => {
    const v = validateLinePatch({ counted_qty: null });
    expect(v.error).toBeUndefined();
    expect(v.data.counted_qty).toBeNull();
  });

  it("captures + trims notes alongside counted_qty", () => {
    const v = validateLinePatch({ counted_qty: 5, notes: "  off-by-one  " });
    expect(v.error).toBeUndefined();
    expect(v.data.notes).toBe("off-by-one");
  });

  it("empty notes becomes null", () => {
    const v = validateLinePatch({ counted_qty: 5, notes: "" });
    expect(v.data.notes).toBeNull();
  });

  it("notes whitespace becomes null", () => {
    const v = validateLinePatch({ counted_qty: 5, notes: "   " });
    expect(v.data.notes).toBeNull();
  });

  it("notes optional", () => {
    const v = validateLinePatch({ counted_qty: 5 });
    expect(v.error).toBeUndefined();
    expect(v.data.notes).toBeUndefined();
  });
});

describe("cycle-count lines — variance arithmetic (matches GENERATED column)", () => {
  // The DB column variance_qty is GENERATED ALWAYS AS (counted_qty - system_qty)
  // STORED. These tests guard the operator's mental model of variance.
  function expectedVariance(system, counted) {
    if (counted == null) return null;
    return counted - system;
  }

  it("counted > system -> positive variance (found)", () => {
    expect(expectedVariance(100, 105)).toBe(5);
  });

  it("counted < system -> negative variance (shrinkage)", () => {
    expect(expectedVariance(100, 95)).toBe(-5);
  });

  it("counted = system -> zero variance", () => {
    expect(expectedVariance(100, 100)).toBe(0);
  });

  it("system=0, counted=10 -> +10 (un-snapshotted item found)", () => {
    expect(expectedVariance(0, 10)).toBe(10);
  });

  it("system=10, counted=0 -> -10 (full shrinkage)", () => {
    expect(expectedVariance(10, 0)).toBe(-10);
  });

  it("uncounted line stays null", () => {
    expect(expectedVariance(100, null)).toBeNull();
  });
});
