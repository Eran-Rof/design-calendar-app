import { describe, it, expect } from "vitest";
import {
  canonicalizeSku,
  canonicalizeStyleCode,
  deriveStyleFromSku,
  canonicalizeCustomerName,
  canonicalizeCategory,
  canonicalizeChannelCode,
  canonicalizeVendorName,
} from "../mapping/canonicalKeys";

describe("canonicalizeSku", () => {
  it("uppercases and trims", () => {
    expect(canonicalizeSku("  abc-01 ")).toBe("ABC-01");
  });
  it("preserves punctuation", () => {
    expect(canonicalizeSku("abc.01/x")).toBe("ABC.01/X");
  });
  it("stringifies numbers", () => {
    expect(canonicalizeSku(123)).toBe("123");
  });
  it("returns null on empty/null", () => {
    expect(canonicalizeSku("  ")).toBeNull();
    expect(canonicalizeSku(null)).toBeNull();
    expect(canonicalizeSku(undefined)).toBeNull();
  });
});

describe("deriveStyleFromSku", () => {
  it("strips trailing color/size segments", () => {
    expect(deriveStyleFromSku("ROF-HOODIE-BLK-M")).toBe("ROF-HOODIE");
  });
  it("returns null when segments too few", () => {
    expect(deriveStyleFromSku("ABC-01")).toBeNull();
    expect(deriveStyleFromSku("ABC")).toBeNull();
  });
});

describe("canonicalizeCustomerName", () => {
  it("collapses punctuation and case", () => {
    expect(canonicalizeCustomerName("Nordstrom, Inc.")).toBe("NORDSTROM INC");
    expect(canonicalizeCustomerName("NORDSTROM INC")).toBe("NORDSTROM INC");
  });
  it("preserves ampersand", () => {
    expect(canonicalizeCustomerName("Dick's Sporting & Goods")).toBe("DICKS SPORTING & GOODS");
  });
});

describe("canonicalizeVendorName", () => {
  it("strips corp suffixes", () => {
    expect(canonicalizeVendorName("Acme Garments Ltd.")).toBe("ACME GARMENTS");
    expect(canonicalizeVendorName("FOO CORP")).toBe("FOO");
  });
});

describe("canonicalizeChannelCode", () => {
  it("normalizes separators and case", () => {
    expect(canonicalizeChannelCode("Shopify-US")).toBe("SHOPIFY_US");
    expect(canonicalizeChannelCode("shopify us")).toBe("SHOPIFY_US");
  });
});

describe("canonicalizeCategory / canonicalizeStyleCode", () => {
  it("uppercases and compacts", () => {
    expect(canonicalizeCategory("  Mens Tops  ")).toBe("MENS TOPS");
    expect(canonicalizeStyleCode(" rof-hoodie ")).toBe("ROF-HOODIE");
  });
});
