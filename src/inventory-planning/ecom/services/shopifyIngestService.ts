// Phase 2 ingest pass: read the latest raw_shopify_payloads rows and
// upsert into the normalized planning tables. Thin wrapper around the
// Phase 0 Shopify normalizers — those were pure (payload → rows) and
// ready for this. Anything that fails reconciliation becomes a
// data-quality issue (Phase 0 pattern) rather than an exception.
//
// Scope:
//   • orders   → ip_sales_history_ecom
//   • products → ip_product_channel_status (upsert merchandising flags),
//                and ip_item_master (Phase 2 adds Shopify SKUs that the
//                Xoro item feed might not have yet)
//   • returns  → folded into ip_sales_history_ecom on the order-line,
//                matching the Phase 0 normalizer behaviour
//
// All access goes through SB_URL + SB_HEADERS, same convention as the
// other planning repos. Server-side ingest (outside of this ad-hoc
// browser path) can reuse these functions through Node if needed.

import { SB_HEADERS, SB_URL } from "../../../utils/supabase";
import type { ShopifyOrder, ShopifyProduct } from "../../types/rawPayloads";
import { normalizeShopifyOrder, normalizeShopifyProduct, normalizeShopifyProductChannelStatus } from "../../normalize/shopify";
import { reconcileItem, reconcileChannel, reconcileCategory } from "../../mapping/reconcile";
import type { IpItem, IpChannel, IpCategory } from "../../types/entities";

async function sbGet<T>(path: string): Promise<T[]> {
  if (!SB_URL) throw new Error("Supabase URL not configured");
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: SB_HEADERS });
  if (!r.ok) throw new Error(`sbGet ${path} failed: ${r.status} ${await r.text()}`);
  return r.json();
}
async function sbPost(path: string, body: unknown, prefer = "return=minimal"): Promise<void> {
  if (!SB_URL) throw new Error("Supabase URL not configured");
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: "POST",
    headers: { ...SB_HEADERS, Prefer: prefer },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`sbPost ${path} failed: ${r.status} ${await r.text()}`);
}
async function sbPatch(path: string, body: unknown): Promise<void> {
  if (!SB_URL) throw new Error("Supabase URL not configured");
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: "PATCH",
    headers: SB_HEADERS,
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`sbPatch ${path} failed: ${r.status} ${await r.text()}`);
}

export interface IngestShopifyOrdersResult {
  raw_payload_ids_processed: number;
  orders_considered: number;
  rows_inserted: number;
  sku_unmapped_count: number;
  channel_unmapped_count: number;
}

// Pull the N most recent un-normalized orders payloads and upsert rows.
export async function ingestShopifyOrders(opts: { limit?: number } = {}): Promise<IngestShopifyOrdersResult> {
  const limit = opts.limit ?? 10;
  const [rawRows, items, channels] = await Promise.all([
    sbGet<{ id: string; storefront_code: string | null; payload: { orders?: ShopifyOrder[] } }>(
      `raw_shopify_payloads?select=id,storefront_code,payload&endpoint=eq.orders&normalized_at=is.null&order=ingested_at.asc&limit=${limit}`,
    ),
    sbGet<IpItem>("ip_item_master?select=*&limit=20000"),
    sbGet<IpChannel>("ip_channel_master?select=*&limit=2000"),
  ]);

  let orders_considered = 0;
  let rows_inserted = 0;
  let sku_unmapped_count = 0;
  let channel_unmapped_count = 0;

  for (const raw of rawRows) {
    const storefront = raw.storefront_code;
    const chanMatch = reconcileChannel({ storefront_key: storefront, channel_code: storefront }, channels);
    if (!chanMatch.match) { channel_unmapped_count++; continue; }
    const orders = raw.payload?.orders ?? [];
    orders_considered += orders.length;
    const toInsert: Array<Record<string, unknown>> = [];
    for (const order of orders) {
      const normalized = normalizeShopifyOrder(order, {
        storefront_code: storefront ?? chanMatch.match.channel_code,
        raw_payload_id: raw.id,
      });
      for (const n of normalized) {
        const itemMatch = reconcileItem(
          {
            sku: n._src.sku,
            shopify_variant_id: n._src.shopify_variant_id,
            shopify_sku: n._src.sku,
          },
          items,
        );
        if (!itemMatch.match) { sku_unmapped_count++; continue; }
        const categoryMatch = itemMatch.match.category_id
          ? { match: { id: itemMatch.match.category_id } as Pick<IpCategory, "id"> | null }
          : { match: null };
        toInsert.push({
          sku_id: itemMatch.match.id,
          channel_id: chanMatch.match.id,
          category_id: categoryMatch.match?.id ?? null,
          order_number: n.order_number,
          order_date: n.order_date,
          qty: n.qty,
          returned_qty: n.returned_qty,
          net_qty: n.net_qty,
          gross_amount: n.gross_amount,
          discount_amount: n.discount_amount,
          refund_amount: n.refund_amount,
          net_amount: n.net_amount,
          currency: n.currency,
          source: "shopify",
          raw_payload_id: n.raw_payload_id,
          source_line_key: n.source_line_key,
          // customer_id: we don't reconcile ecom customers in MVP — Phase 2
          // leaves this NULL unless a future pass fills it.
        });
      }
    }
    if (toInsert.length > 0) {
      // Idempotent: unique on (source, source_line_key). merge-duplicates
      // keeps the latest values (e.g. if a refund came in after the
      // first pull, returned_qty updates).
      for (let i = 0; i < toInsert.length; i += 500) {
        const chunk = toInsert.slice(i, i + 500);
        await sbPost(
          "ip_sales_history_ecom?on_conflict=source,source_line_key",
          chunk,
          "return=minimal,resolution=merge-duplicates",
        );
        rows_inserted += chunk.length;
      }
    }
    // Mark raw as normalized.
    await sbPatch(`raw_shopify_payloads?id=eq.${raw.id}`, { normalized_at: new Date().toISOString() });
  }
  return {
    raw_payload_ids_processed: rawRows.length,
    orders_considered,
    rows_inserted,
    sku_unmapped_count,
    channel_unmapped_count,
  };
}

