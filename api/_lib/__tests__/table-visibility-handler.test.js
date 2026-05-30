// Tests for the universal column-visibility handler validator + merge
// helper. Operator ask #1 (2026-05-30).
//
// Pure-function coverage — no Supabase mock needed.

import { describe, it, expect } from "vitest";
import {
  validateTableVisibilityBody,
  mergeTables,
} from "../../_handlers/internal/users/me/preferences/table-visibility.js";

describe("validateTableVisibilityBody", () => {
  it("rejects non-object body", () => {
    expect(validateTableVisibilityBody(null).error).toMatch(/JSON object/);
    expect(validateTableVisibilityBody("nope").error).toMatch(/JSON object/);
  });

  it("rejects missing tables", () => {
    expect(validateTableVisibilityBody({}).error).toMatch(/tables/);
  });

  it("rejects array as tables", () => {
    expect(validateTableVisibilityBody({ tables: [] }).error).toMatch(/object/);
  });

  it("rejects non-array hidden value", () => {
    expect(validateTableVisibilityBody({ tables: { foo: "bar" } }).error).toMatch(/array/);
  });

  it("rejects empty-string tableKey", () => {
    expect(validateTableVisibilityBody({ tables: { "": [] } }).error).toMatch(/tableKey/);
  });

  it("rejects empty-string column key", () => {
    expect(validateTableVisibilityBody({ tables: { foo: [""] } }).error).toMatch(/non-empty/);
  });

  it("accepts a valid body and de-dupes hidden columns", () => {
    const v = validateTableVisibilityBody({
      tables: { "tanda.style_master": ["a", "b", "a"] },
    });
    expect(v.error).toBeUndefined();
    expect(v.data.tables).toEqual({ "tanda.style_master": ["a", "b"] });
  });

  it("accepts an empty hidden array (reset path)", () => {
    const v = validateTableVisibilityBody({ tables: { foo: [] } });
    expect(v.error).toBeUndefined();
    expect(v.data.tables).toEqual({ foo: [] });
  });

  it("rejects too many tables", () => {
    const tables = {};
    for (let i = 0; i < 300; i++) tables[`t${i}`] = [];
    expect(validateTableVisibilityBody({ tables }).error).toMatch(/at most/);
  });

  it("rejects too many hidden columns per table", () => {
    const hidden = Array.from({ length: 300 }, (_, i) => `c${i}`);
    expect(validateTableVisibilityBody({ tables: { foo: hidden } }).error).toMatch(/at most/);
  });

  it("rejects overly long tableKey", () => {
    const longKey = "x".repeat(200);
    expect(validateTableVisibilityBody({ tables: { [longKey]: [] } }).error).toMatch(/too long/);
  });
});

describe("mergeTables", () => {
  it("returns the patch when stored is null/empty", () => {
    expect(mergeTables(null, { a: ["x"] })).toEqual({ a: ["x"] });
    expect(mergeTables({}, { a: ["x"] })).toEqual({ a: ["x"] });
  });

  it("preserves stored tables that the patch does not touch", () => {
    const stored = { a: ["x"], b: ["y"] };
    const patch = { c: ["z"] };
    expect(mergeTables(stored, patch)).toEqual({ a: ["x"], b: ["y"], c: ["z"] });
  });

  it("replaces stored entries that appear in patch (replace semantics)", () => {
    const stored = { a: ["old"], b: ["y"] };
    const patch = { a: ["new1", "new2"] };
    expect(mergeTables(stored, patch)).toEqual({ a: ["new1", "new2"], b: ["y"] });
  });

  it("empty patch array clears the hidden set for that table only", () => {
    const stored = { a: ["x"], b: ["y"] };
    const patch = { a: [] };
    expect(mergeTables(stored, patch)).toEqual({ a: [], b: ["y"] });
  });

  it("filters non-string entries from stored input defensively", () => {
    const stored = { a: ["x", 7, null] };
    expect(mergeTables(stored, {})).toEqual({ a: ["x"] });
  });
});
