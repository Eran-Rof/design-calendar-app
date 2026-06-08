// Tests for Size Scale Master handler validation — focus on the optional
// `inseams` axis (parallel to `sizes`, but may be empty = size-only scale).

import { describe, it, expect } from "vitest";
import { validateInsert, normalizeInseams } from "../../_handlers/internal/size-scales/index.js";
import { validatePatch } from "../../_handlers/internal/size-scales/[id].js";

describe("size-scales validateInsert — inseams", () => {
  it("defaults inseams to an empty array when omitted (size-only scale)", () => {
    const v = validateInsert({ name: "Alpha", sizes: "S, M, L" });
    expect(v.error).toBeUndefined();
    expect(v.data.inseams).toEqual([]);
  });

  it("parses comma-separated inseams in order", () => {
    const v = validateInsert({ name: "Mens Denim", sizes: "30,32,34", inseams: "30, 32, 34" });
    expect(v.error).toBeUndefined();
    expect(v.data.inseams).toEqual(["30", "32", "34"]);
  });

  it("accepts a JSON array of inseams and preserves order", () => {
    const v = validateInsert({ name: "X", sizes: ["30"], inseams: ["34", "30", "32"] });
    expect(v.error).toBeUndefined();
    expect(v.data.inseams).toEqual(["34", "30", "32"]);
  });

  it("still requires at least one size even when inseams present", () => {
    expect(validateInsert({ name: "X", sizes: "", inseams: "30,32" }).error).toMatch(/size/);
  });
});

describe("size-scales validatePatch — inseams", () => {
  it("allows inseams to be cleared to an empty list", () => {
    const v = validatePatch({ inseams: "" });
    expect(v.error).toBeUndefined();
    expect(v.data.inseams).toEqual([]);
  });

  it("updates inseams from a comma-separated string", () => {
    const v = validatePatch({ inseams: "28, 30" });
    expect(v.error).toBeUndefined();
    expect(v.data.inseams).toEqual(["28", "30"]);
  });

  it("sizes still cannot be emptied", () => {
    expect(validatePatch({ sizes: "" }).error).toMatch(/size/);
  });
});

describe("normalizeInseams", () => {
  it("trims, de-blanks, and preserves order", () => {
    expect(normalizeInseams(" 30 , ,32 ,34 ")).toEqual(["30", "32", "34"]);
  });
  it("returns [] for null/undefined", () => {
    expect(normalizeInseams(null)).toEqual([]);
    expect(normalizeInseams(undefined)).toEqual([]);
  });
});
