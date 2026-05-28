// Tests for the P8-6 PIM handler validators + query parsers + the shared
// attribute-value validator.  Pure-function coverage; no DB.
//
// Tangerine P8-6 (M42 PIM).

import { describe, it, expect } from "vitest";

import {
  parseListQuery as parseCatListQuery,
  validateCreate as validateCatCreate,
  annotateDepth,
} from "../../_handlers/internal/pim/categories/index.js";
import { validatePatch as validateCatPatch } from "../../_handlers/internal/pim/categories/[id].js";

import {
  parseListQuery as parseDefsListQuery,
  validateCreate as validateDefsCreate,
} from "../../_handlers/internal/pim/attribute-defs/index.js";
import { validatePatch as validateDefsPatch } from "../../_handlers/internal/pim/attribute-defs/[id].js";

import { validateBody as validateAttrBody } from "../../_handlers/internal/pim/styles/[style_id]/attributes.js";
import { mergeAttributesWithDefs } from "../../_handlers/internal/pim/styles/[style_id].js";

import {
  parseLocale as parseDescLocale,
  validatePatch as validateDescPatch,
} from "../../_handlers/internal/pim/styles/[style_id]/description/index.js";
import { parseLocale as parsePublishLocale } from "../../_handlers/internal/pim/styles/[style_id]/description/publish.js";

import {
  VALUE_TYPES,
  validateOptionsForType,
  validateValueAgainstDef,
} from "../../_lib/pim/attributeValue.js";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";

function sp(obj) {
  const u = new URL("https://x/y");
  for (const [k, v] of Object.entries(obj)) u.searchParams.set(k, String(v));
  return u.searchParams;
}

// ───────────────────────── categories.index ─────────────────────────

describe("pim categories: parseListQuery", () => {
  it("defaults is_active to null (all)", () => {
    expect(parseCatListQuery(sp({})).data).toEqual({ is_active: null });
  });
  it("accepts is_active=true|false", () => {
    expect(parseCatListQuery(sp({ is_active: "true" })).data.is_active).toBe(true);
    expect(parseCatListQuery(sp({ is_active: "false" })).data.is_active).toBe(false);
  });
  it("rejects garbage is_active", () => {
    expect(parseCatListQuery(sp({ is_active: "yes" })).error).toMatch(/is_active/);
  });
});

describe("pim categories: validateCreate", () => {
  it("requires code + name", () => {
    expect(validateCatCreate({}).error).toMatch(/code/);
    expect(validateCatCreate({ code: "X" }).error).toMatch(/name/);
  });
  it("trims and accepts minimal valid input", () => {
    const v = validateCatCreate({ code: "  DENIM ", name: "  Denim " });
    expect(v.error).toBeUndefined();
    expect(v.data.code).toBe("DENIM");
    expect(v.data.name).toBe("Denim");
    expect(v.data.parent_category_id).toBeNull();
    expect(v.data.sort_order).toBe(0);
    expect(v.data.is_active).toBe(true);
  });
  it("rejects parent_category_id that isn't a UUID", () => {
    expect(validateCatCreate({ code: "A", name: "A", parent_category_id: "abc" }).error)
      .toMatch(/parent_category_id/);
  });
  it("accepts a UUID parent_category_id", () => {
    expect(validateCatCreate({ code: "A", name: "A", parent_category_id: UUID_A }).data.parent_category_id)
      .toBe(UUID_A);
  });
  it("treats empty parent_category_id as null", () => {
    expect(validateCatCreate({ code: "A", name: "A", parent_category_id: "" }).data.parent_category_id)
      .toBeNull();
  });
  it("rejects non-integer sort_order", () => {
    expect(validateCatCreate({ code: "A", name: "A", sort_order: 1.5 }).error).toMatch(/sort_order/);
    expect(validateCatCreate({ code: "A", name: "A", sort_order: "abc" }).error).toMatch(/sort_order/);
  });
  it("rejects non-boolean is_active", () => {
    expect(validateCatCreate({ code: "A", name: "A", is_active: "true" }).error).toMatch(/is_active/);
  });
  it("rejects oversize code/name", () => {
    expect(validateCatCreate({ code: "x".repeat(100), name: "A" }).error).toMatch(/code/);
    expect(validateCatCreate({ code: "A", name: "x".repeat(200) }).error).toMatch(/name/);
  });
});

