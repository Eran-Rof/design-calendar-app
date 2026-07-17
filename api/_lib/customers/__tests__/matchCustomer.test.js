import { describe, it, expect } from "vitest";
import { buildCustomerLookup, resolveExistingCustomerId } from "../matchCustomer.js";
import { normalizedNameKey } from "../customerCodeKey.js";

describe("normalizedNameKey", () => {
  it("uppercases and strips ALL non-alphanumerics (whitespace + punctuation)", () => {
    expect(normalizedNameKey("Amazon FBM")).toBe("AMAZONFBM");
    expect(normalizedNameKey("U.S. Apparel")).toBe("USAPPAREL");
    expect(normalizedNameKey("US Apparel")).toBe("USAPPAREL");
    expect(normalizedNameKey("Vet Inc.")).toBe("VETINC");
    expect(normalizedNameKey("Vet Inc")).toBe("VETINC");
  });
  it("collapses the historical fork pairs onto ONE key", () => {
    expect(normalizedNameKey("AMAZON FBM")).toBe(normalizedNameKey("Amazon FBM"));
    expect(normalizedNameKey("U.S. Apparel")).toBe(normalizedNameKey("US Apparel"));
    expect(normalizedNameKey("D Moda")).toBe(normalizedNameKey("Dmoda"));
  });
  it("is null/undefined safe", () => {
    expect(normalizedNameKey(null)).toBe("");
    expect(normalizedNameKey(undefined)).toBe("");
  });
});

describe("normalizedNameKey ⇄ SQL customer_name_key parity", () => {
  // The DB-side backstop is the partial unique index customers_entity_name_key_uniq,
  // built on public.customer_name_key(name) — defined in migration
  // 20262500000000 as: regexp_replace(upper(COALESCE(name,'')), '[^A-Z0-9]', '', 'g').
  // The two implementations MUST agree, or a name the importer guard lets through
  // could still trip the unique index (or vice-versa). Each fixture's `sql` value
  // is the exact string Postgres returns for customer_name_key(name); this test
  // asserts the JS twin returns the same. Fixtures are limited to the realistic
  // (ASCII / Latin-1) customer-name domain — upper() and JS toUpperCase() diverge
  // only on exotic cases like 'ß' (JS→"SS", PG→""), which do not occur in the data.
  const fixtures = [
    { name: "D Moda", sql: "DMODA" },
    { name: "Dmoda", sql: "DMODA" },
    { name: "U.S. Apparel", sql: "USAPPAREL" },
    { name: "US Apparel", sql: "USAPPAREL" },
    { name: "Vet Inc", sql: "VETINC" },
    { name: "Vet Inc.", sql: "VETINC" },
    { name: "Amazon FBM", sql: "AMAZONFBM" },
    { name: "Surf, Wind, and Fir", sql: "SURFWINDANDFIR" },
    { name: "3M Company #2", sql: "3MCOMPANY2" },
    { name: "  Trailing/Leading  ", sql: "TRAILINGLEADING" },
    { name: "Café Röst", sql: "CAFRST" },
    { name: "", sql: "" },
  ];
  it.each(fixtures)("normalizedNameKey($name) === SQL customer_name_key => $sql", ({ name, sql }) => {
    expect(normalizedNameKey(name)).toBe(sql);
  });
});

describe("resolveExistingCustomerId — importer dedup guard", () => {
  // A live keeper exists with a proper CUST code + mixed-case name; the sales
  // importer sees the ALL-CAPS variant with an EXCEL: code and must NOT fork.
  const rows = [
    { id: "keeper-amazon", customer_code: "CUST-00099", name: "Amazon FBM" },
    { id: "keeper-usapparel", customer_code: "CUST-00167", name: "U.S. Apparel" },
    { id: "legacy-brig", customer_code: "EXCEL:BRIGSURFSHOP", name: "Brig Surf Shop" },
  ];
  const lookup = buildCustomerLookup(rows);

  it("attaches an ALL-CAPS EXCEL import to the proper-cased keeper via normalized name", () => {
    expect(resolveExistingCustomerId(lookup, { customerCode: "EXCEL:AMAZONFBM", name: "AMAZON FBM" }))
      .toBe("keeper-amazon");
  });
  it("attaches a punctuation-variant to the keeper (US Apparel → U.S. Apparel)", () => {
    expect(resolveExistingCustomerId(lookup, { customerCode: "EXCEL:USAPPAREL", name: "US Apparel" }))
      .toBe("keeper-usapparel");
  });
  it("matches a legacy row by its bare code key regardless of prefix/spacing", () => {
    expect(resolveExistingCustomerId(lookup, { customerCode: "EXCEL:BRIG SURF SHOP", name: "Something Else" }))
      .toBe("legacy-brig");
  });
  it("prefers an exact name match", () => {
    expect(resolveExistingCustomerId(lookup, { customerCode: "XORO:123", name: "Amazon FBM" }))
      .toBe("keeper-amazon");
  });
  it("returns null for a genuinely new customer", () => {
    expect(resolveExistingCustomerId(lookup, { customerCode: "EXCEL:NEWSTORE", name: "Brand New Store" }))
      .toBeNull();
  });
  it("does not consider soft-deleted rows (they are excluded before buildCustomerLookup)", () => {
    // buildCustomerLookup is fed ONLY live rows by loadLiveCustomers; a tombstone
    // simply isn't in the map, so a normalized-name query returns null and the
    // importer creates fresh rather than resurrecting the tombstone.
    const liveOnly = buildCustomerLookup([{ id: "keeper", customer_code: "CUST-1", name: "Keeper Co" }]);
    expect(resolveExistingCustomerId(liveOnly, { customerCode: "EXCEL:GHOSTCO", name: "Ghost Co" })).toBeNull();
  });
});
