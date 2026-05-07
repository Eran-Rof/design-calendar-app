import { describe, expect, it } from "vitest";
import { extractPpk, ppkMultiplier, ppkMultiplierForAts } from "../index";

describe("extractPpk", () => {
  it("parses PPKn forms with no separator", () => {
    expect(extractPpk("PPK24")).toBe(24);
    expect(extractPpk("PPK6")).toBe(6);
  });

  it("parses PPKn with whitespace, dash, or underscore", () => {
    expect(extractPpk("PPK 24")).toBe(24);
    expect(extractPpk("PPK-24")).toBe(24);
    expect(extractPpk("PPK_24")).toBe(24);
    expect(extractPpk("PPK  24")).toBe(24); // multi-space
  });

  it("parses PPKn embedded in longer strings", () => {
    expect(extractPpk("PPK24-Black")).toBe(24);
    expect(extractPpk("Tech Jogger PPK24 Special")).toBe(24);
    expect(extractPpk("RYB059430PPK24-Bark")).toBe(24);
  });

  it("is case-insensitive", () => {
    expect(extractPpk("ppk24")).toBe(24);
    expect(extractPpk("Ppk24")).toBe(24);
    expect(extractPpk("PpK 24")).toBe(24);
  });

  it("returns null when PPK has no number after it", () => {
    expect(extractPpk("RYB059430PPK")).toBeNull();
    expect(extractPpk("PPK")).toBeNull();
    expect(extractPpk("PPK-Black")).toBeNull();
  });

  it("returns null on null/undefined/empty", () => {
    expect(extractPpk(null)).toBeNull();
    expect(extractPpk(undefined)).toBeNull();
    expect(extractPpk("")).toBeNull();
  });

  it("returns null on string without PPK token", () => {
    expect(extractPpk("RYB1311 - Black")).toBeNull();
    expect(extractPpk("packaging note")).toBeNull(); // 'pack' is not 'PPK'
  });

  it("returns null when n is 0 or negative-pattern", () => {
    expect(extractPpk("PPK0")).toBeNull();
    // Negative number pattern won't match the regex (digits only after PPK).
  });
});

describe("ppkMultiplier — order of resolution", () => {
  it("checks color first", () => {
    expect(ppkMultiplier("PPK24", "PPK6", "PPK12", "PPK3")).toBe(24);
  });

  it("falls through to size when color is null/empty", () => {
    expect(ppkMultiplier(null, "PPK6", "PPK12", "PPK3")).toBe(6);
    expect(ppkMultiplier("", "PPK6", null, null)).toBe(6);
  });

  it("falls through to description, then style", () => {
    expect(ppkMultiplier(null, null, "PPK12", "PPK3")).toBe(12);
    expect(ppkMultiplier(null, null, null, "PPK3")).toBe(3);
  });

  it("returns 1 when nothing matches", () => {
    expect(ppkMultiplier(null, null, null, null)).toBe(1);
    expect(ppkMultiplier("Black", "M", "Tech Jogger", "RYB1311")).toBe(1);
  });

  it("ignores PPK with no number in earlier fields and falls through", () => {
    expect(ppkMultiplier("PPK", "PPK24", null, null)).toBe(24);
  });
});

describe("ppkMultiplierForAts — SKU + description fallbacks", () => {
  it("matches PPKn embedded in the SKU string", () => {
    expect(ppkMultiplierForAts("RYB059430PPK24 - Bark", null)).toBe(24);
    expect(ppkMultiplierForAts("RBB0185-03SFPPK6", null)).toBe(6);
  });

  it("matches PPKn embedded in the description when SKU has none", () => {
    expect(ppkMultiplierForAts("RYB1311 - Black", "Tech Jogger PPK12 Special")).toBe(12);
  });

  it("returns 1 for non-prepack SKUs", () => {
    expect(ppkMultiplierForAts("RYB1311 - Black", "Tech Jogger")).toBe(1);
    expect(ppkMultiplierForAts("RYB0412 - Cream Tonal Grizzly Camo", "Delano Messg Carg Shrt")).toBe(1);
  });

  it("returns 1 when both inputs are null", () => {
    expect(ppkMultiplierForAts(null, null)).toBe(1);
  });
});
