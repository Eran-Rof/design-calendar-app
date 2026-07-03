import { describe, expect, it } from "vitest";
import {
  extractPpk, ppkMultiplier, ppkMultiplierForAts,
  packTotal, explodePacks, packsToUnits,
} from "../index";

const PPK24 = [
  { size: "30", qty_per_pack: 2 },
  { size: "32", qty_per_pack: 4 },
  { size: "34", qty_per_pack: 6 },
  { size: "36", qty_per_pack: 6 },
  { size: "38", qty_per_pack: 4 },
  { size: "40", qty_per_pack: 2 },
];

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
    // Style carries 'PPK' identity, color carries the unit count.
    expect(ppkMultiplier("PPK24", "PPK6", "PPK12", "RYB1311PPK")).toBe(24);
  });

  it("falls through to size when color is null/empty", () => {
    expect(ppkMultiplier(null, "PPK6", "PPK12", "RYB1311PPK")).toBe(6);
    expect(ppkMultiplier("", "PPK6", null, "RYB1311PPK")).toBe(6);
  });

  it("falls through to description, then style-embedded unit count", () => {
    expect(ppkMultiplier(null, null, "PPK12", "RYB1311PPK")).toBe(12);
    expect(ppkMultiplier(null, null, null, "RYB1311PPK3")).toBe(3);
  });

  it("returns 1 when nothing matches", () => {
    expect(ppkMultiplier(null, null, null, null)).toBe(1);
    expect(ppkMultiplier("Black", "M", "Tech Jogger", "RYB1311")).toBe(1);
  });

  it("ignores PPK with no number in earlier fields and falls through", () => {
    expect(ppkMultiplier("PPK", "PPK24", null, "RYB1311PPK")).toBe(24);
  });

  it("identity gate — refuses to multiply when SKU, style, AND size all lack PPK", () => {
    // RYB059430 shares a style with the prepack RYB059430PPK but is itself
    // a non-prepack row. A stray 'PPK24' in description (cross-ref text,
    // master leakage) must not bloat its on-hand 24x — description alone
    // can never satisfy the gate.
    expect(ppkMultiplier(null, null, "see RYB059430PPK24 prepack", "RYB059430", "RYB059430")).toBe(1);
    // Color-only signal also refused — color is structured but historically
    // the master sometimes carries promo/marketing color values that aren't
    // a reliable prepack identity signal.
    expect(ppkMultiplier("PPK24", null, null, "RYB1311", "RYB1311")).toBe(1);
  });

  it("identity gate — accepts when SKU contains PPK", () => {
    expect(ppkMultiplier(null, "PPK24", null, null, "RYB059430PPK")).toBe(24);
  });

  it("identity gate — accepts when style contains PPK even if SKU doesn't", () => {
    // Edge case: ATS row's SKU may not carry the PPK marker but the
    // master-resolved style code does (e.g. variant SKU 'ABC-RED'
    // matches a master row whose style_code is 'ABCPPK').
    expect(ppkMultiplier(null, "PPK24", null, "ABCPPK", "ABC-RED")).toBe(24);
  });

  it("identity gate — accepts when size contains PPK (older sized-prepack styles)", () => {
    // Older styles like RCB1510NPT were sold in both eachs and prepacks;
    // the prepack-ness is encoded in the SIZE column (e.g. "PPK24") rather
    // than the style name. The eachs row carries a non-PPK size and must
    // stay at mult=1; the prepack row must pick up the size signal.
    expect(ppkMultiplier(null, "PPK24", null, "RCB1510NPT", "RCB1510NPT-BLK")).toBe(24);
    expect(ppkMultiplier(null, "M",     null, "RCB1510NPT", "RCB1510NPT-BLK")).toBe(1);
  });
});

describe("ppkMultiplierForAts — SKU + description fallbacks", () => {
  it("matches PPKn embedded in the SKU string", () => {
    expect(ppkMultiplierForAts("RYB059430PPK24 - Bark", null)).toBe(24);
    expect(ppkMultiplierForAts("RBB0185-03SFPPK6", null)).toBe(6);
  });

  it("identity gate — refuses to multiply when SKU has no PPK marker even if description does", () => {
    // Was previously expected to return 12; rejected now to fix the
    // bug where a non-prepack SKU like RYB059430 (which shares a style
    // with the prepack RYB059430PPK) would have its on-hand bloated
    // 24x because of stray PPK text in the description / cross-ref.
    expect(ppkMultiplierForAts("RYB1311 - Black", "Tech Jogger PPK12 Special")).toBe(1);
  });

  it("matches PPKn from description when the SKU itself signals prepack", () => {
    // SKU carries 'PPK' identity; the unit count comes from description.
    expect(ppkMultiplierForAts("RYB1311PPK - Black", "Tech Jogger PPK12 Special")).toBe(12);
  });

  it("returns 1 for non-prepack SKUs", () => {
    expect(ppkMultiplierForAts("RYB1311 - Black", "Tech Jogger")).toBe(1);
    expect(ppkMultiplierForAts("RYB0412 - Cream Tonal Grizzly Camo", "Delano Messg Carg Shrt")).toBe(1);
  });

  it("returns 1 when both inputs are null", () => {
    expect(ppkMultiplierForAts(null, null)).toBe(1);
  });
});

describe("packTotal — units in one pack", () => {
  it("sums the per-size quantities", () => {
    expect(packTotal(PPK24)).toBe(24);
  });
  it("ignores negative / zero ratios and handles empty", () => {
    expect(packTotal([{ size: "S", qty_per_pack: 3 }, { size: "M", qty_per_pack: -1 }, { size: "L", qty_per_pack: 0 }])).toBe(3);
    expect(packTotal([])).toBe(0);
  });
});

describe("explodePacks — N packs → per-size eaches", () => {
  it("multiplies every size ratio by the pack count", () => {
    expect(explodePacks(200, PPK24)).toEqual({
      "30": 400, "32": 800, "34": 1200, "36": 1200, "38": 800, "40": 400,
    });
  });
  it("one pack returns the raw composition", () => {
    expect(explodePacks(1, [{ size: "S", qty_per_pack: 2 }, { size: "M", qty_per_pack: 4 }])).toEqual({ S: 2, M: 4 });
  });
  it("drops sizes with a non-positive ratio", () => {
    expect(explodePacks(5, [{ size: "S", qty_per_pack: 2 }, { size: "M", qty_per_pack: 0 }])).toEqual({ S: 10 });
  });
  it("non-positive packs or empty composition → {}", () => {
    expect(explodePacks(0, PPK24)).toEqual({});
    expect(explodePacks(-3, PPK24)).toEqual({});
    expect(explodePacks(10, [])).toEqual({});
  });
});

describe("packsToUnits", () => {
  it("packs × pack units", () => {
    expect(packsToUnits(200, PPK24)).toBe(4800);
    expect(packsToUnits(1, PPK24)).toBe(24);
  });
  it("non-positive → 0", () => {
    expect(packsToUnits(0, PPK24)).toBe(0);
    expect(packsToUnits(-1, PPK24)).toBe(0);
  });
});
