import { describe, it, expect, beforeEach } from "vitest";
import {
  __setCacheForTest,
  clearItemMasterCache,
  getAllMasterStyles,
  resolveStyle,
} from "../itemMasterLookup";
import type { ItemMasterRecord } from "../itemMasterLookup";

function makeRecord(overrides: Partial<ItemMasterRecord> = {}): ItemMasterRecord {
  return {
    id: overrides.id ?? "id-" + (overrides.sku_code ?? "default"),
    sku_code: overrides.sku_code ?? "DEFAULT",
    style_code: overrides.style_code ?? null,
    color: overrides.color ?? null,
    size: overrides.size ?? null,
    description: overrides.description ?? null,
    brand_id: overrides.brand_id ?? null,
    attributes: overrides.attributes ?? null,
  };
}

describe("itemMasterLookup.resolveStyle", () => {
  beforeEach(() => {
    clearItemMasterCache();
  });

  it("hits by sku_code and returns master fields with match_source 'sku'", () => {
    __setCacheForTest([
      makeRecord({
        id: "1",
        sku_code: "RYB100 - Black",
        style_code: "RYB100",
        color: "Black",
        attributes: {
          group_name: "Tops",
          category_name: "Tees",
          gender: "Womens",
        },
      }),
      makeRecord({
        id: "2",
        sku_code: "RYB200 - Bark",
        style_code: "RYB200",
        color: "Bark",
        attributes: { group_name: "Bottoms", category_name: "Jeans" },
      }),
      makeRecord({
        id: "3",
        sku_code: "RYB300 - White",
        style_code: "RYB300",
        color: "White",
        attributes: { group_name: "Tops", category_name: "Polos" },
      }),
    ]);

    const result = resolveStyle("RYB100 - Black");
    expect(result).toEqual({
      category: "Tops",
      sub_category: "Tees",
      style: "RYB100",
      color: "Black",
      size: null,
      description: null,
      pack_size: 1,
      brand_id: null,
      gender: "Womens",
      match_source: "sku",
    });
  });

  it("normalizes the lookup sku before matching (whitespace + case in color portion)", () => {
    __setCacheForTest([
      makeRecord({
        id: "n1",
        sku_code: "ABC - Bark",
        style_code: "ABC",
        color: "Bark",
        attributes: { group_name: "Tops", category_name: "Tees" },
      }),
    ]);

    // Extra spaces and lowercase color — normalizeSku collapses spaces,
    // standardizes the dash spacing, and title-cases the color portion.
    const result = resolveStyle("ABC -  bark");
    expect(result.match_source).toBe("sku");
    expect(result.style).toBe("ABC");
    expect(result.color).toBe("Bark");
    expect(result.category).toBe("Tops");
    expect(result.sub_category).toBe("Tees");
  });

  it("falls back to style_code when sku misses", () => {
    __setCacheForTest([
      makeRecord({
        id: "s1",
        sku_code: "S100 - Black",
        style_code: "S100",
        color: "Black",
        attributes: { group_name: "Outerwear", category_name: "Jackets" },
      }),
    ]);

    const result = resolveStyle("MISS", "S100");
    expect(result).toEqual({
      category: "Outerwear",
      sub_category: "Jackets",
      style: "S100",
      color: "Black",
      size: null,
      description: null,
      pack_size: 1,
      brand_id: null,
      gender: null,
      match_source: "style",
    });
  });

  it("returns all-null with match_source null when nothing matches and no stylePart", () => {
    __setCacheForTest([
      makeRecord({ id: "x", sku_code: "FOO - Bar", style_code: "FOO", color: "Bar" }),
    ]);

    const result = resolveStyle("UNKNOWN-SKU");
    expect(result).toEqual({
      category: null,
      sub_category: null,
      style: null,
      color: null,
      size: null,
      description: null,
      pack_size: 1,
      brand_id: null,
      gender: null,
      match_source: null,
    });
  });

  it("resolves brand_id from the matched record, with style-level fallback", () => {
    __setCacheForTest([
      // Variant row carries its own brand_id.
      makeRecord({ id: "b1", sku_code: "BR100 - Black", style_code: "BR100", color: "Black", brand_id: "brand-pt" }),
      // Variant with no brand_id inherits from the style-level row.
      makeRecord({ id: "b2s", sku_code: "BR200", style_code: "BR200", brand_id: "brand-rof" }),
      makeRecord({ id: "b2v", sku_code: "BR200 - White", style_code: "BR200", color: "White", brand_id: null }),
    ]);
    expect(resolveStyle("BR100 - Black").brand_id).toBe("brand-pt");
    expect(resolveStyle("BR200 - White").brand_id).toBe("brand-rof"); // style-level fallback
  });

  it("resolves gender from the matched record, with style-level fallback", () => {
    __setCacheForTest([
      // Variant row carries its own gender.
      makeRecord({ id: "g1", sku_code: "GN100 - Black", style_code: "GN100", color: "Black", attributes: { gender: "M" } }),
      // Variant with empty attributes inherits gender from the style-level row.
      makeRecord({ id: "g2s", sku_code: "GN200", style_code: "GN200", attributes: { gender: "WMS" } }),
      makeRecord({ id: "g2v", sku_code: "GN200 - White", style_code: "GN200", color: "White", attributes: {} }),
    ]);
    expect(resolveStyle("GN100 - Black").gender).toBe("M");
    expect(resolveStyle("GN200 - White").gender).toBe("WMS"); // style-level fallback
  });

  it("returns all-null without throwing when cache is empty", () => {
    clearItemMasterCache();
    const result = resolveStyle("X");
    expect(result).toEqual({
      category: null,
      sub_category: null,
      style: null,
      color: null,
      size: null,
      description: null,
      pack_size: 1,
      brand_id: null,
      gender: null,
      match_source: null,
    });
  });

  it("style fallback is deterministic — picks lexicographically smallest sku_code regardless of injection order", () => {
    const recA = makeRecord({
      id: "a",
      sku_code: "S100-A",
      style_code: "S100",
      color: "Aqua",
      attributes: { group_name: "Tops", category_name: "Tees" },
    });
    const recB = makeRecord({
      id: "b",
      sku_code: "S100-B",
      style_code: "S100",
      color: "Blue",
      attributes: { group_name: "Tops", category_name: "Tees" },
    });

    // Inject A then B → expect A (smaller sku_code) wins.
    __setCacheForTest([recA, recB]);
    const r1 = resolveStyle("MISS", "S100");
    expect(r1.match_source).toBe("style");
    expect(r1.color).toBe("Aqua");

    // Inject B then A → still expect A.
    clearItemMasterCache();
    __setCacheForTest([recB, recA]);
    const r2 = resolveStyle("MISS", "S100");
    expect(r2.match_source).toBe("style");
    expect(r2.color).toBe("Aqua");
  });

  it("style fallback prefers the canonical style-level row with populated attributes over empty-attribute variants", () => {
    // Mirrors live master shape: variant rows like "RYB0185-BLKCAMO" have
    // empty {} attributes while the canonical "RYB0185" row carries the
    // group_name / category_name. The resolver must pick the populated one.
    const variantA = makeRecord({
      id: "var-a",
      sku_code: "RYB0185-BLKCAMO",
      style_code: "RYB0185",
      color: null,
      attributes: {},
    });
    const variantB = makeRecord({
      id: "var-b",
      sku_code: "RYB0185-OLIVE",
      style_code: "RYB0185",
      color: null,
      attributes: {},
    });
    const canonical = makeRecord({
      id: "canon",
      sku_code: "RYB0185",
      style_code: "RYB0185",
      color: "Blk Camo",
      attributes: { group_name: "DENIM", category_name: "SLIM" },
    });

    // Inject in a few orders — populated row should win every time.
    for (const order of [[variantA, variantB, canonical], [canonical, variantA, variantB], [variantA, canonical, variantB]]) {
      clearItemMasterCache();
      __setCacheForTest(order);
      const r = resolveStyle("MISS", "RYB0185");
      expect(r.match_source).toBe("style");
      expect(r.category).toBe("DENIM");
      expect(r.sub_category).toBe("SLIM");
    }
  });

  it("style fallback strips whitespace — ATS 'R7113 ED2' matches master 'R7113ED2', and the reverse", () => {
    __setCacheForTest([
      makeRecord({
        id: "no-space",
        sku_code: "R7113ED2",
        style_code: "R7113ED2",
        color: "Black",
        attributes: { group_name: "Tops", category_name: "Tees" },
      }),
      makeRecord({
        id: "with-space",
        sku_code: "FOO BAR - Red",
        style_code: "FOO BAR",
        color: "Red",
        attributes: { group_name: "Bottoms" },
      }),
    ]);

    // ATS has the space; master has none. Master's sku_code is just
    // "R7113ED2" (no color suffix) so the sku-level canonical alias
    // can't help here — the lookup falls through to the style index
    // which is whitespace-tolerant.
    const atsHasSpace = resolveStyle("R7113 ED2 - Lt Brown", "R7113 ED2");
    expect(atsHasSpace.match_source).toBe("style");
    expect(atsHasSpace.style).toBe("R7113ED2");
    expect(atsHasSpace.category).toBe("Tops");

    // Inverse: master has the space inside the style portion of
    // sku_code ("FOO BAR - Red"). canonSku strips whitespace so the
    // canonical alias "FOOBAR-RED" matches the ATS query "FOOBAR - Red"
    // → "FOOBAR-RED" — sku-level match (a stronger result than the
    // style fallback).
    const atsDroppedSpace = resolveStyle("FOOBAR - Red", "FOOBAR");
    expect(atsDroppedSpace.match_source).toBe("sku");
    expect(atsDroppedSpace.style).toBe("FOO BAR");
  });

  it("propagates the size field through the resolver — needed for PPK detection in compute.ts", () => {
    __setCacheForTest([
      makeRecord({
        id: "ppk",
        sku_code: "RYB1637SHPPK - Black",
        style_code: "RYB1637SHPPK",
        color: "Black",
        size: "PPK24",
        attributes: { group_name: "Bottoms" },
      }),
    ]);
    const r = resolveStyle("RYB1637SHPPK - Black");
    expect(r.size).toBe("PPK24");
    // PPK detection in compute.ts will use this size value to compute
    // the multiplier (24 in this case).
  });

  it("strips trailing -PPKn (and -PPKn-COLOR) suffix from master sku_code so ATS rows without the size suffix still match", () => {
    // Real-world shape from ip_item_master: the master ingest baked
    // the PPK size into the sku_code ("RYG1842PPK-BLACK-PPK60"), and
    // the variant pass appended color again
    // ("RYO0822PPK-BLACK/SALSA-PPK18-BLACK/SALSA"). Xoro returns the
    // ATS row's SKU as just "STYLE - Color" without the size suffix,
    // so the bare canonSku lookup misses. The PPK-strip alias
    // resolves both shapes against the same ATS query.
    __setCacheForTest([
      makeRecord({
        id: "ppk60",
        sku_code: "RYG1842PPK-BLACK-PPK60",
        style_code: "RYG1842PPK-BLACK-PPK60",
        color: "Black",
        size: "PPK60",
        attributes: { group_name: "Tops" },
      }),
      makeRecord({
        id: "ppk18-variant-shape",
        sku_code: "RYO0822PPK-BLACK/SALSA-PPK18-BLACK/SALSA",
        style_code: "RYO0822PPK-BLACK/SALSA-PPK18",
        color: "Black/Salsa",
        size: "PPK18",
        attributes: { group_name: "Tops" },
      }),
    ]);

    // Bare (style, color) — no size suffix in the ATS sku.
    const r60 = resolveStyle("RYG1842PPK - Black");
    expect(r60.match_source).toBe("sku");
    expect(r60.size).toBe("PPK60");

    // Same for the variant-shape sku_code with the appended color.
    const r18 = resolveStyle("RYO0822PPK - Black/Salsa");
    expect(r18.match_source).toBe("sku");
    expect(r18.size).toBe("PPK18");
  });

  it("style fallback is case-insensitive — lowercase or mixed-case style parts hit uppercase master rows", () => {
    __setCacheForTest([
      makeRecord({
        id: "ryb",
        sku_code: "RYB0335 - Navy",
        style_code: "RYB0335",
        color: "Navy",
        attributes: { group_name: "Bottoms", category_name: "Jeans" },
      }),
      makeRecord({
        id: "ptyg",
        sku_code: "PTYG0003LSTD - Blue",
        style_code: "PTYG0003LSTD",
        color: "Blue",
        attributes: { group_name: "Tops" },
      }),
    ]);

    // Lowercase ATS style part should still match uppercase master.
    const lower = resolveStyle("ryb0335 - dull gold", "ryb0335");
    expect(lower.match_source).toBe("style");
    expect(lower.style).toBe("RYB0335");
    expect(lower.category).toBe("Bottoms");

    // Mixed-case style part too.
    const mixed = resolveStyle("PTYG0003lstd - whatever", "PTYG0003lstd");
    expect(mixed.match_source).toBe("style");
    expect(mixed.style).toBe("PTYG0003LSTD");
  });
});

