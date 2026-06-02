// Tests for P3-11 style_fabric_codes junction handler validation.

import { describe, it, expect } from "vitest";
import { validateInsert } from "../../_handlers/internal/style-fabric-codes/index.js";
import { validatePatch }  from "../../_handlers/internal/style-fabric-codes/[id].js";

const STYLE_UUID  = "11111111-1111-1111-1111-111111111111";
const FABRIC_UUID = "22222222-2222-2222-2222-222222222222";

describe("style-fabric-codes validateInsert", () => {
  it("rejects missing style_id", () => {
    expect(validateInsert({ fabric_code_id: FABRIC_UUID, role: "primary" }).error).toMatch(/style_id/);
  });

  it("rejects missing fabric_code_id", () => {
    expect(validateInsert({ style_id: STYLE_UUID, role: "primary" }).error).toMatch(/fabric_code_id/);
  });

  it("rejects bogus role", () => {
    expect(validateInsert({
      style_id: STYLE_UUID, fabric_code_id: FABRIC_UUID, role: "interfacing",
    }).error).toMatch(/role/);
  });

  it("accepts all 6 valid roles", () => {
    const roles = ["primary", "lining", "trim", "interlining", "accent", "other"];
    for (const role of roles) {
      const v = validateInsert({ style_id: STYLE_UUID, fabric_code_id: FABRIC_UUID, role });
      expect(v.error, `role=${role}`).toBeUndefined();
      expect(v.data.role).toBe(role);
    }
  });

  it("rejects negative yardage", () => {
    expect(validateInsert({
      style_id: STYLE_UUID, fabric_code_id: FABRIC_UUID, role: "primary", yardage_per_unit: -1,
    }).error).toMatch(/yardage/);
  });

  it("rejects non-uuid style_id", () => {
    expect(validateInsert({
      style_id: "abc", fabric_code_id: FABRIC_UUID, role: "primary",
    }).error).toMatch(/style_id/);
  });

  it("rejects non-uuid fabric_code_id", () => {
    expect(validateInsert({
      style_id: STYLE_UUID, fabric_code_id: "abc", role: "primary",
    }).error).toMatch(/fabric_code_id/);
  });

  it("accepts notes", () => {
    const v = validateInsert({
      style_id: STYLE_UUID, fabric_code_id: FABRIC_UUID, role: "primary", notes: "shell only",
    });
    expect(v.data.notes).toBe("shell only");
  });
});

describe("style-fabric-codes validatePatch", () => {
  it("rejects style_id change", () => {
    expect(validatePatch({ style_id: STYLE_UUID }).error).toMatch(/style_id/);
  });

  it("rejects fabric_code_id change", () => {
    expect(validatePatch({ fabric_code_id: FABRIC_UUID }).error).toMatch(/fabric_code_id/);
  });

  it("accepts role change", () => {
    expect(validatePatch({ role: "trim" }).data.role).toBe("trim");
  });

  it("rejects bad role on patch", () => {
    expect(validatePatch({ role: "bogus" }).error).toMatch(/role/);
  });

  it("accepts yardage change", () => {
    expect(validatePatch({ yardage_per_unit: 1.5 }).data.yardage_per_unit).toBe(1.5);
  });

  it("normalizes yardage empty string to null", () => {
    expect(validatePatch({ yardage_per_unit: "" }).data.yardage_per_unit).toBeNull();
  });

  it("rejects negative yardage on patch", () => {
    expect(validatePatch({ yardage_per_unit: -0.5 }).error).toMatch(/yardage/);
  });

  it("normalizes empty notes to null", () => {
    expect(validatePatch({ notes: "" }).data.notes).toBeNull();
  });

  it("empty patch returns empty data", () => {
    const v = validatePatch({});
    expect(v.error).toBeUndefined();
    expect(Object.keys(v.data)).toHaveLength(0);
  });
});
