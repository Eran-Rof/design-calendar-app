// Tests for the style-master admin handlers. Pure-JS, no DB —
// we test the validate* helpers directly since they encapsulate the
// non-trivial logic. End-to-end testing happens via real-DB smoke after deploy.
//
// 2026-05-30 — Style Master Sweep:
//   • Gender code set normalized to { M, B, C, G, W, U }; legacy "WMS"
//     no longer accepted (mapped to "W" by the migration).
//   • Adds group_name / category_name / sub_category_name coverage.

import { describe, it, expect } from "vitest";
import { validateInsert } from "../../_handlers/internal/style-master/index.js";
import { validatePatch } from "../../_handlers/internal/style-master/[id].js";

describe("validateInsert", () => {
  it("rejects missing style_code", () => {
    expect(validateInsert({ description: "x" }).error).toMatch(/style_code/);
  });
  it("rejects empty style_code", () => {
    expect(validateInsert({ style_code: "   ", description: "x" }).error).toMatch(/style_code/);
  });
  it("rejects missing description", () => {
    expect(validateInsert({ style_code: "RY1234" }).error).toMatch(/description/);
  });
  it("rejects invalid gender_code", () => {
    expect(validateInsert({ style_code: "RY1234", description: "x", gender_code: "X" }).error).toMatch(/gender_code/);
  });
  it("rejects legacy WMS gender (mapped to W by migration)", () => {
    expect(validateInsert({ style_code: "RY1234", description: "x", gender_code: "WMS" }).error).toMatch(/gender_code/);
  });
  it("accepts new canonical W gender", () => {
    expect(validateInsert({ style_code: "RY1234", description: "x", gender_code: "W" }).error).toBeUndefined();
  });
  it("accepts every code in the canonical set", () => {
    for (const g of ["M", "B", "C", "G", "W", "U"]) {
      expect(validateInsert({ style_code: "RY1234", description: "x", gender_code: g }).error).toBeUndefined();
    }
  });
  it("rejects invalid lifecycle", () => {
    expect(validateInsert({ style_code: "RY1234", description: "x", lifecycle_status: "BOGUS" }).error).toMatch(/lifecycle/);
  });
  it("rejects invalid planning_class", () => {
    expect(validateInsert({ style_code: "RY1234", description: "x", planning_class: "expensive" }).error).toMatch(/planning_class/);
  });
  it("rejects design_year out of range", () => {
    expect(validateInsert({ style_code: "RY1234", description: "x", design_year: 1850 }).error).toMatch(/design_year/);
    expect(validateInsert({ style_code: "RY1234", description: "x", design_year: 3000 }).error).toMatch(/design_year/);
  });
  it("coerces design_year from string", () => {
    const v = validateInsert({ style_code: "RY1234", description: "x", design_year: "2026" });
    expect(v.error).toBeUndefined();
    expect(v.data.design_year).toBe(2026);
  });
  it("accepts a complete payload", () => {
    const v = validateInsert({
      style_code: "RY1234", description: "Test", gender_code: "W",
      season: "FW26", design_year: 2026, lifecycle_status: "active",
      planning_class: "core", is_apparel: true,
    });
    expect(v.error).toBeUndefined();
  });
  it("accepts optional style_name", () => {
    const v = validateInsert({ style_code: "RY1234", description: "x", style_name: "Delano Cargo Short" });
    expect(v.error).toBeUndefined();
    expect(v.data.style_name).toBe("Delano Cargo Short");
  });
  it("accepts and trims group / category / sub_category names", () => {
    const v = validateInsert({
      style_code: "RY1234", description: "x",
      group_name: "  Apparel ", category_name: "Tops", sub_category_name: " T-Shirts ",
    });
    expect(v.error).toBeUndefined();
    expect(v.data.group_name).toBe("Apparel");
    expect(v.data.category_name).toBe("Tops");
    expect(v.data.sub_category_name).toBe("T-Shirts");
  });
  it("coerces blank classifier strings to null", () => {
    const v = validateInsert({
      style_code: "RY1234", description: "x",
      group_name: "   ", category_name: "", sub_category_name: "",
    });
    expect(v.error).toBeUndefined();
    expect(v.data.group_name).toBeNull();
    expect(v.data.category_name).toBeNull();
    expect(v.data.sub_category_name).toBeNull();
  });
});

describe("validatePatch", () => {
  it("filters out non-mutable fields", () => {
    const v = validatePatch({ style_code: "HACK", description: "ok" });
    expect(v.data.style_code).toBeUndefined();
    expect(v.data.description).toBe("ok");
  });
  it("normalizes empty strings to null for nullable fields", () => {
    const v = validatePatch({ gender_code: "", season: "", base_fabric: "" });
    expect(v.data.gender_code).toBeNull();
    expect(v.data.season).toBeNull();
    expect(v.data.base_fabric).toBeNull();
  });
  it("rejects invalid gender", () => {
    expect(validatePatch({ gender_code: "ZZ" }).error).toMatch(/gender_code/);
  });
  it("rejects legacy WMS gender on patch", () => {
    expect(validatePatch({ gender_code: "WMS" }).error).toMatch(/gender_code/);
  });
  it("accepts every code in the new canonical set", () => {
    for (const g of ["M", "B", "C", "G", "W", "U"]) {
      expect(validatePatch({ gender_code: g }).error).toBeUndefined();
    }
  });
  it("accepts an empty body without error (caller should reject empties)", () => {
    const v = validatePatch({});
    expect(v.error).toBeUndefined();
    expect(v.data).toEqual({});
  });
  it("coerces design_year from string", () => {
    const v = validatePatch({ design_year: "2027" });
    expect(v.error).toBeUndefined();
    expect(v.data.design_year).toBe(2027);
  });
  it("rejects design_year out of range", () => {
    expect(validatePatch({ design_year: 1500 }).error).toMatch(/design_year/);
  });
  it("accepts style_name patch and normalizes empty string to null", () => {
    expect(validatePatch({ style_name: "Delano" }).data.style_name).toBe("Delano");
    expect(validatePatch({ style_name: "" }).data.style_name).toBeNull();
  });
  it("accepts and trims group / category / sub_category patches", () => {
    const v = validatePatch({
      group_name: "  Apparel ", category_name: " Tops", sub_category_name: "T-Shirts  ",
    });
    expect(v.error).toBeUndefined();
    expect(v.data.group_name).toBe("Apparel");
    expect(v.data.category_name).toBe("Tops");
    expect(v.data.sub_category_name).toBe("T-Shirts");
  });
  it("normalizes blank classifier strings to null on patch", () => {
    const v = validatePatch({ group_name: "", category_name: "   ", sub_category_name: "" });
    expect(v.error).toBeUndefined();
    expect(v.data.group_name).toBeNull();
    expect(v.data.category_name).toBeNull();
    expect(v.data.sub_category_name).toBeNull();
  });
});
