import { describe, it, expect } from "vitest";
import {
  reconcileItem,
  reconcileCustomer,
  reconcileCategory,
  reconcileChannel,
  reconcileVendor,
} from "../mapping/reconcile";
import type {
  IpCategory,
  IpChannel,
  IpCustomer,
  IpItem,
  IpVendor,
} from "../types/entities";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const item = (o: Partial<IpItem> = {}): IpItem => ({
  id: "item-1", sku_code: "ABC-01", style_code: null, description: null,
  category_id: null, vendor_id: null, color: null, size: null,
  uom: "each", unit_cost: null, unit_price: null, lead_time_days: null,
  moq_units: null, lifecycle_status: null, planning_class: null,
  active: true, external_refs: {}, attributes: {}, ...o,
});

const vendor = (o: Partial<IpVendor> = {}): IpVendor => ({
  id: "v-1", vendor_code: "ACME", name: "Acme Ltd.", country: null,
  default_lead_time_days: null, moq_units: null, active: true,
  portal_vendor_id: null, external_refs: {}, notes: null, ...o,
});

const category = (o: Partial<IpCategory> = {}): IpCategory => ({
  id: "cat-1", category_code: "TOPS", name: "Mens Tops",
  segment: null, active: true, external_refs: {}, ...o,
});

const channel = (o: Partial<IpChannel> = {}): IpChannel => ({
  id: "ch-1", channel_code: "US_SHOP", name: "US Shopify",
  channel_type: "ecom", storefront_key: "ring-of-fire.myshopify.com",
  currency: "USD", timezone: null, active: true, external_refs: {}, ...o,
});

const customer = (o: Partial<IpCustomer> = {}): IpCustomer => ({
  id: "cust-1", customer_code: "NORD", name: "Nordstrom",
  parent_customer_id: null, customer_tier: "major", country: "US",
  channel_id: null, active: true, external_refs: {}, ...o,
});

// ── reconcileItem ─────────────────────────────────────────────────────────────

describe("reconcileItem", () => {
  it("matches by xoro_item_id external_ref (tier=external_ref)", () => {
    const items = [item({ id: "x", external_refs: { xoro_item_id: "42" } })];
    const r = reconcileItem({ xoro_item_id: "42" }, items);
    expect(r.tier).toBe("external_ref");
    expect(r.match?.id).toBe("x");
  });

  it("matches by shopify_variant_id external_ref", () => {
    const items = [item({ id: "s", external_refs: { shopify_variant_id: "V99" } })];
    const r = reconcileItem({ shopify_variant_id: "V99" }, items);
    expect(r.tier).toBe("external_ref");
    expect(r.match?.id).toBe("s");
  });

  it("falls back to canonical sku match (tier=code)", () => {
    const items = [item({ id: "y", sku_code: "ABC-01" })];
    const r = reconcileItem({ sku: "abc-01" }, items);
    expect(r.tier).toBe("code");
    expect(r.match?.id).toBe("y");
  });

  it("prefers external_ref over sku code when both would match", () => {
    const items = [
      item({ id: "by-ref", sku_code: "XYZ-00", external_refs: { xoro_item_id: "7" } }),
      item({ id: "by-sku", sku_code: "ABC-01" }),
    ];
    const r = reconcileItem({ sku: "abc-01", xoro_item_id: "7" }, items);
    expect(r.tier).toBe("external_ref");
    expect(r.match?.id).toBe("by-ref");
  });

  it("returns none when nothing matches", () => {
    const r = reconcileItem({ sku: "ZZZ-99" }, [item()]);
    expect(r.tier).toBe("none");
    expect(r.match).toBeNull();
  });

  it("returns none for empty input", () => {
    const r = reconcileItem({}, [item()]);
    expect(r.tier).toBe("none");
  });

  it("reports candidates_considered", () => {
    const items = [item(), item({ id: "item-2", sku_code: "DEF-01" })];
    const r = reconcileItem({ sku: "DEF-01" }, items);
    expect(r.candidates_considered).toBe(2);
  });
});

// ── reconcileVendor ───────────────────────────────────────────────────────────

