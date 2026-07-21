import { describe, it, expect } from "vitest";
import { colorGroupKey, titleCaseColor } from "../colorGroup";

describe("colorGroupKey — case-folded grouping key", () => {
  it("folds case and trims so spellings of one colorway collapse", () => {
    expect(colorGroupKey("BLACK")).toBe("BLACK");
    expect(colorGroupKey("Black")).toBe("BLACK");
    expect(colorGroupKey(" black ")).toBe("BLACK");
    expect(colorGroupKey("Black")).toBe(colorGroupKey("BLACK"));
    expect(colorGroupKey("Grey")).toBe(colorGroupKey("GREY"));
  });

  it("returns '' for null / undefined / blank (callers apply their own '—')", () => {
    expect(colorGroupKey(null)).toBe("");
    expect(colorGroupKey(undefined)).toBe("");
    expect(colorGroupKey("   ")).toBe("");
  });

  it("keeps genuinely different colors distinct", () => {
    expect(colorGroupKey("Navy") === colorGroupKey("Black")).toBe(false);
  });
});

describe("titleCaseColor — plain word-wise Title Case for display", () => {
  it("title-cases single words regardless of the input case", () => {
    expect(titleCaseColor("BLACK")).toBe("Black");
    expect(titleCaseColor("black")).toBe("Black");
    expect(titleCaseColor("bLaCk")).toBe("Black");
    expect(titleCaseColor("Grey")).toBe("Grey");
  });

  it("title-cases each whitespace-separated word (multi-word)", () => {
    expect(titleCaseColor("LIGHT WASH")).toBe("Light Wash");
    expect(titleCaseColor("medium wash")).toBe("Medium Wash");
    expect(titleCaseColor("Neptune - Medium Wash")).toBe("Neptune - Medium Wash");
  });

  it("is CASE-ONLY: it does NOT expand abbreviations (that is canonColor's job)", () => {
    // "Lt" stays "Lt" (word-wise title case), it is NOT expanded to "Light".
    expect(titleCaseColor("Lt Wash")).toBe("Lt Wash");
    expect(titleCaseColor("LT WASH")).toBe("Lt Wash");
    // "wTint" is a single token (no whitespace) → first letter upper, rest lower.
    expect(titleCaseColor("wTint")).toBe("Wtint");
    // Only whitespace splits words; '/' does not, so a slash color is one token.
    expect(titleCaseColor("NAVY/PEACH")).toBe("Navy/peach");
  });

  it("collapses case variants to the SAME display string (the merge guarantee)", () => {
    expect(titleCaseColor("BLACK")).toBe(titleCaseColor("Black"));
    expect(titleCaseColor("GREY")).toBe(titleCaseColor("grey"));
    expect(titleCaseColor("Lt Wash")).toBe(titleCaseColor("LT WASH"));
  });

  it("returns '' for null / undefined / blank", () => {
    expect(titleCaseColor(null)).toBe("");
    expect(titleCaseColor(undefined)).toBe("");
    expect(titleCaseColor("   ")).toBe("");
  });
});
