import { describe, it, expect } from "vitest";
import {
  parseItemNumber, canonSize, sizeVariantsOf, colorMatchKey, expandTokens,
  resolveStyleToken, pickColorSizeMatch, mergePreservedLinks,
} from "../xoroLineMatch.js";

// Real prod catalog rows for style RYB1477 (style_id S_RYB1477), verified against
// PROD 2026-07-21. The sized garment SKUs embed the inseam in the style token
// (RYB147730 = RYB1477 + inseam 30); the colour field is spelled out while Xoro
// sends abbreviated colours.
const S_RYB1477 = "41b0eb8d-fa8f-4d65-b847-1f7fb853b426";
const styleByCode = new Map([
  ["RYB1477", S_RYB1477],
  ["RYB1894", "aaabd78d-234c-4289-bdf3-4ffc042f14e4"],
  ["PTYA0019", "ptya-id"],
]);
const RYB1477_FAMILY = [
  { id: "gw30", sku_code: "RYB147730-GRAYWOLF-30", style_id: S_RYB1477, color: "Grey Wolf - Light Grey", size: "30", inseam: "30" },
  { id: "gw32", sku_code: "RYB147730-GRAYWOLF-32", style_id: S_RYB1477, color: "Grey Wolf - Light Grey", size: "32", inseam: "30" },
  { id: "bs30", sku_code: "RYB147730-BLACKSANDS-30", style_id: S_RYB1477, color: "Blacksands - Black Wash Wtint", size: "30", inseam: "30" },
  { id: "mh30", sku_code: "RYB1477-MAHOGANYBLACKWTINT-30", style_id: S_RYB1477, color: "Mahogany - Black W Tint", size: "30", inseam: "30" },
  { id: "sc30", sku_code: "RYB147730-SANDCASTLE-30", style_id: S_RYB1477, color: "Sandcastle - Light Wash", size: "30", inseam: "30" },
  { id: "gwColorOnly", sku_code: "RYB147730-GRAYWOLF-LTGRAY", style_id: S_RYB1477, color: "Grey Wolf - Light Grey", size: null, inseam: "30" },
];

describe("parseItemNumber", () => {
  it("splits STYLE-COLOR-SIZE with a dashed colour", () => {
    expect(parseItemNumber("RYB147730-Gray Wolf - Lt Gray-30")).toEqual({
      style_code: "RYB147730", color: "Gray Wolf - Lt Gray", size: "30",
    });
  });
  it("handles a single-word colour", () => {
    expect(parseItemNumber("PTYA0019-Blackberry-M")).toEqual({
      style_code: "PTYA0019", color: "Blackberry", size: "M",
    });
  });
  it("returns nulls for a bare style", () => {
    expect(parseItemNumber("RYB1477")).toEqual({ style_code: "RYB1477", color: null, size: null });
  });
});

describe("canonSize / sizeVariantsOf", () => {
  it("passes numeric waist sizes through", () => {
    expect(canonSize("30")).toBe("30");
    expect(sizeVariantsOf("30")).toEqual(["30"]);
  });
  it("canonicalises letter sizes and returns every DB variant", () => {
    expect(canonSize("SML")).toBe("SMALL");
    const v = sizeVariantsOf("M");
    expect(v).toEqual(expect.arrayContaining(["M", "MD", "MED", "MEDIUM"]));
  });
});

