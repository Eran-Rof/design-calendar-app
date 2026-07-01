import { describe, it, expect } from "vitest";
import { canonColor } from "../styleMatrix.js";

describe("canonColor", () => {
  it("collapses case variants to one canonical label", () => {
    expect(canonColor("Black")).toBe(canonColor("BLACK"));
    expect(canonColor("Black")).toBe("Black");
    expect(canonColor("Vallarta Blue")).toBe(canonColor("VALLARTA BLUE"));
  });

  it("collapses the Light↔Lt abbreviation (the ROF-P001132 split)", () => {
    expect(canonColor("SKYFALL - Light Wash")).toBe(canonColor("SKYFALL - Lt Wash"));
    expect(canonColor("SKYFALL - Light Wash")).toBe("Skyfall Light Wash");
    expect(canonColor("Light Brown")).toBe(canonColor("LT BROWN"));
    expect(canonColor("Buenos Aires - Light Wash")).toBe(canonColor("Buenos Aires - Lt Wash"));
  });

  it("collapses with↔w and punctuation/spacing", () => {
    expect(canonColor("Open Sea - Light Wash w Tint")).toBe(canonColor("Open Sea - Lt Wash with Tint"));
    expect(canonColor("Navy/Peach")).toBe(canonColor("NAVY/PEACH"));
    expect(canonColor("Forget-Me-Not")).toBe(canonColor("FORGET-ME-NOT"));
    expect(canonColor("Forget-Me-Not")).toBe("Forget Me Not");
  });

  it("only expands whole-word abbreviations (no partial hits)", () => {
    // 'lt' inside 'Salt' must NOT expand to 'Light'.
    expect(canonColor("Salt Wash")).toBe("Salt Wash");
    // 'w' inside 'Willow' must NOT expand to 'with'.
    expect(canonColor("Willow")).toBe("Willow");
  });

  it("passes through null/empty and trims", () => {
    expect(canonColor(null)).toBe(null);
    expect(canonColor("")).toBe("");
    expect(canonColor("  Red  ")).toBe("Red");
  });
});
