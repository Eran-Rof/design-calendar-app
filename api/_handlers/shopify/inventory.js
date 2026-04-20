// api/shopify/inventory.js
//
// Planning ingest: Shopify inventory levels.
//
// Architectural caveat — flagged per Phase 0 scope: Shopify is NOT our
// source of truth for inventory. Xoro is. This endpoint exists so the
// ecom planner can detect "Shopify says we have 0 but Xoro says 50"
// mismatches; it should never be used to drive replenishment.
//
// Shopify REST `inventory_levels.json` requires `location_ids` and/or
// `inventory_item_ids` — there's no "dump everything" mode. Caller is
// expected to pass one or the other. If neither is supplied we return
// the location catalog so the caller knows what to pass next.

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
  if (!storefront) return res.status(501).json({ error: "SHOPIFY_NOT_CONFIGURED" });

  const locationIds = url.searchParams.get("location_ids") || "";
  const inventoryItemIds = url.searchParams.get("inventory_item_ids") || "";

  if (!locationIds && !inventoryItemIds) {
    // Return the location list so the caller can pick one.
    const locs = await shopifyFetch({ storefront, resource: "locations", query: {} });
    return res.status(200).json({
      ok: false,
      hint: "Pass location_ids=<comma_list> or inventory_item_ids=<comma_list>.",
      locations: locs.body?.locations ?? [],
    });
  }

  const query = { limit: "250" };
  if (locationIds) query.location_ids = locationIds;
  if (inventoryItemIds) query.inventory_item_ids = inventoryItemIds;

  const r = await shopifyFetch({ storefront, resource: "inventory_levels", query });
  if (!r.ok) return res.status(r.status || 502).json({ ok: false, shopify: r.body });
  const data = Array.isArray(r.body?.inventory_levels) ? r.body.inventory_levels : [];

  const today = new Date().toISOString().slice(0, 10);
  const raw = await insertRawShopify(admin, {
    endpoint: "inventory",
    storefrontCode: storefront,
    params: query,
    payload: { inventory_levels: data },
    periodStart: today,
    periodEnd: today,
    recordCount: data.length,
    ingestedBy: "api/shopify/inventory",
  });
  if (raw.error) return res.status(500).json({ error: "RAW_WRITE_FAILED", details: raw.error });

  return res.status(200).json({
    ok: true,
    raw_payload_id: raw.id,
    deduped: raw.deduped,
    record_count: data.length,
    storefront,
  });
}
