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
});