describe("itemMasterLookup.getAllMasterStyles", () => {
  beforeEach(() => {
    clearItemMasterCache();
  });

  it("returns [] before the cache loads", () => {
    expect(getAllMasterStyles()).toEqual([]);
  });

  it("enumerates distinct style codes with clean style-level descriptions (variants + whitespace aliases collapse)", () => {
    __setCacheForTest([
      // Style-level row carries the clean description.
      makeRecord({
        id: "s1",
        sku_code: "RYB1893",
        style_code: "RYB1893",
        description: "La Virgen",
        attributes: { group_name: "SHORTS", category_name: "DENIM SHORTS" },
      }),
      // Variant rows of the same style must NOT create extra entries.
      makeRecord({
        id: "v1",
        sku_code: "RYB189312-WAVECREST-MEDWASHWTINT",
        style_code: "RYB1893",
        color: "Wavecrest - Medium Wash W Tint",
        description: "dirty composite RYB189312-Wavecrest-32",
      }),
      // A style whose code contains whitespace — buildIndexes stores a
      // space-stripped alias key; the enumeration must not emit it twice.
      makeRecord({
        id: "s2",
        sku_code: "AB 100",
        style_code: "AB 100",
        description: "Spaced Style",
      }),
    ]);

    const styles = getAllMasterStyles();
    const codes = styles.map(s => s.code).sort();
    expect(codes).toEqual(["AB 100", "RYB1893"]);
    expect(styles.find(s => s.code === "RYB1893")?.description).toBe("La Virgen");
  });
});
