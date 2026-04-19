// api/shopify/returns.js
//
// Planning ingest: Shopify returns/refunds. Note: refunds are already
// embedded on orders (see api/shopify/orders.js). This route exists for
// cases where we want a returns-only window (for sell-through / return
// rate KPIs) without re-pulling the full order payload.
//
// Shopify does not expose a top-level refunds list endpoint in Admin REST.
// We approximate it by pulling orders with a `financial_status` filter
// that catches refunded/partially_refunded — the raw payload preserves
// everything so the normalizer can decide later.

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
  if (!storefront) return res.status(501).json({ error: "SHOPIFY_NOT_CONFIGURED" });

  const dateFrom = url.searchParams.get("date_from") || "";
  const dateTo = url.searchParams.get("date_to") || "";
  const status = url.searchParams.get("financial_status") || "refunded,partially_refunded";

  const query = {
    status: "any",
    financial_status: status,
    limit: "250",
    fields: "id,name,order_number,created_at,processed_at,currency,financial_status,refunds,line_items",
  };
  if (dateFrom) query.updated_at_min = `${dateFrom}T00:00:00Z`;
  if (dateTo) query.updated_at_max = `${dateTo}T23:59:59Z`;

  const r = await shopifyFetch({ storefront, resource: "orders", query });
  if (!r.ok) return res.status(r.status || 502).json({ ok: false, shopify: r.body });
  const data = Array.isArray(r.body?.orders) ? r.body.orders : [];

  const raw = await insertRawShopify(admin, {
    endpoint: "returns",
    storefrontCode: storefront,
    params: query,
    payload: { orders: data },
    periodStart: dateFrom || null,
    periodEnd: dateTo || null,
    recordCount: data.length,
    ingestedBy: "api/shopify/returns",
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
