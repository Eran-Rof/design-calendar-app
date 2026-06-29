import { describe, it, expect } from "vitest";
import { normalizeAliases, appendAlias, validatePatch } from "../../_handlers/internal/style-master/[id].js";

describe("normalizeAliases", () => {
  it("uppercases, trims, and de-dupes (case-insensitive)", () => {
    expect(normalizeAliases([" ryb147730 ", "RYB147730", "rjo0639-ppk"])).toEqual(["RYB147730", "RJO0639-PPK"]);
  });
  it("drops blanks and non-strings; handles non-array", () => {
    expect(normalizeAliases(["", "  ", null, undefined, "X"])).toEqual(["X"]);
    expect(normalizeAliases(null)).toEqual([]);
    expect(normalizeAliases("RYB1")).toEqual([]); // not an array
  });
});

describe("appendAlias", () => {
  it("appends the old code uppercased, de-duped", () => {
    expect(appendAlias(["RYB1477PPK"], "ryb147730")).toEqual(["RYB1477PPK", "RYB147730"]);
  });
  it("is idempotent when the code is already present (any case)", () => {
    expect(appendAlias(["RYB147730"], "ryb147730")).toEqual(["RYB147730"]);
  });
  it("ignores a blank code and normalizes the existing list", () => {
    expect(appendAlias([" ryb1 ", "RYB1"], "")).toEqual(["RYB1"]);
  });
});

describe("validatePatch — aliases", () => {
  it("normalizes an aliases field in the patch", () => {
    const { data } = validatePatch({ aliases: [" ryb147730 ", "RYB147730"] });
    expect(data.aliases).toEqual(["RYB147730"]);
  });
  it("does not touch aliases when not supplied", () => {
    const { data } = validatePatch({ style_name: "X" });
    expect("aliases" in data).toBe(false);
  });
  it("still ignores style_code (handled separately, not a mutable field)", () => {
    const { data } = validatePatch({ style_code: "RYB1477PPK", style_name: "Edge" });
    expect("style_code" in data).toBe(false);
    expect(data.style_name).toBe("Edge");
  });
});
