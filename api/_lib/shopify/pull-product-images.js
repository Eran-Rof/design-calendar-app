// api/_lib/shopify/pull-product-images.js
//
// P11-10 — Shopify product mirror + image re-host.
//
// Data model (matches prod schema):
//   shopify_products            mirror of a Shopify product (id uuid PK,
//                               shopify_product_id int8 = the real Shopify id,
//                               UNIQUE (shopify_store_id, shopify_product_id),
//                               resolved_style_id -> style_master.id)
//   style_master.shopify_product_id  uuid FK -> shopify_products.id
//   product_images              re-hosted images (owner_type='style',
//                               source='shopify', shopify_image_id int8)
//
// This module owns:
//   - store credential resolution + ShopifyClient construction
//   - upsertShopifyProduct(): mirror a product (used by the link handler)
//   - pullShopifyImages(): re-host a linked product's images into pim-images
//
// Deps are injected so handler tests can mock Shopify + Sharp + storage +
// the HTTP download without network or native modules.

import { ShopifyClient } from "./client.js";
import { decryptToken as defaultDecryptToken } from "./token-encryption.js";
import {
  processImage as defaultProcessImage,
  loadSharp as defaultLoadSharp,
  storagePathFor,
  newImageId,
} from "../pim-images.js";

const BUCKET = "pim-images";

const STORE_COLS =
  "id, entity_id, shopify_domain, api_version, " +
  "access_token_ciphertext, access_token_iv, access_token_tag";

/** Download an image URL to a Buffer (global fetch on Vercel; injectable). */
async function defaultFetchImage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

/**
 * Resolve which active, token-bearing store to use for an entity.
 *  - storeId given → that store (scoped to the entity)
 *  - else exactly one active store → it; zero → error; many → ambiguous error
 * Used by the link handler (operator supplies a product id, we pick the store).
 */
export async function resolveStore(admin, { entityId, storeId }) {
  let q = admin
    .from("shopify_stores")
    .select(STORE_COLS)
    .eq("entity_id", entityId)
    .eq("is_active", true)
    .not("access_token_ciphertext", "is", null);
  if (storeId) q = q.eq("id", storeId);

  const { data, error } = await q;
  if (error) throw new Error(`shopify_stores lookup failed: ${error.message}`);
  const stores = data || [];
  if (stores.length === 0) {
    throw new Error(
      storeId
        ? "store_id not found for this entity (or has no access token)"
        : "no active Shopify store with an access token for this entity",
    );
  }
  if (stores.length > 1) {
    throw new Error("multiple active Shopify stores for this entity — pass store_id to disambiguate");
  }
  return stores[0];
}

/** Load a specific store by id (used by pull: the store comes from the mirror row). */
export async function loadStoreById(admin, storeId) {
  const { data, error } = await admin
    .from("shopify_stores")
    .select(STORE_COLS)
    .eq("id", storeId)
    .maybeSingle();
  if (error) throw new Error(`shopify_stores lookup failed: ${error.message}`);
  if (!data) throw new Error("shopify store for this product no longer exists");
  if (!data.access_token_ciphertext) throw new Error("shopify store has no access token");
  return data;
}

/** Decrypt the store's token and build a ShopifyClient. */
export function buildShopClient(store, deps = {}) {
  const decrypt = deps.decryptToken || defaultDecryptToken;
  const make = deps.makeClient || ((opts) => new ShopifyClient(opts));
  const accessToken = decrypt(
    store.access_token_ciphertext,
    store.access_token_iv,
    store.access_token_tag,
  );
  return make({ shopifyDomain: store.shopify_domain, accessToken, apiVersion: store.api_version });
}

/** Shopify returns tags as a comma-separated string; normalize to text[]. */
function tagsToArray(tags) {
  if (Array.isArray(tags)) return tags;
  if (typeof tags === "string" && tags.trim()) return tags.split(",").map((t) => t.trim()).filter(Boolean);
  return [];
}

/**
 * Upsert a shopify_products mirror row from a fetched Shopify product and
 * return its uuid id. Keyed by (shopify_store_id, shopify_product_id).
 *
 * @returns {Promise<string>} shopify_products.id (uuid)
 */
export async function upsertShopifyProduct(admin, { entityId, store, product, styleId }) {
  const status = ["active", "archived", "draft"].includes(product.status) ? product.status : "active";
  const row = {
    entity_id: entityId,
    shopify_store_id: store.id,
    shopify_product_id: Number(product.id),
    shopify_handle: product.handle || String(product.id),
    title: product.title || product.handle || String(product.id),
    product_type: product.product_type || null,
    vendor: product.vendor || null,
    tags: tagsToArray(product.tags),
    status,
    published_at: product.published_at || null,
    updated_at_shopify: product.updated_at || new Date(0).toISOString(),
    raw_payload: product,
    resolved_style_id: styleId,
    match_method: "manual",
  };
  const { data, error } = await admin
    .from("shopify_products")
    .upsert(row, { onConflict: "shopify_store_id,shopify_product_id" })
    .select("id")
    .single();
  if (error) throw new Error(`shopify_products upsert failed: ${error.message}`);
  return data.id;
}

