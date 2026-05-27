// Tests for P3-11 fabric_codes handler validation.

import { describe, it, expect } from "vitest";
import { validateInsert } from "../../_handlers/internal/fabric-codes/index.js";
import { validatePatch }  from "../../_handlers/internal/fabric-codes/[id].js";

const UUID  = "00000000-0000-0000-0000-000000000001";

describe("fabric-codes validateInsert", () => {
  it("rejects missing code", () => {
    expect(validateInsert({}).error).toMatch(/code/);
  });

  it("rejects missing name", () => {
    expect(validateInsert({ code: "CTN100" }).error).toMatch(/name/);
  });

  it("rejects missing composition_text", () => {
    expect(validateInsert({ code: "CTN100", name: "100% Cotton" }).error).toMatch(/composition_text/);
  });

  it("uppercases code", () => {
    const v = validateInsert({ code: "ctn100", name: "100% Cotton", composition_text: "100% Cotton" });
    expect(v.error).toBeUndefined();
    expect(v.data.code).toBe("CTN100");
  });

  it("uppercases country code", () => {
    const v = validateInsert({ code: "CTN100", name: "X", composition_text: "X", country_of_origin_iso2: "us" });
    expect(v.error).toBeUndefined();
    expect(v.data.country_of_origin_iso2).toBe("US");
  });

  it("rejects 3-letter country code", () => {
    expect(validateInsert({
      code: "CTN100", name: "X", composition_text: "X", country_of_origin_iso2: "USA",
    }).error).toMatch(/country_of_origin_iso2/);
  });

  it("rejects non-letter country code", () => {
    expect(validateInsert({
      code: "CTN100", name: "X", composition_text: "X", country_of_origin_iso2: "12",
    }).error).toMatch(/country_of_origin_iso2/);
  });

  it("rejects negative weight", () => {
    expect(validateInsert({
      code: "CTN100", name: "X", composition_text: "X", fabric_weight_gsm: -1,
    }).error).toMatch(/fabric_weight_gsm/);
  });

  it("accepts zero weight", () => {
    const v = validateInsert({
      code: "X", name: "X", composition_text: "X", fabric_weight_gsm: 0,
    });
    expect(v.error).toBeUndefined();
    expect(v.data.fabric_weight_gsm).toBe(0);
  });

  it("parses composition_json string into object", () => {
    const v = validateInsert({
      code: "X", name: "X", composition_text: "X",
      composition_json: '[{"fiber":"cotton","pct":100}]',
    });
    expect(v.error).toBeUndefined();
    expect(Array.isArray(v.data.composition_json)).toBe(true);
    expect(v.data.composition_json[0].fiber).toBe("cotton");
  });

  it("rejects malformed composition_json", () => {
    expect(validateInsert({
      code: "X", name: "X", composition_text: "X", composition_json: "{not json",
    }).error).toMatch(/composition_json/);
  });

  it("rejects non-uuid default_vendor_id", () => {
    expect(validateInsert({
      code: "X", name: "X", composition_text: "X", default_vendor_id: "not-a-uuid",
    }).error).toMatch(/default_vendor_id/);
  });

  it("accepts uuid default_vendor_id", () => {
    const v = validateInsert({ code: "X", name: "X", composition_text: "X", default_vendor_id: UUID });
    expect(v.error).toBeUndefined();
    expect(v.data.default_vendor_id).toBe(UUID);
  });

  it("defaults is_active to true", () => {
    const v = validateInsert({ code: "X", name: "X", composition_text: "X" });
    expect(v.data.is_active).toBe(true);
  });

  it("respects explicit is_active=false", () => {
    const v = validateInsert({ code: "X", name: "X", composition_text: "X", is_active: false });
    expect(v.data.is_active).toBe(false);
  });
});

describe("fabric-codes validatePatch", () => {
  it("rejects code change (locked post-creation)", () => {
    expect(validatePatch({ code: "X" }).error).toMatch(/code/);
  });

  it("rejects entity_id change", () => {
    expect(validatePatch({ entity_id: UUID }).error).toMatch(/entity_id/);
  });

  it("accepts name change", () => {
    expect(validatePatch({ name: "New name" }).data.name).toBe("New name");
  });

  it("rejects empty name", () => {
    expect(validatePatch({ name: "  " }).error).toMatch(/name/);
  });

  it("accepts is_active toggle", () => {
    expect(validatePatch({ is_active: false }).data.is_active).toBe(false);
  });

  it("rejects non-boolean is_active", () => {
    expect(validatePatch({ is_active: "yes" }).error).toMatch(/is_active/);
  });

  it("normalizes empty country to null", () => {
    const v = validatePatch({ country_of_origin_iso2: "" });
    expect(v.data.country_of_origin_iso2).toBeNull();
  });

  it("rejects bad country on patch", () => {
    expect(validatePatch({ country_of_origin_iso2: "USA" }).error).toMatch(/country/);
  });

  it("rejects negative weight on patch", () => {
    expect(validatePatch({ fabric_weight_gsm: -5 }).error).toMatch(/fabric_weight_gsm/);
  });

  it("normalizes empty hts_code to null", () => {
    expect(validatePatch({ hts_code: "" }).data.hts_code).toBeNull();
  });

  it("empty patch returns empty data", () => {
    const v = validatePatch({});
    expect(v.error).toBeUndefined();
    expect(Object.keys(v.data)).toHaveLength(0);
  });

  it("rejects non-uuid default_vendor_id on patch", () => {
    expect(validatePatch({ default_vendor_id: "abc" }).error).toMatch(/default_vendor_id/);
  });

  it("accepts default_vendor_id null", () => {
    const v = validatePatch({ default_vendor_id: null });
    expect(v.data.default_vendor_id).toBeNull();
  });
});
