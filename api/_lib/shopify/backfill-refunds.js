// api/_lib/shopify/backfill-refunds.js
//
// Tangerine P11-6 — Shopify refunds backfill orchestrator.
//
// Safety net for the refunds/create webhook (P11-6 webhook handler). If a
// refund webhook is dropped, delayed, or never delivered, this orchestrator
// catches it by walking every active store and listing recent orders'
// refunds[] via the Shopify REST API.
//
// Flow (per shopify_stores row):
//   1. Decrypt access_token via token-encryption.decryptToken.
//   2. Build a ShopifyClient.
//   3. Read parent shopify_orders rows from the last `sinceHoursAgo` window
//      (financial_status IN ('paid','partially_refunded','refunded') is the
//      candidate set — Shopify won't issue a refund against an unpaid order).
//   4. For each candidate order, call client.listRefunds(shopifyOrderId).
//   5. For each returned refund, upsert shopify_refunds (keyed by
//      shopify_refund_id) and — if not already linked — call
//      processShopifyRefund.
//   6. Update shopify_stores.last_backfill_at = now.
//
// Per-store error isolation: any thrown error inside one store's loop is
// caught, recorded, and the next store proceeds. Per-refund errors are
// captured on the per-store summary so a single bad refund doesn't sink
// the page.
//
// Idempotency:
//   - Upserts keyed by shopify_refund_id → re-runs are no-ops.
//   - processShopifyRefund is idempotent on shopify_refunds.ar_credit_memo_id.

import { ShopifyClient } from "./client.js";
import { decryptToken as defaultDecryptToken } from "./token-encryption.js";
import { processShopifyRefund as defaultProcessShopifyRefund } from "./process-refund.js";
import {
  buildRefundRow,
  upsertAndProcessRefund as defaultUpsertAndProcessRefund,
} from "../../_handlers/internal/shopify/webhooks/refunds.js";

const DEFAULT_SINCE_HOURS = 24 * 30; // 30 days

/**
 * Compute the `since` ISO timestamp for a backfill window. Exported for
 * unit tests.
 */
export function computeSinceIso(sinceHoursAgo, nowMs = Date.now()) {
  const hours = Number(sinceHoursAgo);
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error(`computeSinceIso: sinceHoursAgo must be a positive number (got ${sinceHoursAgo})`);
  }
  return new Date(nowMs - hours * 60 * 60 * 1000).toISOString();
}

/**
 * Main orchestrator.
 *
 * @param {Object} args
 * @param {Object} args.adminClient
 * @param {number} [args.sinceHoursAgo=720]
 * @param {Object} [args.deps]
 * @returns {Promise<{
 *   stores_processed: number,
 *   refunds_upserted: number,
 *   refunds_processed: number,
 *   refunds_already_processed: number,
 *   errors: string[],
 *   per_store: Array<*>,
 * }>}
 */