describe("pim categories: annotateDepth", () => {
  it("tags roots as depth 0", () => {
    const rows = [{ id: "a", parent_category_id: null }, { id: "b", parent_category_id: null }];
    const out = annotateDepth(rows);
    expect(out.every((r) => r.depth === 0)).toBe(true);
  });
  it("tags children by distance from root", () => {
    const rows = [
      { id: "a", parent_category_id: null },
      { id: "b", parent_category_id: "a" },
      { id: "c", parent_category_id: "b" },
    ];
    const out = annotateDepth(rows);
    const byId = Object.fromEntries(out.map((r) => [r.id, r.depth]));
    expect(byId).toEqual({ a: 0, b: 1, c: 2 });
  });
  it("does not loop on a malformed cycle", () => {
    const rows = [
      { id: "a", parent_category_id: "b" },
      { id: "b", parent_category_id: "a" },
    ];
    const out = annotateDepth(rows);
    expect(out.length).toBe(2);
    expect(out.every((r) => Number.isFinite(r.depth))).toBe(true);
  });
});

// ───────────────────────── categories.[id] PATCH ─────────────────────

describe("pim categories: validatePatch", () => {
  it("rejects empty body", () => {
    expect(validateCatPatch({}).error).toMatch(/No fields/);
  });
  it("accepts partial body", () => {
    const v = validateCatPatch({ name: "New" });
    expect(v.error).toBeUndefined();
    expect(v.data).toEqual({ name: "New" });
  });
  it("rejects empty-string code/name", () => {
    expect(validateCatPatch({ code: "  " }).error).toMatch(/code/);
    expect(validateCatPatch({ name: "" }).error).toMatch(/name/);
  });
  it("allows nulling parent_category_id", () => {
    expect(validateCatPatch({ parent_category_id: null }).data.parent_category_id).toBeNull();
    expect(validateCatPatch({ parent_category_id: "" }).data.parent_category_id).toBeNull();
  });
  it("rejects malformed parent_category_id", () => {
    expect(validateCatPatch({ parent_category_id: "abc" }).error).toMatch(/parent_category_id/);
  });
});

// ───────────────────────── attribute-defs.index ─────────────────────

describe("pim attribute-defs: parseListQuery", () => {
  it("defaults category_id to null", () => {
    expect(parseDefsListQuery(sp({})).data).toEqual({ category_id: null });
  });
  it("rejects non-UUID category_id", () => {
    expect(parseDefsListQuery(sp({ category_id: "abc" })).error).toMatch(/category_id/);
  });
  it("accepts valid UUID category_id", () => {
    expect(parseDefsListQuery(sp({ category_id: UUID_A })).data.category_id).toBe(UUID_A);
  });
});