// Products → product_channel_status + item master upserts. Products pulls
// don't drive forecasts directly but they keep merchandising flags fresh.
export async function ingestShopifyProducts(opts: { limit?: number } = {}): Promise<{
  raw_payload_ids_processed: number;
  products_considered: number;
  channel_status_rows: number;
  items_upserted: number;
}> {
  const limit = opts.limit ?? 5;
  const [rawRows, items, channels] = await Promise.all([
    sbGet<{ id: string; storefront_code: string | null; payload: { products?: ShopifyProduct[] } }>(
      `raw_shopify_payloads?select=id,storefront_code,payload&endpoint=eq.products&normalized_at=is.null&order=ingested_at.asc&limit=${limit}`,
    ),
    sbGet<IpItem>("ip_item_master?select=*&limit=20000"),
    sbGet<IpChannel>("ip_channel_master?select=*&limit=2000"),
  ]);

  let products_considered = 0;
  let channel_status_rows = 0;
  let items_upserted = 0;

  for (const raw of rawRows) {
    const storefront = raw.storefront_code;
    const chanMatch = reconcileChannel({ storefront_key: storefront, channel_code: storefront }, channels);
    if (!chanMatch.match) continue;
    const products = raw.payload?.products ?? [];
    products_considered += products.length;
    const itemRows: Array<Record<string, unknown>> = [];
    const statusRows: Array<Record<string, unknown>> = [];
    for (const product of products) {
      const normalizedItems = normalizeShopifyProduct(product);
      for (const ni of normalizedItems) {
        // Upsert item master — Shopify is the source of truth for SKUs
        // the Xoro catalog hasn't mirrored yet.
        // NOTE: never write `attributes` from this path — it would
        // clobber the GroupName/CategoryName set by the Item Master
        // Excel uploader (PostgREST upsert replaces JSONB columns
        // wholesale, not deep-merge).
        itemRows.push({
          sku_code: ni.sku_code,
          style_code: ni.style_code,
          description: ni.description,
          color: ni.color,
          size: ni.size,
          uom: ni.uom,
          unit_price: ni.unit_price,
          lifecycle_status: ni.lifecycle_status,
          active: ni.active,
          external_refs: ni.external_refs,
        });
      }
      for (const v of product.variants ?? []) {
        const ncs = normalizeShopifyProductChannelStatus(product, v, {
          storefront_code: storefront ?? chanMatch.match.channel_code,
          raw_payload_id: raw.id,
        });
        if (!ncs) continue;
        const itemMatch = reconcileItem({ sku: ncs._src.sku, shopify_variant_id: ncs._src.shopify_variant_id }, items);
        if (!itemMatch.match) continue;
        statusRows.push({
          sku_id: itemMatch.match.id,
          channel_id: chanMatch.match.id,
          status: ncs.status,
          listed: ncs.listed,
          is_active: (product.status ?? "active") === "active" && ncs.listed,
          launch_date: ncs.published_at ? ncs.published_at.slice(0, 10) : null,
          markdown_flag: (product.tags ?? "").toLowerCase().includes("markdown") || (product.tags ?? "").toLowerCase().includes("sale"),
          inventory_policy: null,
          price: ncs.price,
          compare_at_price: ncs.compare_at_price,
          currency: ncs.currency,
          published_at: ncs.published_at,
          unpublished_at: ncs.unpublished_at,
          source: "shopify",
          raw_payload_id: ncs.raw_payload_id,
          observed_at: ncs.observed_at,
        });
      }
    }
    if (itemRows.length > 0) {
      for (let i = 0; i < itemRows.length; i += 500) {
        const chunk = itemRows.slice(i, i + 500);
        await sbPost("ip_item_master?on_conflict=sku_code", chunk, "return=minimal,resolution=merge-duplicates");
        items_upserted += chunk.length;
      }
    }
    if (statusRows.length > 0) {
      for (let i = 0; i < statusRows.length; i += 500) {
        const chunk = statusRows.slice(i, i + 500);
        await sbPost(
          "ip_product_channel_status?on_conflict=sku_id,channel_id",
          chunk,
          "return=minimal,resolution=merge-duplicates",
        );
        channel_status_rows += chunk.length;
      }
    }
    await sbPatch(`raw_shopify_payloads?id=eq.${raw.id}`, { normalized_at: new Date().toISOString() });
  }
  return {
    raw_payload_ids_processed: rawRows.length,
    products_considered,
    channel_status_rows,
    items_upserted,
  };
}