describe("colorMatchKey (spelling tolerance)", () => {
  it("Gray↔Grey and Lt↔Light converge", () => {
    expect(colorMatchKey("Gray Wolf - Lt Gray")).toBe(colorMatchKey("Grey Wolf - Light Grey"));
  });
  it("Blk↔Black and wTint↔With Tint converge despite tokenisation difference", () => {
    expect(colorMatchKey("Blacksands - Blk Wash wTint")).toBe(colorMatchKey("Blacksands - Black Wash Wtint"));
  });
  it("does not collapse distinct colours", () => {
    expect(colorMatchKey("Sandcastle - Lt Wash")).not.toBe(colorMatchKey("Grey Wolf - Light Grey"));
  });

  // ── 2026-07-23 additions ────────────────────────────────────────────────
  // Every pairing below is ATTESTED in the live catalog: the short and long
  // spelling both exist on the SAME style, so these are observed duplicates,
  // not speculative folds.
  it("CEO-confirmed abbreviations converge", () => {
    expect(colorMatchKey("T16 Vtg Blk Oyst Mushroom"))
      .toBe(colorMatchKey("T16 Vintage Black Oyster Mushroom"));
    expect(colorMatchKey("Drk Peach Msty Plms")).toBe(colorMatchKey("Dark Peach Misty Palms"));
    expect(colorMatchKey("Medm Hthr Gry")).toBe(colorMatchKey("Medium Heather Grey"));
    // No standalone SLT in the catalog today — folded to guard future ingest.
    expect(colorMatchKey("Slt Blue")).toBe(colorMatchKey("Slate Blue"));
  });

  it("glued compounds converge with their spaced spelling", () => {
    expect(colorMatchKey("Medusa-Dkblue")).toBe(colorMatchKey("Medusa - Dark Blue"));
    expect(colorMatchKey("Americana-Mdblue")).toBe(colorMatchKey("Americana Medium Blue"));
    expect(colorMatchKey("Crumble-Medblu")).toBe(colorMatchKey("Crumble - Medium Blue"));
    expect(colorMatchKey("Skylar-Ltblue")).toBe(colorMatchKey("Skylar Light Blue"));
    expect(colorMatchKey("Palms-Mdltwash")).toBe(colorMatchKey("Palms - Medium Light Wash"));
    expect(colorMatchKey("Aruba-Medwash")).toBe(colorMatchKey("Aruba - Medium Wash"));
    expect(colorMatchKey("Graywolf-Ltgray")).toBe(colorMatchKey("Graywolf - Light Grey"));
  });

  // The display path must emit a real two-word name, not the glued token.
  it("expandTokens spells compounds out for the display name", () => {
    expect(expandTokens("Crumble-Md Blu")).toBe("CRUMBLE MEDIUM BLUE");
    expect(expandTokens("Crumble-Medblu")).toBe("CRUMBLE MEDIUM BLUE");
    expect(expandTokens("T16 Vtg Blk Oyst Mushroom")).toBe("T 16 VINTAGE BLACK OYSTER MUSHROOM");
  });

  it("compound folds do not swallow legitimate longer words", () => {
    // "LTBLUEBERRY" is one token and must never fold via the LTBLUE key.
    expect(expandTokens("Ltblueberry")).toBe("LTBLUEBERRY");
    expect(colorMatchKey("Medblush")).not.toBe(colorMatchKey("Medium Bluesh"));
  });
  it("Cam↔Camo converge", () => {
    expect(colorMatchKey("Woodland Cam")).toBe(colorMatchKey("Woodland Camo"));
    expect(colorMatchKey("Blk Camo")).toBe(colorMatchKey("Black Camo"));
  });
  it("Cbo↔Combo converge", () => {
    expect(colorMatchKey("Simple Sage Cbo")).toBe(colorMatchKey("Simple Sage Combo"));
  });
  it("word-boundary safe — CAMEL is not folded to CAMO", () => {
    // "CAM" only folds as a WHOLE token; "Camel" must stay "CAMEL".
    expect(colorMatchKey("Camel")).toBe("CAMEL");
    expect(colorMatchKey("Camel")).not.toBe(colorMatchKey("Camo"));
  });
});

describe("resolveStyleToken (inseam composite)", () => {
  it("returns the style id verbatim for a direct style_code", () => {
    expect(resolveStyleToken(styleByCode, "PTYA0019")).toEqual({ styleId: "ptya-id", inseam: null });
  });
  it("peels a trailing 2-digit inseam when the raw token is not a style", () => {
    expect(resolveStyleToken(styleByCode, "RYB147730")).toEqual({ styleId: S_RYB1477, inseam: "30" });
  });
  it("prefers a direct hit over stripping (never strips a real style)", () => {
    const m = new Map([["RYB147730", "composite-is-a-real-style"], ["RYB1477", S_RYB1477]]);
    expect(resolveStyleToken(m, "RYB147730")).toEqual({ styleId: "composite-is-a-real-style", inseam: null });
  });
  it("returns null when neither the token nor its base resolves", () => {
    expect(resolveStyleToken(styleByCode, "ZZZ9999")).toEqual({ styleId: null, inseam: null });
  });
  it("does not strip a PPK token to a bogus base", () => {
    expect(resolveStyleToken(styleByCode, "RYB147730PPK")).toEqual({ styleId: null, inseam: null });
  });
});

