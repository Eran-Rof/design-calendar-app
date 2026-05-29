// api/_lib/marketplaces/fba/ingest-orders.js
//
// Core orders-ingest logic for FBA. Exported separately from the cron
// handler so vitest tests can drive it without going through HTTP.
//
// Flow per fba_seller_accounts row:
//   1. Decrypt lwa_client_id / lwa_client_secret / refresh_token
//   2. refreshLwaAccessToken() → access_token
//   3. new SpApiClient({region, accessToken, marketplaceId})
//   4. lastUpdatedAfter = max(last_orders_sync_at, now - 14 days)
//   5. listOrders → page until no NextToken
//   6. For each order: upsert fba_orders (dedup: fba_seller_account_id + amazon_order_id)
//   7. getOrderItems → upsert fba_order_items (dedup: fba_order_id + order_item_id)
//   8. UPDATE fba_seller_accounts.last_orders_sync_at = now
//
// AR-invoice JE posting is NOT done here — that's P12a-3.

import { decryptToken } from "./token-encryption.js";
import { refreshLwaAccessToken } from "./lwa.js";
import { SpApiClient } from "./client.js";
import { postFbaOrderJe } from "./post-order-je.js";

const MAX_LOOKBACK_DAYS = 14;
const MAX_PAGES_PER_ACCOUNT = 50; // 50 * 100 = 5000 orders/run/account cap

/**
 * Compute the LastUpdatedAfter window for a single account.
 * If last_orders_sync_at is older than 14 days (or null), clamp to 14 days.
 *
 * @param {string|null} lastSyncAt   ISO string or null
 * @param {Date}        [now]
 * @returns {string}                 ISO timestamp
 */