describe("pim attribute-defs: validateCreate", () => {
  const base = { attribute_key: "fit_type", label: "Fit", value_type: "text" };
  it("requires attribute_key", () => {
    expect(validateDefsCreate({ ...base, attribute_key: "" }).error).toMatch(/attribute_key/);
  });
  it("rejects non-snake_case attribute_key", () => {
    expect(validateDefsCreate({ ...base, attribute_key: "FitType" }).error).toMatch(/attribute_key/);
    expect(validateDefsCreate({ ...base, attribute_key: "1abc" }).error).toMatch(/attribute_key/);
    expect(validateDefsCreate({ ...base, attribute_key: "abc-def" }).error).toMatch(/attribute_key/);
  });
  it("requires label", () => {
    expect(validateDefsCreate({ ...base, label: "" }).error).toMatch(/label/);
  });
  it("rejects invalid value_type", () => {
    expect(validateDefsCreate({ ...base, value_type: "json" }).error).toMatch(/value_type/);
  });
  it("accepts every legal value_type", () => {
    for (const vt of VALUE_TYPES) {
      const body = { ...base, value_type: vt };
      if (vt === "enum") body.options = { options: ["a", "b"] };
      expect(validateDefsCreate(body).error).toBeUndefined();
    }
  });
  it("requires options.options for enum", () => {
    expect(validateDefsCreate({ ...base, value_type: "enum" }).error).toMatch(/options/);
    expect(validateDefsCreate({ ...base, value_type: "enum", options: {} }).error).toMatch(/options/);
    expect(validateDefsCreate({ ...base, value_type: "enum", options: { options: [] } }).error).toMatch(/options/);
    expect(validateDefsCreate({ ...base, value_type: "enum", options: { options: ["a"] } }).error).toBeUndefined();
  });
  it("rejects non-boolean is_required", () => {
    expect(validateDefsCreate({ ...base, is_required: "yes" }).error).toMatch(/is_required/);
  });
  it("defaults is_required + sort_order", () => {
    const v = validateDefsCreate(base);
    expect(v.data.is_required).toBe(false);
    expect(v.data.sort_order).toBe(0);
  });
});

// ───────────────────────── attribute-defs.[id] ─────────────────────

describe("pim attribute-defs: validatePatch", () => {
  it("rejects empty body", () => {
    expect(validateDefsPatch({}).error).toMatch(/No fields/);
  });
  it("accepts label-only update", () => {
    const v = validateDefsPatch({ label: "New Label" });
    expect(v.error).toBeUndefined();
    expect(v.data).toEqual({ label: "New Label" });
  });
  it("requires options when changing to enum", () => {
    expect(validateDefsPatch({ value_type: "enum" }).error).toMatch(/options/);
    expect(validateDefsPatch({ value_type: "enum", options: { options: ["a"] } }).error).toBeUndefined();
  });
  it("allows options-only edit without specifying value_type", () => {
    expect(validateDefsPatch({ options: { min: 0 } }).data.options).toEqual({ min: 0 });
    expect(validateDefsPatch({ options: null }).data.options).toBeNull();
  });
  it("silently ignores immutable attribute_key / category_id (rather than 400)", () => {
    const v = validateDefsPatch({ attribute_key: "new_key", category_id: UUID_A, label: "L" });
    expect(v.error).toBeUndefined();
    expect(v.data).toEqual({ label: "L" });
  });
});

// ───────────────────────── shared value validator ───────────────────

describe("validateOptionsForType", () => {
  it("requires enum options to be a non-empty string array", () => {
    expect(validateOptionsForType("enum", null).error).toMatch(/options/);
    expect(validateOptionsForType("enum", { options: ["a", 1] }).error).toMatch(/string/);
    expect(validateOptionsForType("enum", { options: ["slim", "regular"] }).data.options).toEqual(["slim", "regular"]);
  });
  it("allows null options for non-enum types", () => {
    expect(validateOptionsForType("text", null).data.options).toBeNull();
    expect(validateOptionsForType("number", null).data.options).toBeNull();
  });
  it("rejects array options for non-enum", () => {
    expect(validateOptionsForType("number", [1, 2]).error).toMatch(/object/);
  });
});

