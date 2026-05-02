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
          sub_category_name: "Tees",
          category_name: "Apparel",
          gender: "Womens",
        },
      }),
      makeRecord({
        id: "2",
        sku_code: "RYB200 - Bark",
        style_code: "RYB200",
        color: "Bark",
        attributes: { group_name: "Bottoms", sub_category_name: "Jeans" },
      }),
      makeRecord({
        id: "3",
        sku_code: "RYB300 - White",
        style_code: "RYB300",
        color: "White",
        attributes: { group_name: "Tops", sub_category_name: "Polos" },
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
        attributes: { group_name: "Tops", sub_category_name: "Tees" },
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
        attributes: { group_name: "Outerwear", sub_category_name: "Jackets" },
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
      attributes: { group_name: "Tops", sub_category_name: "Tees" },
    });
    const recB = makeRecord({
      id: "b",
      sku_code: "S100-B",
      style_code: "S100",
      color: "Blue",
      attributes: { group_name: "Tops", sub_category_name: "Tees" },
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
});
