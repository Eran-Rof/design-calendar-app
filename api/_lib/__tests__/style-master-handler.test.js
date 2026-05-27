// Tests for the style-master admin handlers. Pure-JS, no DB —
// we test the validate* helpers directly since they encapsulate the
// non-trivial logic. End-to-end testing happens via real-DB smoke after deploy.

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
  it("accepts WMS gender", () => {
    expect(validateInsert({ style_code: "RY1234", description: "x", gender_code: "WMS" }).error).toBeUndefined();
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
      style_code: "RY1234", description: "Test", gender_code: "WMS",
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
});
