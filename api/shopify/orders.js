// api/shopify/orders.js
//
// Planning ingest: pull Shopify orders (+refunds inline) for a given
// storefront and date window. Writes to raw_shopify_payloads.
//
// Placeholder semantics: if SHOPIFY_* env is not configured, returns 501
// without hitting Shopify — caller sees a clear "not configured" signal
// instead of a cryptic network failure.

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
  const dateFrom = url.searchParams.get("date_from") || "";
  const dateTo = url.searchParams.get("date_to") || "";
  const status = url.searchParams.get("status") || "any";
  const limit = url.searchParams.get("limit") || "250";

  const query = {
    status,
    limit,
    fields: "id,name,order_number,created_at,processed_at,currency,financial_status,fulfillment_status,cancelled_at,customer,line_items,refunds",
  };
  if (dateFrom) query.created_at_min = `${dateFrom}T00:00:00Z`;
  if (dateTo) query.created_at_max = `${dateTo}T23:59:59Z`;

  const r = await shopifyFetch({ storefront, resource: "orders", query });
  if (!r.ok) return res.status(r.status || 502).json({ ok: false, shopify: r.body });
  const data = Array.isArray(r.body?.orders) ? r.body.orders : [];

  const raw = await insertRawShopify(admin, {
    endpoint: "orders",
    storefrontCode: storefront,
    params: { ...query, date_from: dateFrom, date_to: dateTo },
    payload: { orders: data },
    periodStart: dateFrom || null,
    periodEnd: dateTo || null,
    recordCount: data.length,
    ingestedBy: "api/shopify/orders",
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