export function computeSinceTime(lastSyncAt, now = new Date()) {
  const minTime = new Date(now.getTime() - MAX_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  if (!lastSyncAt) return minTime.toISOString();
  const last = new Date(lastSyncAt);
  if (!Number.isFinite(last.getTime())) return minTime.toISOString();
  if (last < minTime) return minTime.toISOString();
  return last.toISOString();
}

/**
 * Map an SP-API Order payload to the fba_orders row shape.
 *
 * @param {Object} order   raw SP-API order
 * @param {string} fbaSellerAccountId
 * @returns {Object}       fba_orders insert payload
 */
export function mapOrderRow(order, fbaSellerAccountId) {
  const total = order.OrderTotal || {};
  const amountStr = total.Amount;
  const orderTotalCents = amountStr ? Math.round(Number(amountStr) * 100) : 0;
  return {
    fba_seller_account_id: fbaSellerAccountId,
    amazon_order_id: order.AmazonOrderId,
    purchase_date: order.PurchaseDate,
    last_update_date: order.LastUpdateDate,
    order_status: order.OrderStatus,
    fulfillment_channel: order.FulfillmentChannel === "AFN" ? "AFN" : "MFN",
    marketplace_id: order.MarketplaceId || null,
    currency: total.CurrencyCode || "USD",
    order_total_cents: orderTotalCents,
    raw_payload: order,
  };
}

/**
 * Map an SP-API OrderItem payload to fba_order_items row shape.
 *
 * @param {Object} item   raw SP-API OrderItem
 * @param {string} fbaOrderId
 * @returns {Object}       fba_order_items insert payload
 */
export function mapOrderItemRow(item, fbaOrderId) {
  const itemPrice = item.ItemPrice || {};
  const itemTax = item.ItemTax || {};
  const promo = item.PromotionDiscount || {};
  return {
    fba_order_id: fbaOrderId,
    order_item_id: item.OrderItemId,
    asin: item.ASIN || null,
    sku: item.SellerSKU || null,
    title: item.Title || null,
    quantity_ordered: Number(item.QuantityOrdered) || 0,
    quantity_shipped: Number(item.QuantityShipped) || 0,
    item_price_cents: itemPrice.Amount ? Math.round(Number(itemPrice.Amount) * 100) : 0,
    item_tax_cents: itemTax.Amount ? Math.round(Number(itemTax.Amount) * 100) : 0,
    promotion_discount_cents: promo.Amount ? Math.round(Number(promo.Amount) * 100) : 0,
    raw_payload: item,
  };
}

/**
 * Decrypt the LWA credentials triple from a fba_seller_accounts row.
 *
 * Each *_ciphertext / *_iv / *_tag triple is decrypted to its plaintext.
 *
 * @param {Object} acct  row from fba_seller_accounts
 * @returns {{clientId: string, clientSecret: string, refreshToken: string}}
 */
export function decryptAccountCreds(acct) {
  if (!acct.lwa_client_id_ciphertext || !acct.lwa_client_id_iv || !acct.lwa_client_id_tag) {
    throw new Error("account missing encrypted lwa_client_id triple");
  }
  if (!acct.lwa_client_secret_ciphertext || !acct.lwa_client_secret_iv || !acct.lwa_client_secret_tag) {
    throw new Error("account missing encrypted lwa_client_secret triple");
  }
  if (!acct.refresh_token_ciphertext || !acct.refresh_token_iv || !acct.refresh_token_tag) {
    throw new Error("account missing encrypted refresh_token triple");
  }
  const clientId = decryptToken(
    acct.lwa_client_id_ciphertext, acct.lwa_client_id_iv, acct.lwa_client_id_tag,
  );
  const clientSecret = decryptToken(
    acct.lwa_client_secret_ciphertext, acct.lwa_client_secret_iv, acct.lwa_client_secret_tag,
  );
  const refreshToken = decryptToken(
    acct.refresh_token_ciphertext, acct.refresh_token_iv, acct.refresh_token_tag,
  );
  return { clientId, clientSecret, refreshToken };
}

/**
 * Sync orders for a single fba_seller_accounts row.
 *
 * @param {Object} supabase  service-role client
 * @param {Object} acct      fba_seller_accounts row (with creds + sync timestamps)
 * @param {Object} [opts]
 * @param {Date}    [opts.now]
 * @param {string}  [opts.since]              override the computed lastUpdatedAfter
 * @param {Object}  [opts.deps]
 * @param {Function}[opts.deps.makeClient]    factory (clientArgs) → SpApiClient (for tests)
 * @param {Function}[opts.deps.refreshAccessToken]  override LWA refresh
 * @returns {Promise<Object>} summary
 */
export async function syncAccountOrders(supabase, acct, opts = {}) {
  const now = opts.now || new Date();
  const summary = {
    fba_seller_account_id: acct.id,
    orders_upserted: 0,
    items_upserted: 0,
    pages: 0,
    since: null,
    error: null,
    je_posted: 0,
    je_errors: 0,
  };
  // P12a-3 — JE auto-post is opt-out by default; tests can disable it via
  // opts.postJe = false. Production cron leaves it on.
  const postJe = opts.postJe !== false;
  const postFn = opts.deps?.postFbaOrderJe || postFbaOrderJe;

  const since = opts.since || computeSinceTime(acct.last_orders_sync_at, now);
  summary.since = since;

  const refreshAccessToken = opts.deps?.refreshAccessToken || refreshLwaAccessToken;
  const makeClient = opts.deps?.makeClient || ((clientArgs) => new SpApiClient(clientArgs));

  const creds = decryptAccountCreds(acct);
  const tokenResp = await refreshAccessToken({
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    refreshToken: creds.refreshToken,
  });

  const client = makeClient({
    region: acct.region,
    accessToken: tokenResp.access_token,
    marketplaceId: acct.marketplace_id,
    awsRoleArn: acct.aws_role_arn || null,
  });

  let nextToken = null;
  let firstPage = true;
  for (let page = 0; page < MAX_PAGES_PER_ACCOUNT; page++) {
    const listResp = firstPage
      ? await client.listOrders({ lastUpdatedAfter: since, maxResults: 100 })
      : await client.listOrders({ lastUpdatedAfter: since, nextToken, maxResults: 100 });
    firstPage = false;
    summary.pages++;
    const orders = listResp.Orders || [];
    for (const order of orders) {
      if (!order.AmazonOrderId) continue;
      const row = mapOrderRow(order, acct.id);
      const { data: upserted, error: upErr } = await supabase
        .from("fba_orders")
        .upsert(row, { onConflict: "fba_seller_account_id,amazon_order_id" })
        .select("id, amazon_order_id")
        .maybeSingle();
      if (upErr) throw new Error(`fba_orders upsert failed for ${order.AmazonOrderId}: ${upErr.message}`);
      summary.orders_upserted++;
      // Fetch + upsert items.
      const itemsResp = await client.getOrderItems(order.AmazonOrderId);
      const items = itemsResp.OrderItems || [];
      let itemsNext = itemsResp.NextToken || null;
      while (itemsNext) {
        const more = await client.getOrderItems(order.AmazonOrderId, itemsNext);
        items.push(...(more.OrderItems || []));
        itemsNext = more.NextToken || null;
      }
      for (const item of items) {
        if (!item.OrderItemId) continue;
        const itemRow = mapOrderItemRow(item, upserted.id);
        const { error: itemErr } = await supabase
          .from("fba_order_items")
          .upsert(itemRow, { onConflict: "fba_order_id,order_item_id" });
        if (itemErr) throw new Error(`fba_order_items upsert failed for ${item.OrderItemId}: ${itemErr.message}`);
        summary.items_upserted++;
      }

      // P12a-3 — Auto-post the AR JE after the order + items are mirrored.
      // Errors here are caught + logged; they MUST NOT abort the ingest
      // loop (one bad order can't break the rest of the run, and the
      // operator can re-trigger via the manual handler).
      if (postJe) {
        try {
          await postFn({ fbaOrderId: upserted.id, adminClient: supabase });
          summary.je_posted++;
        } catch (e) {
          summary.je_errors++;
          // eslint-disable-next-line no-console
          console.warn(
            `[fba-ingest] postFbaOrderJe failed for fba_order ${upserted.id} ` +
            `(amazon_order_id=${order.AmazonOrderId}): ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }
    nextToken = listResp.NextToken || null;
    if (!nextToken) break;
  }

  // Update last_orders_sync_at — start of run, so any orders updated
  // mid-run are guaranteed picked up next run.
  const { error: updErr } = await supabase
    .from("fba_seller_accounts")
    .update({ last_orders_sync_at: now.toISOString(), updated_at: now.toISOString() })
    .eq("id", acct.id);
  if (updErr) throw new Error(`last_orders_sync_at update failed: ${updErr.message}`);

  return summary;
}

/**
 * Drive syncAccountOrders across every active fba_seller_accounts row.
 * Per-account try/catch — one failing account never breaks the others.
 *
 * @param {Object} supabase
 * @param {Object} [opts]
 * @returns {Promise<{accounts: Object[], started_at: string, finished_at: string}>}
 */
export async function ingestAllAccounts(supabase, opts = {}) {
  const started_at = new Date().toISOString();
  const { data: accounts, error } = await supabase
    .from("fba_seller_accounts")
    .select("*")
    .eq("is_active", true);
  if (error) throw new Error(`fba_seller_accounts read failed: ${error.message}`);

  const results = [];
  for (const acct of (accounts || [])) {
    try {
      const summary = await syncAccountOrders(supabase, acct, opts);
      results.push({ ok: true, ...summary });
    } catch (e) {
      results.push({
        ok: false,
        fba_seller_account_id: acct.id,
        orders_upserted: 0,
        items_upserted: 0,
        pages: 0,
        since: null,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return {
    started_at,
    finished_at: new Date().toISOString(),
    accounts: results,
  };
}