describe("reconcileVendor", () => {
  it("matches by external_ref xoro_vendor_id", () => {
    const vendors = [vendor({ id: "v1", external_refs: { xoro_vendor_id: "V-10" } })];
    const r = reconcileVendor({ xoro_vendor_id: "V-10" }, vendors);
    expect(r.tier).toBe("external_ref");
    expect(r.match?.id).toBe("v1");
  });

  it("matches by vendor_code (tier=code)", () => {
    const vendors = [vendor({ id: "v2", vendor_code: "ACME" })];
    const r = reconcileVendor({ vendor_code: "ACME" }, vendors);
    expect(r.tier).toBe("code");
    expect(r.match?.id).toBe("v2");
  });

  it("matches by canonical name (tier=name)", () => {
    const vendors = [vendor({ id: "v3", name: "Pacific Thread LLC" })];
    const r = reconcileVendor({ name: "Pacific Thread" }, vendors);
    expect(r.tier).toBe("name");
    expect(r.match?.id).toBe("v3");
  });

  it("strips corp suffixes before name comparison", () => {
    const vendors = [vendor({ id: "v4", name: "Sunrise Apparel Inc." })];
    const r = reconcileVendor({ name: "Sunrise Apparel Ltd" }, vendors);
    expect(r.tier).toBe("name");
    expect(r.match?.id).toBe("v4");
  });

  it("returns none when no match", () => {
    const r = reconcileVendor({ name: "Ghost Factory" }, [vendor()]);
    expect(r.tier).toBe("none");
    expect(r.match).toBeNull();
  });
});

// ── reconcileCategory ─────────────────────────────────────────────────────────

describe("reconcileCategory", () => {
  it("matches by category_code case-insensitively (tier=code)", () => {
    const cats = [category({ id: "c1", category_code: "TOPS" })];
    const r = reconcileCategory("tops", cats);
    expect(r.tier).toBe("code");
    expect(r.match?.id).toBe("c1");
  });

  it("falls back to name match (tier=name)", () => {
    const cats = [category({ id: "c2", category_code: "MNS-TOPS", name: "Mens Tops" })];
    const r = reconcileCategory("Mens Tops", cats);
    expect(r.tier).toBe("name");
    expect(r.match?.id).toBe("c2");
  });

  it("returns none for null or empty input", () => {
    expect(reconcileCategory(null, [category()]).tier).toBe("none");
    expect(reconcileCategory("", [category()]).tier).toBe("none");
  });

  it("returns none when category is absent from list", () => {
    const r = reconcileCategory("BOTTOMS", [category()]);
    expect(r.tier).toBe("none");
    expect(r.match).toBeNull();
  });
});

// ── reconcileChannel ──────────────────────────────────────────────────────────

describe("reconcileChannel", () => {
  it("matches by storefront_key (tier=external_ref)", () => {
    const channels = [channel({ id: "ch1", storefront_key: "my-shop.myshopify.com" })];
    const r = reconcileChannel({ storefront_key: "my-shop.myshopify.com" }, channels);
    expect(r.tier).toBe("external_ref");
    expect(r.match?.id).toBe("ch1");
  });

  it("matches by channel_code (tier=code)", () => {
    const channels = [channel({ id: "ch2", channel_code: "CA_SHOP" })];
    const r = reconcileChannel({ channel_code: "ca_shop" }, channels);
    expect(r.tier).toBe("code");
    expect(r.match?.id).toBe("ch2");
  });

  it("falls back to channel_name match (tier=name)", () => {
    const channels = [channel({ id: "ch3", channel_code: "EU", name: "EU Shopify" })];
    const r = reconcileChannel({ channel_name: "EU Shopify" }, channels);
    expect(r.tier).toBe("name");
    expect(r.match?.id).toBe("ch3");
  });

  it("returns none when no match", () => {
    const r = reconcileChannel({ channel_code: "XX_SHOP" }, [channel()]);
    expect(r.tier).toBe("none");
    expect(r.match).toBeNull();
  });
});

// ── reconcileCustomer ─────────────────────────────────────────────────────────

describe("reconcileCustomer", () => {
  it("matches by external_ref shopify_customer_id", () => {
    const customers = [customer({ id: "c1", external_refs: { shopify_customer_id: "SC-1" } })];
    const r = reconcileCustomer({ shopify_customer_id: "SC-1" }, customers);
    expect(r.tier).toBe("external_ref");
    expect(r.match?.id).toBe("c1");
  });

  it("matches by customer_code (tier=code)", () => {
    const customers = [customer({ id: "c2", customer_code: "NORD" })];
    const r = reconcileCustomer({ customer_code: "NORD" }, customers);
    expect(r.tier).toBe("code");
    expect(r.match?.id).toBe("c2");
  });

  it("matches by canonical name case-insensitively (tier=name)", () => {
    // canonicalizeCustomerName strips punctuation and uppercases — no corp suffix stripping.
    const customers = [customer({ id: "c3", name: "nordstrom" })];
    const r = reconcileCustomer({ name: "NORDSTROM" }, customers);
    expect(r.tier).toBe("name");
    expect(r.match?.id).toBe("c3");
  });

  it("returns none when not found", () => {
    const r = reconcileCustomer({ name: "Ghost Store LLC" }, [customer()]);
    expect(r.tier).toBe("none");
    expect(r.match).toBeNull();
  });
});