/**
 * Re-host a linked style's Shopify images into pim-images as product_images
 * rows. Resolves the numeric product id + store via the shopify_products
 * mirror that style_master.shopify_product_id (uuid) points at.
 *
 * Per-image error isolation; dedups on shopify_image_id; never throws for a
 * single bad image.
 */
export async function pullShopifyImages({ admin, styleId, deps = {} } = {}) {
  if (!admin || typeof admin.from !== "function") {
    throw new Error("admin must be a Supabase client");
  }
  const d = {
    processImage: defaultProcessImage,
    loadSharp: defaultLoadSharp,
    fetchImage: defaultFetchImage,
    newImageId,
    ...deps,
  };

  // 1. Style → mirror uuid.
  const { data: style, error: styleErr } = await admin
    .from("style_master")
    .select("id, entity_id, shopify_product_id")
    .eq("id", styleId)
    .maybeSingle();
  if (styleErr) throw new Error(`style lookup failed: ${styleErr.message}`);
  if (!style) throw new Error("style not found");
  if (!style.shopify_product_id) {
    throw new Error("style is not linked to a Shopify product (link it first)");
  }
  const entityId = style.entity_id;

  // 2. Mirror row → numeric product id + store.
  const { data: mirror, error: mErr } = await admin
    .from("shopify_products")
    .select("id, shopify_product_id, shopify_store_id")
    .eq("id", style.shopify_product_id)
    .maybeSingle();
  if (mErr) throw new Error(`shopify_products lookup failed: ${mErr.message}`);
  if (!mirror) throw new Error("linked shopify_products row not found");

  const store = await loadStoreById(admin, mirror.shopify_store_id);
  const shop = buildShopClient(store, deps);

  // 3. Image set — prefer the product payload, fall back to /images.json.
  let images = [];
  const { data: product } = await shop.getProduct(mirror.shopify_product_id);
  if (product && Array.isArray(product.images) && product.images.length > 0) {
    images = product.images;
  } else {
    const { data: imgs } = await shop.getProductImages(mirror.shopify_product_id);
    images = imgs || [];
  }

  const summary = {
    style_id: styleId,
    shopify_product_id: String(mirror.shopify_product_id),
    pulled: 0,
    skipped: 0,
    failed: 0,
    images: [],
    errors: [],
  };

  // Dedup on shopify_image_id already pulled for this style.
  const { data: existingRows, error: exErr } = await admin
    .from("product_images")
    .select("shopify_image_id")
    .eq("style_id", styleId)
    .eq("source", "shopify")
    .not("shopify_image_id", "is", null);
  if (exErr) throw new Error(`dedup lookup failed: ${exErr.message}`);
  const seen = new Set((existingRows || []).map((r) => String(r.shopify_image_id)));

  const sharpLib = await d.loadSharp();
  if (!sharpLib) throw new Error("Sharp not available on this deployment");

  for (const img of images) {
    const shopifyImageId = String(img.id);
    if (seen.has(shopifyImageId)) {
      summary.skipped += 1;
      continue;
    }
    try {
      const buf = await d.fetchImage(img.src);
      const derivs = await d.processImage(buf, { sharp: sharpLib });

      const imageId = d.newImageId();
      const paths = {
        thumb: storagePathFor(entityId, styleId, imageId, "thumb"),
        web: storagePathFor(entityId, styleId, imageId, "web"),
        print: storagePathFor(entityId, styleId, imageId, "print"),
      };
      const kinds = ["thumb", "web", "print"];
      try {
        for (const k of kinds) {
          const { error: upErr } = await admin.storage
            .from(BUCKET)
            .upload(paths[k], derivs[k].buffer, { contentType: "image/jpeg", upsert: false });
          if (upErr) throw new Error(`upload ${k}: ${upErr.message}`);
        }
      } catch (e) {
        await admin.storage.from(BUCKET).remove(kinds.map((k) => paths[k])).catch(() => {});
        throw e;
      }

      const row = {
        id: imageId,
        entity_id: entityId,
        style_id: styleId,
        owner_type: "style",
        owner_id: styleId,
        source: "shopify",
        shopify_image_id: Number(img.id),
        image_kind: "flat",
        storage_path: paths.print,
        storage_path_thumb: paths.thumb,
        storage_path_web: paths.web,
        storage_path_print: paths.print,
        alt_text: img.alt || null,
        sort_order: Number.isInteger(img.position) ? img.position : 0,
        is_primary: false,
        mime_type: "image/jpeg",
        bytes: derivs.print.bytes,
        width: derivs.print.width,
        height: derivs.print.height,
      };
      const { data: inserted, error: insErr } = await admin
        .from("product_images")
        .insert(row)
        .select("id")
        .single();
      if (insErr) {
        await admin.storage.from(BUCKET).remove(kinds.map((k) => paths[k])).catch(() => {});
        throw new Error(insErr.message);
      }

      seen.add(shopifyImageId);
      summary.pulled += 1;
      summary.images.push({ id: inserted.id, shopify_image_id: shopifyImageId });
    } catch (e) {
      summary.failed += 1;
      summary.errors.push(`image ${shopifyImageId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return summary;
}
