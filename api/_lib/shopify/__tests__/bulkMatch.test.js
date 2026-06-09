import { describe, it, expect } from "vitest";
import { styleCodeFromSku, resolveStyleCode, matchProductToStyleCode } from "../bulkMatch.js";

describe("styleCodeFromSku", () => {
  it("takes the prefix before the first dash", () => {
    expect(styleCodeFromSku("RYG1674H-Steel-SML")).toBe("RYG1674H");
    expect(styleCodeFromSku("RYA1460-White / Black-O/S")).toBe("RYA1460");
    expect(styleCodeFromSku("B2100")).toBe("B2100");
    expect(styleCodeFromSku("")).toBe("");
    expect(styleCodeFromSku(null)).toBe("");
  });
});

describe("resolveStyleCode", () => {
  const codes = new Set(["RYG1674H", "RYA1460", "RYB0043", "B2100"]);
  it("matches exactly (case-insensitive)", () => {
    expect(resolveStyleCode("RYG1674H", codes)).toBe("RYG1674H");
    expect(resolveStyleCode("rya1460", codes)).toBe("RYA1460");
  });
  it("denim fallback: strips a trailing 2-digit inseam", () => {
    expect(resolveStyleCode("RYB004330", codes)).toBe("RYB0043"); // inseam 30
    expect(resolveStyleCode("RYB004332", codes)).toBe("RYB0043"); // inseam 32
  });
  it("returns null when nothing matches", () => {
    expect(resolveStyleCode("ZZZ9999", codes)).toBeNull();
    expect(resolveStyleCode("", codes)).toBeNull();
  });
  it("prefers exact over inseam-strip", () => {
    const c2 = new Set(["AB1234", "AB12"]);
    expect(resolveStyleCode("AB1234", c2)).toBe("AB1234");
  });
});

describe("matchProductToStyleCode", () => {
  const codes = new Set(["RYG1674H", "RYB0043"]);
  it("returns the first variant SKU that resolves", () => {
    const product = { variants: [{ sku: "NOPE-x" }, { sku: "RYG1674H-Steel-SML" }] };
    expect(matchProductToStyleCode(product, codes)).toBe("RYG1674H");
  });
  it("handles denim inseam variants", () => {
    expect(matchProductToStyleCode({ variants: [{ sku: "RYB004330-Blue-32" }] }, codes)).toBe("RYB0043");
  });
  it("null when no variant matches (e.g. gift card, no SKU)", () => {
    expect(matchProductToStyleCode({ variants: [] }, codes)).toBeNull();
    expect(matchProductToStyleCode({ variants: [{ sku: "" }] }, codes)).toBeNull();
  });
});
