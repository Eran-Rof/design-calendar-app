// api/shopify/collections.js
//
// Planning ingest: Shopify collections. Stored raw so the data-quality
// scanner can flag products that are in zero collections (merchandising
// smell) and so Phase 1 can optionally use collection handles as category
// hints.

import { shopifyFetch, storefrontCodes } from "../../_lib/shopify-client.js";
import { insertRawShopify, supabaseAdminFromEnv } from "../../_lib/planning-raw.js";

export const config = { maxDuration: 120 };

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
    return res.status(501).json({ error: "SHOPIFY_NOT_CONFIGURED" });
  }

  // Custom + smart collections live at different endpoints; we pull both
  // so the raw record is complete. Shopify returns them as `custom_collections`
  // and `smart_collections` top-level arrays.
  const [custom, smart] = await Promise.all([
    shopifyFetch({ storefront, resource: "custom_collections", query: { limit: "250" } }),
    shopifyFetch({ storefront, resource: "smart_collections", query: { limit: "250" } }),
  ]);
  const customData = custom.ok && Array.isArray(custom.body?.custom_collections) ? custom.body.custom_collections : [];
  const smartData = smart.ok && Array.isArray(smart.body?.smart_collections) ? smart.body.smart_collections : [];
  const total = customData.length + smartData.length;

  const raw = await insertRawShopify(admin, {
    endpoint: "collections",
    storefrontCode: storefront,
    params: { storefront },
    payload: { custom_collections: customData, smart_collections: smartData },
    recordCount: total,
    ingestedBy: "api/shopify/collections",
  });
  if (raw.error) return res.status(500).json({ error: "RAW_WRITE_FAILED", details: raw.error });

  return res.status(200).json({
    ok: true,
    raw_payload_id: raw.id,
    deduped: raw.deduped,
    record_count: total,
    storefront,
    custom_count: customData.length,
    smart_count: smartData.length,
  });
}