describe("validateValueAgainstDef", () => {
  it("enum: rejects non-member", () => {
    const def = { value_type: "enum", options: { options: ["slim", "regular"] } };
    expect(validateValueAgainstDef(def, "loose").error).toMatch(/one of/);
    expect(validateValueAgainstDef(def, "slim").data.value).toBe("slim");
  });
  it("enum: rejects non-string", () => {
    const def = { value_type: "enum", options: { options: ["a"] } };
    expect(validateValueAgainstDef(def, 42).error).toMatch(/string/);
  });
  it("enum: accepts {value: x} envelope", () => {
    const def = { value_type: "enum", options: { options: ["a", "b"] } };
    expect(validateValueAgainstDef(def, { value: "b" }).data.value).toBe("b");
  });
  it("number: coerces numeric string", () => {
    expect(validateValueAgainstDef({ value_type: "number" }, "42").data.value).toBe(42);
  });
  it("number: rejects non-finite + booleans", () => {
    expect(validateValueAgainstDef({ value_type: "number" }, "abc").error).toMatch(/number/);
    expect(validateValueAgainstDef({ value_type: "number" }, true).error).toMatch(/number/);
    expect(validateValueAgainstDef({ value_type: "number" }, Infinity).error).toMatch(/finite/);
  });
  it("boolean: STRICT — only real booleans allowed", () => {
    expect(validateValueAgainstDef({ value_type: "boolean" }, "true").error).toMatch(/boolean/);
    expect(validateValueAgainstDef({ value_type: "boolean" }, 1).error).toMatch(/boolean/);
    expect(validateValueAgainstDef({ value_type: "boolean" }, true).data.value).toBe(true);
    expect(validateValueAgainstDef({ value_type: "boolean" }, false).data.value).toBe(false);
  });
  it("date: requires ISO YYYY-MM-DD", () => {
    expect(validateValueAgainstDef({ value_type: "date" }, "2026-05-28").data.value).toBe("2026-05-28");
    expect(validateValueAgainstDef({ value_type: "date" }, "5/28/2026").error).toMatch(/ISO/);
    expect(validateValueAgainstDef({ value_type: "date" }, "2026-13-01").error).toMatch(/calendar/);
    expect(validateValueAgainstDef({ value_type: "date" }, "2026-02-30").error).toMatch(/calendar/);
  });
  it("text: rejects non-string + oversize", () => {
    expect(validateValueAgainstDef({ value_type: "text" }, 42).error).toMatch(/string/);
    expect(validateValueAgainstDef({ value_type: "text" }, "x".repeat(11_000)).error).toMatch(/10000/);
    expect(validateValueAgainstDef({ value_type: "text" }, "hi").data.value).toBe("hi");
  });
  it("rejects missing def or value_type", () => {
    expect(validateValueAgainstDef(null, "x").error).toMatch(/value_type/);
    expect(validateValueAgainstDef({ value_type: "lol" }, "x").error).toMatch(/value_type/);
  });
  it("rejects undefined value", () => {
    expect(validateValueAgainstDef({ value_type: "text" }, undefined).error).toMatch(/value/);
  });
});

// ───────────────────────── style attributes upsert body ─────────────

describe("style attributes: validateBody", () => {
  it("requires attribute_key and value", () => {
    expect(validateAttrBody({}).error).toMatch(/attribute_key/);
    expect(validateAttrBody({ attribute_key: "fit_type" }).error).toMatch(/value/);
  });
  it("rejects bad-shape attribute_key", () => {
    expect(validateAttrBody({ attribute_key: "Fit-Type", value: "x" }).error).toMatch(/attribute_key/);
  });
  it("accepts value=null (description below DB constraint NOT NULL is server's job to reject)", () => {
    // The handler will pass this to validateValueAgainstDef which will reject by type;
    // here we just confirm the body validator accepts a present value (including null).
    expect(validateAttrBody({ attribute_key: "fit_type", value: null }).error).toBeUndefined();
  });
});

// ───────────────────────── style composite merge ────────────────────

