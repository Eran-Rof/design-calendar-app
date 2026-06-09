// api/_lib/shopify/pull-product-meta.js
//
// P11-10 — pull a linked Shopify product's NON-image metadata onto the style:
//   1. description   → product_descriptions (body_html → long_description)
//   2. attributes    → product_attributes (type / vendor / tags / color+size options)
//   3. color-tag the already-re-hosted images → product_images.color, derived
//      from each variant's image_id + its Color option value. This is the
//      "color solution": the Inventory Matrix can then show the right image per
//      color row instead of a single style-level default.
//
// Reuses the store/client resolution from pull-product-images.js. Deps injected
// for tests.

import { loadStoreById, buildShopClient } from "./pull-product-images.js";

/** Plain text (tags stripped, collapsed) — for short_description. */
export function htmlToText(html) {
  if (!html || typeof html !== "string") return "";
  return html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ").trim();
}

/** Shopify product tags → string[]. */
export function tagsToArray(tags) {
  if (Array.isArray(tags)) return tags;
  if (typeof tags === "string" && tags.trim()) return tags.split(",").map((t) => t.trim()).filter(Boolean);
  return [];
}

/**
 * Map shopify image id → color, using the product's "Color" option position and
 * each variant's image_id. Images not referenced by any variant get no color.
 * @returns {Map<string,string>} String(image_id) → color
 */
export function buildImageColorMap(product) {
  const options = product?.options || [];
  const colorIdx = options.findIndex((o) => /colou?r/i.test(o?.name || ""));
  const map = new Map();
  if (colorIdx < 0) return map;
  const optKey = `option${colorIdx + 1}`;
  for (const v of product?.variants || []) {
    if (v && v.image_id != null && v[optKey]) {
      const key = String(v.image_id);
      if (!map.has(key)) map.set(key, String(v[optKey]).trim());
    }
  }
  return map;
}

export async function syncProductMeta({ admin, styleId, deps = {} } = {}) {
  if (!admin || typeof admin.from !== "function") throw new Error("admin must be a Supabase client");

  const { data: style, error: sErr } = await admin
    .from("style_master").select("id, entity_id, shopify_product_id").eq("id", styleId).maybeSingle();
  if (sErr) throw new Error(`style lookup failed: ${sErr.message}`);
  if (!style) throw new Error("style not found");
  if (!style.shopify_product_id) throw new Error("style is not linked to a Shopify product");

  const { data: mirror, error: mErr } = await admin
    .from("shopify_products").select("id, shopify_product_id, shopify_store_id").eq("id", style.shopify_product_id).maybeSingle();
  if (mErr) throw new Error(`shopify_products lookup failed: ${mErr.message}`);
  if (!mirror) throw new Error("linked shopify_products row not found");

  const store = await loadStoreById(admin, mirror.shopify_store_id);
  const shop = buildShopClient(store, deps);
  const { data: product } = await shop.getProduct(mirror.shopify_product_id);
  if (!product) throw new Error("Shopify product not found");

  const summary = { style_id: styleId, description: false, attributes: 0, colored_images: 0, errors: [] };

  // 1. Description.
  try {
    const longDesc = product.body_html || null;
    const shortDesc = htmlToText(product.body_html).slice(0, 400) || null;
    const { error } = await admin.from("product_descriptions").upsert({
      entity_id: style.entity_id,
      style_id: styleId,
      locale: "en",
      long_description: longDesc,
      short_description: shortDesc,
      seo_title: product.title || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "style_id,locale" });
    if (error) throw new Error(error.message);
    summary.description = true;
  } catch (e) { summary.errors.push(`description: ${e.message}`); }

  // 2. Attributes.
  const colorOpt = (product.options || []).find((o) => /colou?r/i.test(o?.name || ""));
  const sizeOpt = (product.options || []).find((o) => /size/i.test(o?.name || ""));
  const attrs = [
    ["shopify_product_type", product.product_type || null],
    ["shopify_vendor", product.vendor || null],
    ["shopify_tags", tagsToArray(product.tags)],
    ["shopify_colors", (colorOpt?.values) || []],
    ["shopify_sizes", (sizeOpt?.values) || []],
  ];
  for (const [key, val] of attrs) {
    try {
      const { error } = await admin.from("product_attributes").upsert({
        entity_id: style.entity_id, style_id: styleId, attribute_key: key,
        value: { value: val }, updated_at: new Date().toISOString(),
      }, { onConflict: "style_id,attribute_key" });
      if (error) throw new Error(error.message);
      summary.attributes += 1;
    } catch (e) { summary.errors.push(`attr ${key}: ${e.message}`); }
  }

  // 3. Color-tag the re-hosted images.
  try {
    const colorMap = buildImageColorMap(product);
    for (const [imgId, color] of colorMap) {
      const { error } = await admin.from("product_images")
        .update({ color })
        .eq("style_id", styleId).eq("shopify_image_id", Number(imgId));
      if (!error) summary.colored_images += 1;
    }
  } catch (e) { summary.errors.push(`colors: ${e.message}`); }

  return summary;
}
