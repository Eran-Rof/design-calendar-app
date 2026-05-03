import { describe, it, expect, beforeEach } from "vitest";
import {
  __setCacheForTest,
  clearItemMasterCache,
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
      match_source: null,
    });
  });

  it("returns all-null without throwing when cache is empty", () => {
    clearItemMasterCache();
    const result = resolveStyle("X");
    expect(result).toEqual({
      category: null,
      sub_category: null,
      style: null,
      color: null,
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

    // ATS has the space; master has none.
    const atsHasSpace = resolveStyle("R7113 ED2 - Lt Brown", "R7113 ED2");
    expect(atsHasSpace.match_source).toBe("style");
    expect(atsHasSpace.style).toBe("R7113ED2");
    expect(atsHasSpace.category).toBe("Tops");

    // Inverse: master has the space; ATS dropped it.
    const atsDroppedSpace = resolveStyle("FOOBAR - Red", "FOOBAR");
    expect(atsDroppedSpace.match_source).toBe("style");
    expect(atsDroppedSpace.style).toBe("FOO BAR");
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
