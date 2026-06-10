import { describe, it, expect } from "vitest";
import {
  __setBrandCacheForTest,
  brandNameById,
  getAllBrandNames,
  isBrandsLoaded,
} from "../brandLookup";

describe("brandLookup", () => {
  it("resolves brand id → name and exposes the ordered option list", () => {
    __setBrandCacheForTest([
      { id: "id-rof", code: "ROF", name: "Ring of Fire", sort_order: 10 },
      { id: "id-pt",  code: "PT",  name: "Psycho Tuna",  sort_order: 20 },
    ]);
    expect(isBrandsLoaded()).toBe(true);
    expect(brandNameById("id-rof")).toBe("Ring of Fire");
    expect(brandNameById("id-pt")).toBe("Psycho Tuna");
    expect(getAllBrandNames()).toEqual(["Ring of Fire", "Psycho Tuna"]);
  });

  it("returns null for unknown or empty ids", () => {
    __setBrandCacheForTest([{ id: "id-rof", code: "ROF", name: "Ring of Fire", sort_order: 10 }]);
    expect(brandNameById("nope")).toBeNull();
    expect(brandNameById(null)).toBeNull();
    expect(brandNameById(undefined)).toBeNull();
  });

  it("de-dupes brand names in the option list", () => {
    __setBrandCacheForTest([
      { id: "a", code: "ROF", name: "Ring of Fire", sort_order: 10 },
      { id: "b", code: "ROF2", name: "Ring of Fire", sort_order: 20 },
    ]);
    expect(getAllBrandNames()).toEqual(["Ring of Fire"]);
  });
});
