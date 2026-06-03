// Tests for the Shopify product mirror + image re-host (P11-10).
//
// Exercises pullShopifyImages + resolveStore + upsertShopifyProduct via an
// in-memory supabase + storage double and fully-injected deps (no network, no
// Sharp, no crypto). Covers:
//   - happy path: linked style → mirror → N images downloaded/processed/inserted
//   - row shape: source='shopify', owner_type='style', shopify_image_id numeric
//   - dedup: an already-pulled shopify_image_id is skipped
//   - not-linked style throws; missing mirror row throws
//   - per-image isolation: one bad download fails, the rest still pull
//   - fallback to getProductImages when product.images is empty
//   - upsertShopifyProduct shape + tag normalization
//   - resolveStore zero/many/one
//   - normalizeProductId validation (link handler helper)

import { describe, it, expect } from "vitest";
import {
  pullShopifyImages,
  resolveStore,
  upsertShopifyProduct,
} from "../pull-product-images.js";
import { normalizeProductId } from "../../../_handlers/internal/pim/styles/[style_id]/link-shopify.js";

const ENTITY = "11111111-1111-1111-1111-111111111111";
const STYLE = "22222222-2222-2222-2222-222222222222";
const MIRROR = "44444444-4444-4444-4444-444444444444";

// ── In-memory supabase + storage double ────────────────────────────────────
function makeAdmin(initial = {}) {
  const tables = {
    style_master: [...(initial.style_master || [])],
    shopify_stores: [...(initial.shopify_stores || [])],
    shopify_products: [...(initial.shopify_products || [])],
    product_images: [...(initial.product_images || [])],
  };
  const uploads = [];
  const removed = [];

  function builder(name) {
    const rows = tables[name];
    if (!rows) throw new Error(`unknown table ${name}`);
    const filters = [];
    let pending = null;

    const applyFilters = () =>
      rows.filter((r) =>
        filters.every((f) =>
          f.op === "eq" ? r[f.col] === f.val
          : f.op === "not_null" ? r[f.col] != null
          : true,
        ),
      );

    const api = {
      select() { return api; },
      eq(col, val) { filters.push({ op: "eq", col, val }); return api; },
      not(col) { filters.push({ op: "not_null", col }); return api; },
      insert(row) { pending = row; return api; },
      upsert(row) { pending = row; return api; },
      update(patch) {
        for (const r of applyFilters()) Object.assign(r, patch);
        return Promise.resolve({ data: null, error: null });
      },
      maybeSingle() {
        const m = applyFilters();
        return Promise.resolve({ data: m[0] || null, error: null });
      },
      single() {
        if (pending) {
          const row = { id: pending.id || `gen-${rows.length}`, ...pending };
          rows.push(row);
          pending = null;
          return Promise.resolve({ data: { id: row.id }, error: null });
        }
        const m = applyFilters();
        return Promise.resolve({ data: m[0] || null, error: null });
      },
      then(resolve) { resolve({ data: applyFilters(), error: null }); },
    };
    return api;
  }

  return {
    from: builder,
    storage: {
      from() {
        return {
          upload: async (path) => { uploads.push(path); return { error: null }; },
          remove: async (paths) => { removed.push(...paths); return { error: null }; },
        };
      },
    },
    _tables: tables,
    _uploads: uploads,
    _removed: removed,
  };
}

const STORE_ROW = {
  id: "store-1",
  entity_id: ENTITY,
  shopify_domain: "rof.myshopify.com",
  api_version: "2025-01",
  is_active: true,
  access_token_ciphertext: "ct",
  access_token_iv: "iv",
  access_token_tag: "tag",
};

const MIRROR_ROW = {
  id: MIRROR,
  entity_id: ENTITY,
  shopify_store_id: "store-1",
  shopify_product_id: 555,
};

function makeDeps(overrides = {}) {
  let n = 0;
  return {
    decryptToken: () => "shpat_token",
    makeClient: () => ({
      getProduct: async () => ({
        data: {
          id: 555,
          images: [
            { id: 101, src: "https://cdn/img1.jpg", alt: "front", position: 0 },
            { id: 102, src: "https://cdn/img2.jpg", alt: null, position: 1 },
          ],
        },
      }),
      getProductImages: async () => ({ data: [] }),
    }),
    loadSharp: async () => ({}),
    processImage: async () => ({
      thumb: { buffer: Buffer.from("t"), width: 200, height: 200, bytes: 3 },
      web: { buffer: Buffer.from("w"), width: 800, height: 800, bytes: 4 },
      print: { buffer: Buffer.from("p"), width: 2400, height: 2400, bytes: 5 },
    }),
    fetchImage: async () => Buffer.from("bytes"),
    newImageId: () => `33333333-3333-3333-3333-3333333333${String(n++).padStart(2, "0")}`,
    ...overrides,
  };
}

