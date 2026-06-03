// POST /api/internal/pim/styles/:style_id/pull-shopify-images
//
// Re-hosts the linked Shopify product's images into the pim-images bucket as
// product_images rows (source='shopify'), keyed by style_id so the existing
// PIM render path shows them. Idempotent — dedups on shopify_image_id.
//
// Body / query (optional): store_id — disambiguate when the style's entity has
// more than one active Shopify store.
//
// Tangerine P11-10 (Shopify product mirror + image unification).

import { createClient } from "@supabase/supabase-js";
import { pullShopifyImages } from "../../../../../_lib/shopify/pull-product-images.js";

export const config = { maxDuration: 60 };

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
  const tail = parts.lastIndexOf("pull-shopify-images");
  return tail > 0 ? parts[tail - 1] : null;
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

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const storeId = body.store_id || req.query?.store_id || null;

  try {
    const summary = await pullShopifyImages({ admin, styleId, storeId });
    return res.status(200).json(summary);
  } catch (e) {
    return res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
