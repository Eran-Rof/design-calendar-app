import { describe, it, expect } from "vitest";
import { repairSizeCell } from "../inventory/restCsvSize.js";

describe("repairSizeCell — Xoro kids age-range comma corruption", () => {
  // The five corrupted shapes actually present in the REST feed.
  const cases = [
    ["DEEP BLACK-XS(5", "6)", "DEEP BLACK", "XS(5-6)"],
    ["DEEP BLACK-S(7", "8)", "DEEP BLACK", "S(7-8)"],
    ["DEEP BLACK-M(10", "12)", "DEEP BLACK", "M(10-12)"],
    ["DEEP BLACK-L(14", "16)", "DEEP BLACK", "L(14-16)"],
    ["DEEP BLACK-XL(18", "20)", "DEEP BLACK", "XL(18-20)"],
  ];
  it.each(cases)("repairs (%s | %s) -> color=%s size=%s", (c, s, color, size) => {
    const r = repairSizeCell(c, s);
    expect(r.repaired).toBe(true);
    expect(r.color).toBe(color);
    expect(r.size).toBe(size);
  });

  it("preserves colors with internal spaces and dashes", () => {
    expect(repairSizeCell("Harbor - Med Wash-XS(5", "6)")).toEqual({
      color: "Harbor - Med Wash",
      size: "XS(5-6)",
      repaired: true,
    });
    expect(repairSizeCell("Millie Wash-XL(18", "20)")).toEqual({
      color: "Millie Wash",
      size: "XL(18-20)",
      repaired: true,
    });
  });

  it("leaves normal (color,size) cells untouched", () => {
    expect(repairSizeCell("Grey", "30")).toEqual({ color: "Grey", size: "30", repaired: false });
    expect(repairSizeCell("DEEP BLACK", "M")).toEqual({ color: "DEEP BLACK", size: "M", repaired: false });
    expect(repairSizeCell("Charcoal", "PPK48")).toEqual({ color: "Charcoal", size: "PPK48", repaired: false });
  });

  it("does not mangle colors that legitimately contain digits", () => {
    // tie-dye pattern names ("T20 Oceanic Blues"), camo ("Snd Camo4") — no
    // trailing "-<label>(<digit>" + "<digit>)" pair, so untouched.
    expect(repairSizeCell("T20 Oceanic Blues", "L")).toEqual({
      color: "T20 Oceanic Blues", size: "L", repaired: false,
    });
    expect(repairSizeCell("Snd Camo4", "30")).toEqual({
      color: "Snd Camo4", size: "30", repaired: false,
    });
    expect(repairSizeCell("Blanco V2", "")).toEqual({
      color: "Blanco V2", size: "", repaired: false,
    });
  });

  it("requires BOTH halves of the signature (no false positives on one alone)", () => {
    // color tail present but size is a real size -> untouched
    expect(repairSizeCell("DEEP BLACK-XS(5", "M").repaired).toBe(false);
    // size looks like a bound but color has no open-paren tail -> untouched
    expect(repairSizeCell("DEEP BLACK", "6)").repaired).toBe(false);
  });

  it("handles null / undefined defensively", () => {
    expect(repairSizeCell(null, null)).toEqual({ color: "", size: "", repaired: false });
    expect(repairSizeCell(undefined, undefined)).toEqual({ color: "", size: "", repaired: false });
  });
});
