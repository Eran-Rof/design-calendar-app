// api/shopify/products.js
//
// Planning ingest: Shopify products + variants. Primary use is to keep
// product_channel_status fresh and to feed Shopify SKUs into the
// data-quality SKU-mapping checks.

import { shopifyFetch, storefrontCodes } from "../_lib/shopify-client.js";
import { insertRawShopify, supabaseAdminFromEnv } from "../_lib/planning-raw.js";

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const admin = supabaseAdminFromEnv();
  if (!admin) return res.status(500).json({ error: "SUPABASE_NOT_CONFIGURED" });

  const url = new URL(req.url, `https://${req.headers.host}`);
  const storefront = url.searchParams.get("storefront") || storefrontCodes()[0];
  if (!storefront) {
    return res.status(501).json({
      error: "SHOPIFY_NOT_CONFIGURED",
      hint: "Set SHOPIFY_STORES env var (JSON) or SHOPIFY_SHOP_DOMAIN+SHOPIFY_ADMIN_TOKEN",
    });
  }
  const updatedAtMin = url.searchParams.get("updated_at_min") || "";
  const limit = url.searchParams.get("limit") || "250";

  const query = { limit, fields: "id,title,handle,product_type,vendor,status,published_at,tags,variants" };
  if (updatedAtMin) query.updated_at_min = updatedAtMin;

  const r = await shopifyFetch({ storefront, resource: "products", query });
  if (!r.ok) return res.status(r.status || 502).json({ ok: false, shopify: r.body });
  const data = Array.isArray(r.body?.products) ? r.body.products : [];

  const raw = await insertRawShopify(admin, {
    endpoint: "products",
    storefrontCode: storefront,
    params: { ...query },
    payload: { products: data },
    recordCount: data.length,
    ingestedBy: "api/shopify/products",
  });
  if (raw.error) return res.status(500).json({ error: "RAW_WRITE_FAILED", details: raw.error });

  return res.status(200).json({
    ok: true,
    raw_payload_id: raw.id,
    deduped: raw.deduped,
    record_count: data.length,
    storefront,
    sample: data.slice(0, 2),
  });
}
