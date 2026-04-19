import { describe, it, expect } from "vitest";
import {
  normalizeShopifyProduct,
  normalizeShopifyOrder,
  normalizeShopifyProductChannelStatus,
  normalizeShopifyInventoryLevel,
} from "../normalize/shopify";
import type { ShopifyProduct, ShopifyVariant } from "../types/rawPayloads";

describe("normalizeShopifyProduct", () => {
  it("flattens variants into item rows", () => {
    const p: ShopifyProduct = {
      id: "prod-1",
      title: "Hoodie",
      handle: "rof-hoodie",
      product_type: "Tops",
      vendor: "Acme",
      status: "active",
      published_at: "2026-01-01T00:00:00Z",
      tags: "core, mens",
      variants: [
        { id: "var-1", sku: "rof-hoodie-blk-m", price: "49.99", inventory_item_id: "iv-1", option2: "Black", option3: "M" },
        { id: "var-2", sku: "rof-hoodie-blk-l", price: "49.99", inventory_item_id: "iv-2", option2: "Black", option3: "L" },
      ],
    };
    const rows = normalizeShopifyProduct(p);
    expect(rows).toHaveLength(2);
    expect(rows[0].sku_code).toBe("ROF-HOODIE-BLK-M");
    expect(rows[0].style_code).toBe("ROF-HOODIE");
    expect(rows[0].external_refs.shopify_variant_id).toBe("var-1");
    expect(rows[0].active).toBe(true);
  });
  it("skips variants with no SKU", () => {
    const p: ShopifyProduct = {
      id: "prod-2",
      variants: [{ id: "var-3", sku: undefined, price: "0" }],
    };
    expect(normalizeShopifyProduct(p)).toHaveLength(0);
  });
});

describe("normalizeShopifyOrder", () => {
  it("maps line items and subtracts refund qty", () => {
    const rows = normalizeShopifyOrder(
      {
        id: "ord-1",
        name: "#1001",
        created_at: "2026-03-01T10:00:00Z",
        currency: "USD",
        line_items: [
          { id: "li-1", sku: "abc-01", quantity: 5, price: "10.00" },
          { id: "li-2", sku: "abc-02", quantity: 2, price: "20.00" },
        ],
        refunds: [
          {
            id: "rf-1",
            refund_line_items: [
              { line_item_id: "li-1", quantity: 2, subtotal: "20.00" },
            ],
          },
        ],
      },
      { storefront_code: "SHOPIFY_US" },
    );
    expect(rows).toHaveLength(2);
    const [first, second] = rows;
    expect(first.qty).toBe(5);
    expect(first.returned_qty).toBe(2);
    expect(first.net_qty).toBe(3);
    expect(first.refund_amount).toBe(20);
    expect(first.net_amount).toBe(30); // 50 gross - 0 discount - 20 refund
    expect(second.returned_qty).toBe(0);
    expect(second.source_line_key).toMatch(/^shopify:SHOPIFY_US:ord-1:li-2$/);
  });
});

describe("normalizeShopifyProductChannelStatus", () => {
  it("derives listed=true when published_at present", () => {
    const p: ShopifyProduct = { id: 1, status: "active", published_at: "2026-01-01T00:00:00Z" };
    const v: ShopifyVariant = { id: 2, sku: "abc-01", price: "10.00" };
    const r = normalizeShopifyProductChannelStatus(p, v, { storefront_code: "SHOPIFY_US" });
    expect(r?.listed).toBe(true);
    expect(r?.status).toBe("active");
    expect(r?.price).toBe(10);
  });
});

describe("normalizeShopifyInventoryLevel", () => {
  it("resolves sku via inventory_item_id map", () => {
    const variants = new Map<string, ShopifyVariant>([
      ["iv-1", { id: "var-1", sku: "abc-01", inventory_item_id: "iv-1" }],
    ]);
    const out = normalizeShopifyInventoryLevel(
      { inventory_item_id: "iv-1", location_id: 100, available: 42, updated_at: "2026-04-01" },
      variants,
      { snapshot_date: "2026-04-01" },
    );
    expect(out?._src.sku).toBe("ABC-01");
    expect(out?.qty_on_hand).toBe(42);
    expect(out?.warehouse_code).toBe("100");
  });
  it("returns row with null sku when variant unknown (so DQ can flag)", () => {
    const out = normalizeShopifyInventoryLevel(
      { inventory_item_id: "iv-unknown", available: 0 },
      new Map(),
      { snapshot_date: "2026-04-01" },
    );
    expect(out?._src.sku).toBeNull();
  });
});