describe("pullShopifyImages", () => {
  it("resolves via the mirror and re-hosts each image", async () => {
    const admin = makeAdmin({
      style_master: [{ id: STYLE, entity_id: ENTITY, shopify_product_id: MIRROR }],
      shopify_products: [MIRROR_ROW],
      shopify_stores: [STORE_ROW],
    });
    const out = await pullShopifyImages({ admin, styleId: STYLE, deps: makeDeps() });

    expect(out.pulled).toBe(2);
    expect(out.skipped).toBe(0);
    expect(out.failed).toBe(0);
    expect(out.shopify_product_id).toBe("555");
    expect(admin._uploads).toHaveLength(6); // 2 images × 3 derivatives
    expect(admin._tables.product_images).toHaveLength(2);

    const row = admin._tables.product_images[0];
    expect(row.source).toBe("shopify");
    expect(row.owner_type).toBe("style");
    expect(row.owner_id).toBe(STYLE);
    expect(row.style_id).toBe(STYLE);
    expect(row.shopify_image_id).toBe(101); // numeric int8
    expect(typeof row.shopify_image_id).toBe("number");
    expect(row.image_kind).toBe("flat");
    expect(row.alt_text).toBe("front");
  });

  it("dedups images already pulled (by shopify_image_id)", async () => {
    const admin = makeAdmin({
      style_master: [{ id: STYLE, entity_id: ENTITY, shopify_product_id: MIRROR }],
      shopify_products: [MIRROR_ROW],
      shopify_stores: [STORE_ROW],
      product_images: [{ style_id: STYLE, source: "shopify", shopify_image_id: 101 }],
    });
    const out = await pullShopifyImages({ admin, styleId: STYLE, deps: makeDeps() });
    expect(out.pulled).toBe(1);
    expect(out.skipped).toBe(1);
  });

  it("throws when the style is not linked", async () => {
    const admin = makeAdmin({
      style_master: [{ id: STYLE, entity_id: ENTITY, shopify_product_id: null }],
      shopify_stores: [STORE_ROW],
    });
    await expect(pullShopifyImages({ admin, styleId: STYLE, deps: makeDeps() }))
      .rejects.toThrow(/not linked/i);
  });

  it("throws when the linked mirror row is missing", async () => {
    const admin = makeAdmin({
      style_master: [{ id: STYLE, entity_id: ENTITY, shopify_product_id: MIRROR }],
      shopify_products: [],
      shopify_stores: [STORE_ROW],
    });
    await expect(pullShopifyImages({ admin, styleId: STYLE, deps: makeDeps() }))
      .rejects.toThrow(/shopify_products row not found/i);
  });

  it("isolates a per-image failure; other images still pull", async () => {
    const admin = makeAdmin({
      style_master: [{ id: STYLE, entity_id: ENTITY, shopify_product_id: MIRROR }],
      shopify_products: [MIRROR_ROW],
      shopify_stores: [STORE_ROW],
    });
    let call = 0;
    const deps = makeDeps({
      fetchImage: async () => { call += 1; if (call === 1) throw new Error("404 from cdn"); return Buffer.from("ok"); },
    });
    const out = await pullShopifyImages({ admin, styleId: STYLE, deps });
    expect(out.pulled).toBe(1);
    expect(out.failed).toBe(1);
    expect(out.errors[0]).toMatch(/404 from cdn/);
  });

  it("falls back to getProductImages when product.images is empty", async () => {
    const admin = makeAdmin({
      style_master: [{ id: STYLE, entity_id: ENTITY, shopify_product_id: MIRROR }],
      shopify_products: [MIRROR_ROW],
      shopify_stores: [STORE_ROW],
    });
    const deps = makeDeps({
      makeClient: () => ({
        getProduct: async () => ({ data: { id: 555, images: [] } }),
        getProductImages: async () => ({ data: [{ id: 201, src: "https://cdn/x.jpg", position: 0 }] }),
      }),
    });
    const out = await pullShopifyImages({ admin, styleId: STYLE, deps });
    expect(out.pulled).toBe(1);
    expect(admin._tables.product_images[0].shopify_image_id).toBe(201);
  });
});

describe("upsertShopifyProduct", () => {
  it("mirrors a product (numeric id, tag split, style link)", async () => {
    const admin = makeAdmin({ shopify_products: [] });
    const product = {
      id: 555, handle: "tee", title: "Cool Tee", status: "active",
      tags: "summer, sale", updated_at: "2026-06-01T00:00:00Z",
    };
    const id = await upsertShopifyProduct(admin, { entityId: ENTITY, store: STORE_ROW, product, styleId: STYLE });
    expect(id).toBeTruthy();
    const row = admin._tables.shopify_products[0];
    expect(row.shopify_product_id).toBe(555);
    expect(typeof row.shopify_product_id).toBe("number");
    expect(row.tags).toEqual(["summer", "sale"]);
    expect(row.resolved_style_id).toBe(STYLE);
    expect(row.match_method).toBe("manual");
    expect(row.shopify_store_id).toBe("store-1");
  });
});

describe("resolveStore", () => {
  it("throws when no active token-bearing store exists", async () => {
    const admin = makeAdmin({ shopify_stores: [] });
    await expect(resolveStore(admin, { entityId: ENTITY })).rejects.toThrow(/no active Shopify store/i);
  });
  it("throws on ambiguity when >1 store and no store_id", async () => {
    const admin = makeAdmin({
      shopify_stores: [STORE_ROW, { ...STORE_ROW, id: "store-2", shopify_domain: "b.myshopify.com" }],
    });
    await expect(resolveStore(admin, { entityId: ENTITY })).rejects.toThrow(/multiple active/i);
  });
  it("returns the single store", async () => {
    const admin = makeAdmin({ shopify_stores: [STORE_ROW] });
    const s = await resolveStore(admin, { entityId: ENTITY });
    expect(s.id).toBe("store-1");
  });
});

describe("normalizeProductId", () => {
  it("accepts a positive integer string", () => {
    expect(normalizeProductId("12345")).toEqual({ value: "12345" });
    expect(normalizeProductId(12345)).toEqual({ value: "12345" });
  });
  it("treats null/empty as unlink", () => {
    expect(normalizeProductId(null)).toEqual({ value: null });
    expect(normalizeProductId("")).toEqual({ value: null });
  });
  it("rejects non-numeric", () => {
    expect(normalizeProductId("abc").error).toBeTruthy();
    expect(normalizeProductId("-5").error).toBeTruthy();
  });
});
