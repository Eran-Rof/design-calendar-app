import { describe, it, expect } from "vitest";
import { pairPassesBuildFilter } from "../services/wholesaleForecastService";
import type { BuildFilter } from "../services/wholesaleForecastService";

// A "Cargo Shorts" style build filter (product-scoped).
const cargoFilter: BuildFilter = { group_name: "Cargo Shorts" };

const cargoItem = { style_code: "CARGO1", sku_code: "CARGO1-KHAKI", attributes: { group_name: "Cargo Shorts" } };
const denimItem = { style_code: "DENIM1", sku_code: "DENIM1-MEDIUMWASH", attributes: { group_name: "Denim" } };

describe("pairPassesBuildFilter — supply-only rows respect product filters", () => {
  it("keeps a real demand pair matching the product filter", () => {
    expect(pairPassesBuildFilter(cargoFilter, {
      isSupplyOnly: false, hasOpenRequest: false, customerId: "ross", item: cargoItem,
    })).toBe(true);
  });

  it("DROPS a supply-only row whose style is out of the product scope (denim)", () => {
    // The core fix: previously this returned true (supply-only exempt),
    // pulling denim into a Cargo Shorts build.
    expect(pairPassesBuildFilter(cargoFilter, {
      isSupplyOnly: true, hasOpenRequest: false, customerId: "__supply__", item: denimItem,
    })).toBe(false);
  });

  it("KEEPS a supply-only row that matches the product scope (cargo)", () => {
    expect(pairPassesBuildFilter(cargoFilter, {
      isSupplyOnly: true, hasOpenRequest: false, customerId: "__supply__", item: cargoItem,
    })).toBe(true);
  });

  it("keeps ALL supply-only rows when only a CUSTOMER filter is active (no product scope)", () => {
    const custOnly: BuildFilter = { customer_id: "ross" };
    expect(pairPassesBuildFilter(custOnly, {
      isSupplyOnly: true, hasOpenRequest: false, customerId: "__supply__", item: denimItem,
    })).toBe(true);
  });

  it("customer filter still drops a non-matching real demand pair", () => {
    const custOnly: BuildFilter = { customer_id: "ross" };
    expect(pairPassesBuildFilter(custOnly, {
      isSupplyOnly: false, hasOpenRequest: false, customerId: "walmart", item: cargoItem,
    })).toBe(false);
  });

  it("an open demand request always survives (real pair), even out of product scope", () => {
    expect(pairPassesBuildFilter(cargoFilter, {
      isSupplyOnly: false, hasOpenRequest: true, customerId: "ross", item: denimItem,
    })).toBe(true);
  });

  it("drops a supply-only row with missing attributes when a group filter is set", () => {
    const noAttrs = { style_code: "X1", sku_code: "X1-RED", attributes: null };
    expect(pairPassesBuildFilter(cargoFilter, {
      isSupplyOnly: true, hasOpenRequest: false, customerId: "__supply__", item: noAttrs,
    })).toBe(false);
  });

  // Multi-style filtered build: style_codes scopes to SEVERAL styles at once.
  it("style_codes keeps a pair whose style is in the selected set", () => {
    const multi: BuildFilter = { style_codes: ["CARGO1", "DENIM1"] };
    expect(pairPassesBuildFilter(multi, {
      isSupplyOnly: false, hasOpenRequest: false, customerId: "ross", item: denimItem,
    })).toBe(true);
  });

  it("style_codes drops a pair whose style is NOT in the selected set", () => {
    const multi: BuildFilter = { style_codes: ["CARGO1", "DENIM1"] };
    const other = { style_code: "JOGGER9", sku_code: "JOGGER9-BLK", attributes: {} };
    expect(pairPassesBuildFilter(multi, {
      isSupplyOnly: false, hasOpenRequest: false, customerId: "ross", item: other,
    })).toBe(false);
  });

  it("style_codes scopes supply-only rows too (only in-set styles survive)", () => {
    const multi: BuildFilter = { style_codes: ["CARGO1"] };
    expect(pairPassesBuildFilter(multi, {
      isSupplyOnly: true, hasOpenRequest: false, customerId: "__supply__", item: denimItem,
    })).toBe(false);
    expect(pairPassesBuildFilter(multi, {
      isSupplyOnly: true, hasOpenRequest: false, customerId: "__supply__", item: cargoItem,
    })).toBe(true);
  });

  // Every input dimension honors a multi-value array.
  it("customer_ids keeps in-set customers and drops out-of-set", () => {
    const f: BuildFilter = { customer_ids: ["ross", "walmart"] };
    expect(pairPassesBuildFilter(f, { isSupplyOnly: false, hasOpenRequest: false, customerId: "walmart", item: cargoItem })).toBe(true);
    expect(pairPassesBuildFilter(f, { isSupplyOnly: false, hasOpenRequest: false, customerId: "target", item: cargoItem })).toBe(false);
    // supply-only rows are customer-agnostic → survive a customer-only filter
    expect(pairPassesBuildFilter(f, { isSupplyOnly: true, hasOpenRequest: false, customerId: "__supply__", item: cargoItem })).toBe(true);
  });

  it("group_names + genders match any value in their set", () => {
    const f: BuildFilter = { group_names: ["Cargo Shorts", "Denim"], genders: ["M", "W"] };
    const menCargo = { style_code: "C1", sku_code: "C1", attributes: { group_name: "Cargo Shorts", gender: "M" } };
    const kidsCargo = { style_code: "C2", sku_code: "C2", attributes: { group_name: "Cargo Shorts", gender: "C" } };
    expect(pairPassesBuildFilter(f, { isSupplyOnly: false, hasOpenRequest: false, customerId: "ross", item: menCargo })).toBe(true);
    expect(pairPassesBuildFilter(f, { isSupplyOnly: false, hasOpenRequest: false, customerId: "ross", item: kidsCargo })).toBe(false); // gender C not in set
  });

  it("combines multiple array dimensions (AND across dims, OR within)", () => {
    const f: BuildFilter = { style_codes: ["CARGO1"], group_names: ["Cargo Shorts"] };
    expect(pairPassesBuildFilter(f, { isSupplyOnly: false, hasOpenRequest: false, customerId: "ross", item: cargoItem })).toBe(true);
    expect(pairPassesBuildFilter(f, { isSupplyOnly: false, hasOpenRequest: false, customerId: "ross", item: denimItem })).toBe(false); // right group? no — denim, and style not CARGO1
  });
});