export async function backfillShopifyRefunds({
  adminClient,
  sinceHoursAgo = DEFAULT_SINCE_HOURS,
  deps = {},
} = {}) {
  if (!adminClient || typeof adminClient.from !== "function") {
    throw new Error("adminClient must be a Supabase client");
  }
  const effectiveDeps = {
    decryptToken: defaultDecryptToken,
    makeClient: (opts) => new ShopifyClient(opts),
    processShopifyRefund: defaultProcessShopifyRefund,
    upsertAndProcessRefund: defaultUpsertAndProcessRefund,
    now: () => Date.now(),
    ...deps,
  };

  const sinceIso = computeSinceIso(sinceHoursAgo, effectiveDeps.now());

  const { data: stores, error: sErr } = await adminClient
    .from("shopify_stores")
    .select(
      "id, entity_id, shopify_domain, api_version, " +
      "access_token_ciphertext, access_token_iv, access_token_tag",
    )
    .eq("is_active", true)
    .not("access_token_ciphertext", "is", null);
  if (sErr) {
    throw new Error(`shopify_stores read failed: ${sErr.message}`);
  }

  const summary = {
    since: sinceIso,
    stores_processed: 0,
    refunds_upserted: 0,
    refunds_processed: 0,
    refunds_already_processed: 0,
    errors: [],
    per_store: [],
  };

  for (const store of stores || []) {
    summary.stores_processed += 1;
    const storeSummary = {
      shopify_store_id: store.id,
      shopify_domain: store.shopify_domain,
      orders_scanned: 0,
      refunds_upserted: 0,
      refunds_processed: 0,
      refunds_already_processed: 0,
      cursor_updated: false,
      error: null,
      refund_errors: [],
    };
    summary.per_store.push(storeSummary);

    try {
      await backfillStoreRefunds({
        adminClient,
        store,
        sinceIso,
        deps: effectiveDeps,
        storeSummary,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      storeSummary.error = msg;
      summary.errors.push(`shopify_store ${store.id} (${store.shopify_domain}): ${msg}`);
    }

    summary.refunds_upserted          += storeSummary.refunds_upserted;
    summary.refunds_processed         += storeSummary.refunds_processed;
    summary.refunds_already_processed += storeSummary.refunds_already_processed;
  }

  return summary;
}

/**
 * Backfill one store's refunds. Exported for unit tests.
 */
export async function backfillStoreRefunds({
  adminClient, store, sinceIso, deps, storeSummary,
}) {
  // 1. Decrypt token + build client.
  let accessToken;
  try {
    accessToken = deps.decryptToken(
      store.access_token_ciphertext,
      store.access_token_iv,
      store.access_token_tag,
    );
  } catch (e) {
    throw new Error(`decrypt access_token failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const client = deps.makeClient({
    shopifyDomain: store.shopify_domain,
    accessToken,
    apiVersion: store.api_version || undefined,
  });

  // 2. List recent candidate orders for this store. We scope to orders whose
  // financial_status indicates refund eligibility; Shopify never issues a
  // refund against pending/voided orders.
  const { data: orders, error: oErr } = await adminClient
    .from("shopify_orders")
    .select("id, shopify_order_id, total_amount_cents, ar_invoice_id, entity_id, financial_status, processed_at")
    .eq("shopify_store_id", store.id)
    .in("financial_status", ["paid", "partially_refunded", "refunded"])
    .gte("processed_at", sinceIso)
    .order("processed_at", { ascending: false })
    .limit(2000);
  if (oErr) {
    throw new Error(`shopify_orders read failed: ${oErr.message}`);
  }

  storeSummary.orders_scanned = (orders || []).length;

  for (const order of orders || []) {
    try {
      const { data: refunds } = await client.listRefunds(order.shopify_order_id);
      for (const refundPayload of refunds || []) {
        // Inject order_id when missing (REST omits it from sub-resource bodies)
        if (refundPayload && !refundPayload.order_id) {
          refundPayload.order_id = order.shopify_order_id;
        }
        try {
          const result = await deps.upsertAndProcessRefund({
            admin: adminClient,
            store,
            refundPayload,
            rawTopic: "backfill",
            deps: { processShopifyRefund: deps.processShopifyRefund },
          });
          storeSummary.refunds_upserted += 1;
          if (result.status === "already_processed") {
            storeSummary.refunds_already_processed += 1;
          } else if (
            result.status === "voided" || result.status === "credit_memo_posted"
          ) {
            storeSummary.refunds_processed += 1;
          }
        } catch (e) {
          storeSummary.refund_errors.push({
            shopify_refund_id: String(refundPayload?.id ?? ""),
            shopify_order_id: order.shopify_order_id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    } catch (e) {
      storeSummary.refund_errors.push({
        shopify_order_id: order.shopify_order_id,
        error: `listRefunds failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  // 3. Bump last_backfill_at.
  const stamp = new Date(deps.now()).toISOString();
  const { error: upErr } = await adminClient
    .from("shopify_stores")
    .update({ last_backfill_at: stamp, updated_at: stamp })
    .eq("id", store.id);
  if (upErr) {
    throw new Error(`last_backfill_at update failed: ${upErr.message}`);
  }
  storeSummary.cursor_updated = true;
}

// re-export for symmetry with backfill-orders
export { buildRefundRow };
