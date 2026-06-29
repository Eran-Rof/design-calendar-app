// POST /api/internal/pim/styles/:style_id/link-shopify
//
// Links (or unlinks) a style to a Shopify product. On link we fetch the
// product from Shopify, upsert a shopify_products mirror row, and point
// style_master.shopify_product_id (uuid FK) at it. The pull-shopify-images
// endpoint then re-hosts that product's images.
//
// Body: { shopify_product_id: string|number|null, store_id?: uuid }
//   - a positive integer (the numeric Shopify product id) → link
//   - null / "" → unlink (clears the FK; the mirror row is left in place)
//   - store_id disambiguates when the entity has >1 active Shopify store
//
// Tangerine P11-10 (Shopify product mirror + image unification).

import { createClient } from "@supabase/supabase-js";
import { resolveStore, buildShopClient, upsertShopifyProduct } from "../../../../../_lib/shopify/pull-product-images.js";

export const config = { maxDuration: 30 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-user-id");
}

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

function getStyleId(req) {
  if (req.query?.style_id) return req.query.style_id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const tail = parts.lastIndexOf("link-shopify");
  return tail > 0 ? parts[tail - 1] : null;
}

/** Normalize the inbound numeric Shopify product id: null/"" → null (unlink). */
export function normalizeProductId(raw) {
  if (raw == null || raw === "") return { value: null };
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) return { error: "shopify_product_id must be a positive integer or null" };
  return { value: s };
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const styleId = getStyleId(req);
  if (!UUID_RE.test(String(styleId || ""))) {
    return res.status(400).json({ error: "Invalid style_id" });
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const norm = normalizeProductId(body.shopify_product_id);
  if (norm.error) return res.status(400).json({ error: norm.error });
  const storeId = body.store_id || null;

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const { data: style, error: sErr } = await admin
    .from("style_master")
    .select("id, entity_id")
    .eq("id", styleId)
    .maybeSingle();
  if (sErr) return res.status(500).json({ error: sErr.message });
  if (!style) return res.status(404).json({ error: "Style not found" });

  // Unlink: clear the FK (leave the mirror row + its images intact).
  if (norm.value == null) {
    const { error: uErr } = await admin
      .from("style_master")
      .update({ shopify_product_id: null })
      .eq("id", styleId);
    if (uErr) return res.status(500).json({ error: uErr.message });
    return res.status(200).json({ style_id: styleId, shopify_product_id: null, linked: false });
  }

  // Link: fetch the product, mirror it, point the style's uuid FK at the mirror.
  try {
    const store = await resolveStore(admin, { entityId: style.entity_id, storeId });
    const shop = buildShopClient(store);
    const { data: product } = await shop.getProduct(norm.value);
    if (!product) return res.status(404).json({ error: `Shopify product ${norm.value} not found` });

    const mirrorId = await upsertShopifyProduct(admin, {
      entityId: style.entity_id,
      store,
      product,
      styleId,
    });

    const { error: uErr } = await admin
      .from("style_master")
      .update({ shopify_product_id: mirrorId })
      .eq("id", styleId);
    if (uErr) return res.status(500).json({ error: uErr.message });

    return res.status(200).json({
      style_id: styleId,
      shopify_product_id: mirrorId,
      shopify_numeric_id: String(product.id),
      title: product.title || null,
      linked: true,
    });
  } catch (e) {
    return res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