describe("style composite: mergeAttributesWithDefs", () => {
  it("attaches definition with category match preferred over entity-wide", () => {
    const attrs = [{ id: "x", attribute_key: "fit_type", value: { value: "slim" }, updated_at: "t", updated_by_user_id: null }];
    const defs = [
      { id: "d-wide", category_id: null,    attribute_key: "fit_type", label: "Fit (any)", value_type: "text",  options: null, is_required: false, sort_order: 0 },
      { id: "d-cat",  category_id: UUID_C,  attribute_key: "fit_type", label: "Fit (cat)", value_type: "enum",  options: { options: ["slim","regular"] }, is_required: false, sort_order: 10 },
    ];
    const merged = mergeAttributesWithDefs(attrs, defs, UUID_C);
    expect(merged[0].definition.id).toBe("d-cat");
    expect(merged[0].definition.value_type).toBe("enum");
  });
  it("returns null definition for orphan attributes", () => {
    const attrs = [{ id: "x", attribute_key: "ghost", value: { value: "?" }, updated_at: "t", updated_by_user_id: null }];
    const merged = mergeAttributesWithDefs(attrs, [], UUID_A);
    expect(merged[0].definition).toBeNull();
  });
  it("falls back to entity-wide def when no category match", () => {
    const attrs = [{ id: "x", attribute_key: "fabric", value: { value: "cotton" }, updated_at: "t", updated_by_user_id: null }];
    const defs = [
      { id: "d-wide", category_id: null, attribute_key: "fabric", label: "Fabric", value_type: "text", options: null, is_required: false, sort_order: 0 },
    ];
    const merged = mergeAttributesWithDefs(attrs, defs, UUID_B);
    expect(merged[0].definition.id).toBe("d-wide");
  });
});

// ───────────────────────── description GET / PATCH ─────────────────

describe("description: parseLocale (GET + PATCH)", () => {
  it("defaults to en-US", () => {
    expect(parseDescLocale(sp({})).data.locale).toBe("en-US");
  });
  it("accepts en, fr-FR, zh-CN, etc.", () => {
    expect(parseDescLocale(sp({ locale: "en" })).data.locale).toBe("en");
    expect(parseDescLocale(sp({ locale: "fr-FR" })).data.locale).toBe("fr-FR");
    expect(parseDescLocale(sp({ locale: "zh-CN" })).data.locale).toBe("zh-CN");
  });
  it("rejects malformed locales", () => {
    expect(parseDescLocale(sp({ locale: "ENGLISH" })).error).toMatch(/locale/);
    expect(parseDescLocale(sp({ locale: "e" })).error).toMatch(/locale/);
    expect(parseDescLocale(sp({ locale: "en_US" })).error).toMatch(/locale/);
  });
});

describe("description: validatePatch", () => {
  it("rejects empty body", () => {
    expect(validateDescPatch({}).error).toMatch(/No fields/);
  });
  it("accepts a single field", () => {
    expect(validateDescPatch({ short_description: "Hi" }).data.short_description).toBe("Hi");
  });
  it("treats null and empty-string as null (clearing the field)", () => {
    expect(validateDescPatch({ short_description: null }).data.short_description).toBeNull();
    expect(validateDescPatch({ short_description: "" }).data.short_description).toBeNull();
  });
  it("rejects non-string text fields", () => {
    expect(validateDescPatch({ short_description: 42 }).error).toMatch(/short_description/);
  });
  it("enforces per-field length limits", () => {
    expect(validateDescPatch({ short_description: "x".repeat(600) }).error).toMatch(/500/);
    expect(validateDescPatch({ long_description: "x".repeat(30_000) }).error).toMatch(/20000/);
    expect(validateDescPatch({ bullet_1: "x".repeat(600) }).error).toMatch(/500/);
    expect(validateDescPatch({ seo_title: "x".repeat(300) }).error).toMatch(/200/);
    expect(validateDescPatch({ seo_description: "x".repeat(600) }).error).toMatch(/500/);
  });
  it("ignores fields not in the allow-list", () => {
    expect(validateDescPatch({ publish_status: "published" }).error).toMatch(/No fields/);
  });
});

describe("description publish: parseLocale", () => {
  it("defaults to en-US", () => {
    expect(parsePublishLocale(sp({})).data.locale).toBe("en-US");
  });
  it("rejects garbage locale", () => {
    expect(parsePublishLocale(sp({ locale: "@@@" })).error).toMatch(/locale/);
  });
});