import { seedFilterPairs, buildFilterHasProductScope } from "../services/wholesaleForecastService";

describe("seedFilterPairs — honor the filter even with no history", () => {
  const items = [
    { id: "ppk-blk", style_code: "RYB0412PPK", sku_code: "RYB0412PPK-BLKCAMO", attributes: { group_name: "Cargo Shorts" } },
    { id: "ppk-cha", style_code: "RYB0412PPK", sku_code: "RYB0412PPK-CHARCOAL", attributes: { group_name: "Cargo Shorts" } },
    { id: "base-blk", style_code: "RYB0412", sku_code: "RYB0412-BLACK", attributes: { group_name: "Cargo Shorts" } },
    { id: "denim", style_code: "DENIM1", sku_code: "DENIM1-MW", attributes: { group_name: "Denim" } },
  ];
  const cats = new Map<string, string | null>([["ppk-blk", "cat1"], ["ppk-cha", "cat1"], ["base-blk", "cat1"], ["denim", "cat2"]]);
  const SUPPLY = "supply-placeholder";

  it("seeds the filtered style's SKUs for the filtered customer when none exist", () => {
    const out = seedFilterPairs({
      existingPairs: [], filter: { customer_ids: ["burlington"], style_codes: ["RYB0412PPK"] },
      items, itemCategoryBySku: cats, supplyPlaceholder: SUPPLY,
    });
    expect(out.map((p) => `${p.customer_id}:${p.sku_id}`).sort())
      .toEqual(["burlington:ppk-blk", "burlington:ppk-cha"]);
    expect(out[0].category_id).toBe("cat1");
  });

  it("does not duplicate a pair that already exists", () => {
    const out = seedFilterPairs({
      existingPairs: [{ customer_id: "burlington", sku_id: "ppk-blk" }],
      filter: { customer_ids: ["burlington"], style_codes: ["RYB0412PPK"] },
      items, itemCategoryBySku: cats, supplyPlaceholder: SUPPLY,
    });
    expect(out.map((p) => p.sku_id)).toEqual(["ppk-cha"]);
  });

  it("only seeds SKUs matching the product filter (not denim / not base when PPK-only)", () => {
    const out = seedFilterPairs({
      existingPairs: [], filter: { customer_ids: ["burlington"], style_codes: ["RYB0412PPK"] },
      items, itemCategoryBySku: cats, supplyPlaceholder: SUPPLY,
    });
    expect(out.some((p) => p.sku_id === "denim" || p.sku_id === "base-blk")).toBe(false);
  });

  it("customer-only filter (no product scope) seeds nothing", () => {
    expect(buildFilterHasProductScope({ customer_ids: ["burlington"] })).toBe(false);
    expect(seedFilterPairs({
      existingPairs: [], filter: { customer_ids: ["burlington"] },
      items, itemCategoryBySku: cats, supplyPlaceholder: SUPPLY,
    })).toEqual([]);
  });

  it("no customer filter -> seeds under the run's real demand customers", () => {
    const out = seedFilterPairs({
      existingPairs: [{ customer_id: "ross", sku_id: "base-blk" }, { customer_id: SUPPLY, sku_id: "x" }],
      filter: { style_codes: ["RYB0412PPK"] },
      items, itemCategoryBySku: cats, supplyPlaceholder: SUPPLY,
    });
    // ross (real) gets the two PPK skus; supply placeholder is not used as a seed customer here.
    expect([...new Set(out.map((p) => p.customer_id))]).toEqual(["ross"]);
    expect(out.length).toBe(2);
  });

  it("no customer filter and no real customers -> falls back to the supply placeholder", () => {
    const out = seedFilterPairs({
      existingPairs: [], filter: { style_codes: ["RYB0412PPK"] },
      items, itemCategoryBySku: cats, supplyPlaceholder: SUPPLY,
    });
    expect([...new Set(out.map((p) => p.customer_id))]).toEqual([SUPPLY]);
  });
});