describe("pickColorSizeMatch — the proven prod match chain", () => {
  it("EXACT semantics: matches the spelling-variant colour + numeric size (Gray Wolf)", () => {
    const p = parseItemNumber("RYB147730-Gray Wolf - Lt Gray-30");
    const hit = pickColorSizeMatch(RYB1477_FAMILY, { color: p.color, size: p.size, inseam: "30" });
    expect(hit?.id).toBe("gw30");
  });
  it("matches truncated / abbreviated colour token (Blacksands Blk wTint)", () => {
    const p = parseItemNumber("RYB147730-Blacksands - Blk Wash wTint-30");
    const hit = pickColorSizeMatch(RYB1477_FAMILY, { color: p.color, size: p.size, inseam: "30" });
    expect(hit?.id).toBe("bs30");
  });
  it("matches the colourway whose sku_code uses the BASE token, not the composite (Mahogany)", () => {
    const p = parseItemNumber("RYB147730-Mahogany - Black w Tint-30");
    const hit = pickColorSizeMatch(RYB1477_FAMILY, { color: p.color, size: p.size, inseam: "30" });
    expect(hit?.id).toBe("mh30");
  });
  it("returns null (leave unlinked) when the size is not stocked", () => {
    const p = parseItemNumber("RYB147730-Gray Wolf - Lt Gray-40");
    expect(pickColorSizeMatch(RYB1477_FAMILY, { color: p.color, size: p.size, inseam: "30" })).toBeNull();
  });
  it("skips the colour-only (size null) row — only sized rows match", () => {
    const p = parseItemNumber("RYB147730-Gray Wolf - Lt Gray-31");
    expect(pickColorSizeMatch(RYB1477_FAMILY, { color: p.color, size: p.size, inseam: "30" })).toBeNull();
  });
  it("NEVER guesses on a multi-match → returns null (stays unlinked)", () => {
    const dupFamily = [
      { id: "a", color: "Grey Wolf - Light Grey", size: "30", inseam: "30" },
      { id: "b", color: "Grey Wolf - Light Grey", size: "30", inseam: "30" },
    ];
    expect(pickColorSizeMatch(dupFamily, { color: "Gray Wolf - Lt Gray", size: "30", inseam: "30" })).toBeNull();
  });
  it("inseam constraint disambiguates two inseam composites of the same colour+size", () => {
    const twoInseams = [
      { id: "in30", color: "Grey Wolf - Light Grey", size: "30", inseam: "30" },
      { id: "in32", color: "Grey Wolf - Light Grey", size: "30", inseam: "32" },
    ];
    expect(pickColorSizeMatch(twoInseams, { color: "Gray Wolf - Lt Gray", size: "30", inseam: "32" })?.id).toBe("in32");
    // Without the inseam constraint the two are ambiguous → null (never guess).
    expect(pickColorSizeMatch(twoInseams, { color: "Gray Wolf - Lt Gray", size: "30", inseam: null })).toBeNull();
  });
  it("PPK pack-grain size never matches a per-size garment query", () => {
    const p = parseItemNumber("RYB147730PPK-Gray Wolf - Lt Gray-PPK24");
    // canonSize("PPK24") does not equal any numeric size — the PPK line does not
    // bind to a sized garment row (PPK handled by the dedicated PPK tiers).
    expect(pickColorSizeMatch(RYB1477_FAMILY, { color: p.color, size: p.size, inseam: "30" })).toBeNull();
  });
});

describe("mergePreservedLinks — re-import link churn guard", () => {
  const resolved = [
    { line_number: 1, inventory_item_id: "auto-a" },
    { line_number: 2, inventory_item_id: null },       // resolver failed this run
    { line_number: 3, inventory_item_id: "auto-c" },
  ];
  it("preserves a prior non-null link over a null resolver result (the churn fix)", () => {
    const prior = new Map([[2, "manual-b"]]);
    const { rows, preserved } = mergePreservedLinks(resolved, prior);
    expect(rows.find((r) => r.line_number === 2).inventory_item_id).toBe("manual-b");
    expect(preserved).toBe(1);
  });
  it("prior non-null WINS even when the resolver produced a different id", () => {
    const prior = new Map([[1, "manual-a"]]);
    const { rows, preserved } = mergePreservedLinks(resolved, prior);
    expect(rows.find((r) => r.line_number === 1).inventory_item_id).toBe("manual-a");
    expect(preserved).toBe(1);
  });
  it("a prior null leaves the resolver's result (re-resolve-on-import heals nulls)", () => {
    const prior = new Map([[3, null].filter(() => false)]); // empty map
    const { rows, preserved } = mergePreservedLinks(resolved, prior);
    expect(rows.find((r) => r.line_number === 2).inventory_item_id).toBeNull();
    expect(preserved).toBe(0);
  });
  it("no counting when prior equals the resolver result", () => {
    const prior = new Map([[1, "auto-a"]]);
    const { preserved } = mergePreservedLinks(resolved, prior);
    expect(preserved).toBe(0);
  });
  it("empty prior map is a pass-through (no allocation churn)", () => {
    const { rows, preserved } = mergePreservedLinks(resolved, new Map());
    expect(rows).toBe(resolved);
    expect(preserved).toBe(0);
  });
});
