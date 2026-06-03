// api/_lib/shopify/pull-product-images.js
//
// P11-10 — re-host a Shopify product's images into the pim-images bucket as
// product_images rows, so the PIM (and any app reading product_images) shows
// them and they survive deletion/re-slug on the Shopify side.
//
// Flow (per style):
//   1. Load style_master (id, entity_id, shopify_product_id).
//   2. Resolve the shopify_stores row (explicit storeId, else the style's
//      entity's single active token-bearing store). Decrypt the access token.
//   3. ShopifyClient.getProduct(shopify_product_id) — product.images[] is
//      authoritative; fall back to getProductImages() if it's empty.
//   4. For each image NOT already pulled (dedup on shopify_image_id):
//        - download the original bytes from image.src
//        - run the same Sharp pipeline manual uploads use (thumb/web/print)
//        - upload the 3 derivatives to pim-images
//        - INSERT a product_images row (owner_type='style', source='shopify',
//          shopify_image_id set) keyed by style_id so the existing render
//          path picks it up with zero changes.
//
// Per-image error isolation: a single bad image (oversized, 404 src, decode
// failure) is recorded and skipped; the rest proceed. Re-runs are no-ops once
// an image's shopify_image_id already exists for the style.
//
// Deps are injected so the handler test can mock Shopify + Sharp + storage +
// the HTTP download without network or native modules. Mirrors the
// backfill-orders.js dependency-injection pattern.

import { ShopifyClient } from "./client.js";
import { decryptToken as defaultDecryptToken } from "./token-encryption.js";
import {
  processImage as defaultProcessImage,
  loadSharp as defaultLoadSharp,
  storagePathFor,
  newImageId,
} from "../pim-images.js";

const BUCKET = "pim-images";

/**
 * Download an image URL to a Buffer. Default uses global fetch (Node 18+ on
 * Vercel). Injectable for tests.
 * @param {string} url
 * @returns {Promise<Buffer>}
 */
async function defaultFetchImage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

/**
 * Resolve which shopify_stores row to pull from.
 *  - if storeId given, use it (must belong to the style's entity + have a token)
 *  - else the entity's active, token-bearing stores; exactly one → use it,
 *    zero → error, many → error asking for an explicit store_id.
 */
export async function resolveStore(admin, { entityId, storeId }) {
  let q = admin
    .from("shopify_stores")
    .select(
      "id, entity_id, shopify_domain, api_version, " +
      "access_token_ciphertext, access_token_iv, access_token_tag",
    )
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
    throw new Error(
      "multiple active Shopify stores for this entity — pass store_id to disambiguate",
    );
  }
  return stores[0];
}

/**
 * Core orchestrator. Returns a summary; never throws for per-image problems.
 *
 * @param {Object} args
 * @param {Object} args.admin       Supabase service-role client.
 * @param {string} args.styleId     style_master.id (uuid).
 * @param {string} [args.storeId]   optional shopify_stores.id override.
 * @param {Object} [args.deps]      injection point for tests.
 * @returns {Promise<{style_id, shopify_product_id, pulled, skipped, failed,
 *   images: Array, errors: string[]}>}
 */
export async function pullShopifyImages({ admin, styleId, storeId, deps = {} } = {}) {
  if (!admin || typeof admin.from !== "function") {
    throw new Error("admin must be a Supabase client");
  }
  const d = {
    decryptToken: defaultDecryptToken,
    makeClient: (opts) => new ShopifyClient(opts),
    processImage: defaultProcessImage,
    loadSharp: defaultLoadSharp,
    fetchImage: defaultFetchImage,
    newImageId,
    ...deps,
  };

  // 1. Style + its linked product.
  const { data: style, error: styleErr } = await admin
    .from("style_master")
    .select("id, entity_id, shopify_product_id")
    .eq("id", styleId)
    .maybeSingle();
  if (styleErr) throw new Error(`style lookup failed: ${styleErr.message}`);
  if (!style) throw new Error("style not found");
  if (!style.shopify_product_id) {
    throw new Error("style is not linked to a Shopify product (set shopify_product_id first)");
  }
  const entityId = style.entity_id;
  const productId = style.shopify_product_id;

  // 2. Store + token + client.
  const store = await resolveStore(admin, { entityId, storeId });
  const accessToken = d.decryptToken(
    store.access_token_ciphertext,
    store.access_token_iv,
    store.access_token_tag,
  );
  const shop = d.makeClient({
    shopifyDomain: store.shopify_domain,
    accessToken,
    apiVersion: store.api_version,
  });

  // 3. Image set — prefer the product payload, fall back to /images.json.
  let images = [];
  const { data: product } = await shop.getProduct(productId);
  if (product && Array.isArray(product.images) && product.images.length > 0) {
    images = product.images;
  } else {
    const { data: imgs } = await shop.getProductImages(productId);
    images = imgs || [];
  }

  const summary = {
    style_id: styleId,
    shopify_product_id: String(productId),
    pulled: 0,
    skipped: 0,
    failed: 0,
    images: [],
    errors: [],
  };

  // Pre-load existing shopify_image_ids for this style for dedup.
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
      // download → Sharp → upload → insert
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
        shopify_image_id: shopifyImageId,
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
