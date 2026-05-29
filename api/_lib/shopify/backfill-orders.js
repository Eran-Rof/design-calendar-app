// api/_lib/shopify/backfill-orders.js
//
// Tangerine P11-4 — Shopify backfill orchestrator catching webhook drops.
//
// Per the P11 architecture decision D10, this is the safety net for the
// orders/create + orders/updated webhooks shipped in P11-2. If the webhook
// is delivered out of order, dropped, or never delivered (eg. operator's
// app + Vercel both down during the Shopify retry window), the backfill
// catches it.
//
// Flow (per shopify_stores row):
//   1. Decrypt access_token via token-encryption.decryptToken.
//   2. Build a ShopifyClient.
//   3. Walk listOrders pages with `since` = now - sinceHoursAgo + status='any'
//      until no nextPageInfo.
//   4. For each order:
//      - Upsert shopify_orders row keyed by (shopify_store_id, shopify_order_id)
//        — same shape the webhook produces (P11-2 buildOrderRow/buildOrderLines).
//      - Upsert shopify_order_lines rows keyed by (shopify_order_id, line_number).
//      - If the resulting shopify_orders.je_id IS NULL, call postShopifyOrderJe
//        (P11-3) to post the AR JE + ar_invoice + back-stamp.
//   5. Update shopify_stores.last_backfill_at = now.
//
// Per-store error isolation: any thrown error inside one store's loop is
// caught, recorded, and the next store proceeds. The summary surfaces the
// errors so the cron handler can include them in the response.
//
// Idempotency:
//   - Upserts are keyed by Shopify's external id → re-runs are no-ops once
//     a row exists with the same payload hash.
//   - postShopifyOrderJe is itself idempotent on shopify_orders.je_id, so
//     calling it for an order that JUST got posted (by webhook racing us)
//     short-circuits with status='already_posted' rather than double-posting.
//
// xlsx N/A — pure HTTP + DB orchestration.

import { ShopifyClient } from "./client.js";
import { decryptToken as defaultDecryptToken } from "./token-encryption.js";
import { postShopifyOrderJe as defaultPostShopifyOrderJe } from "./post-order-je.js";
import {
  buildOrderRow,
  buildOrderLines,
} from "../../_handlers/internal/shopify/webhooks/orders.js";

const PAGE_LIMIT = 250;
const SAFETY_PAGE_CAP = 200;
const DEFAULT_SINCE_HOURS = 7;

/**
 * Compute the `since` ISO timestamp for a backfill window.
 *
 * Exported for unit tests.
 *
 * @param {number} sinceHoursAgo
 * @param {number} [nowMs]
 * @returns {string} ISO 8601
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
 * @param {Object} args.adminClient   Supabase service-role client.
 * @param {number} [args.sinceHoursAgo=7]
 * @param {Object} [args.deps]        Injection point for tests.
 *   @param {(buf,iv,tag)=>string} [args.deps.decryptToken]
 *   @param {(opts)=>ShopifyClient}  [args.deps.makeClient]
 *   @param {(args)=>Promise<*>}     [args.deps.postShopifyOrderJe]
 *   @param {()=>number}             [args.deps.now]
 * @returns {Promise<{
 *   stores_processed: number,
 *   orders_upserted: number,
 *   jes_posted: number,
 *   jes_already_posted: number,
 *   errors: string[],
 *   per_store: Array<{
 *     shopify_store_id: string,
 *     shopify_domain: string,
 *     orders_upserted: number,
 *     lines_upserted: number,
 *     jes_posted: number,
 *     jes_already_posted: number,
 *     pages_walked: number,
 *     cursor_updated: boolean,
 *     error: string|null,
 *   }>,
 * }>}
 */
export async function backfillShopifyOrders({
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
    postShopifyOrderJe: defaultPostShopifyOrderJe,
    now: () => Date.now(),
    ...deps,
  };

  const sinceIso = computeSinceIso(sinceHoursAgo, effectiveDeps.now());

  // Read all active stores. Only those with a non-null access_token_ciphertext
  // are eligible — a store row can exist before token provisioning.
  const { data: stores, error: sErr } = await adminClient
    .from("shopify_stores")
    .select(
      "id, entity_id, shopify_domain, store_name, api_version, " +
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
    orders_upserted: 0,
    jes_posted: 0,
    jes_already_posted: 0,
    errors: [],
    per_store: [],
  };

  for (const store of stores || []) {
    summary.stores_processed += 1;
    const storeSummary = {
      shopify_store_id: store.id,
      shopify_domain: store.shopify_domain,
      orders_upserted: 0,
      lines_upserted: 0,
      jes_posted: 0,
      jes_already_posted: 0,
      pages_walked: 0,
      cursor_updated: false,
      error: null,
    };
    summary.per_store.push(storeSummary);

    try {
      await backfillStore({
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

    summary.orders_upserted     += storeSummary.orders_upserted;
    summary.jes_posted          += storeSummary.jes_posted;
    summary.jes_already_posted  += storeSummary.jes_already_posted;
  }

  return summary;
}

/**
 * Backfill one store. Throws on fatal errors; caller catches per-store.
 * Exported for unit tests so a malformed-token case can be exercised in
 * isolation.
 */
export async function backfillStore({
  adminClient,
  store,
  sinceIso,
  deps,
  storeSummary,
}) {
  // 1. Decrypt token.
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

  // 2. Build client.
  const client = deps.makeClient({
    shopifyDomain: store.shopify_domain,
    accessToken,
    apiVersion: store.api_version || undefined,
  });

  // 3. Walk pages.
  let pageInfo = null;
  let safety = 0;
  while (safety < SAFETY_PAGE_CAP) {
    safety += 1;
    storeSummary.pages_walked = safety;

    const args = pageInfo
      ? { page_info: pageInfo, limit: PAGE_LIMIT }
      : { since: sinceIso, limit: PAGE_LIMIT, status: "any" };
    const { data: orders, nextPageInfo } = await client.listOrders(args);

    for (const orderPayload of orders || []) {
      try {
        await upsertAndMaybePostOrder({
          adminClient,
          store,
          orderPayload,
          deps,
          storeSummary,
        });
      } catch (e) {
        // Per-order isolation: a single bad order shouldn't sink the rest of
        // the page. Record the error on the store summary and continue.
        const msg = e instanceof Error ? e.message : String(e);
        storeSummary.order_errors = storeSummary.order_errors || [];
        storeSummary.order_errors.push({
          shopify_order_id: String(orderPayload?.id ?? ""),
          error: msg,
        });
      }
    }

    if (!nextPageInfo) break;
    pageInfo = nextPageInfo;
  }

  // 4. Bump last_backfill_at.
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

/**
 * Upsert one shopify_orders row + its lines, then post the AR JE if not
 * already posted. Mirrors the webhook handler's flow for upserts so that
 * an order materialized by either route is shape-identical.
 *
 * Exported for unit tests.
 */
export async function upsertAndMaybePostOrder({
  adminClient,
  store,
  orderPayload,
  deps,
  storeSummary,
}) {
  // ── Upsert the order row ───────────────────────────────────────────────
  const orderRow = buildOrderRow(orderPayload, store);
  const { data: upserted, error: upsertErr } = await adminClient
    .from("shopify_orders")
    .upsert(orderRow, { onConflict: "shopify_store_id,shopify_order_id" })
    .select("id, je_id")
    .single();
  if (upsertErr || !upserted) {
    throw new Error(
      `shopify_orders upsert failed for ${orderRow.shopify_order_id}: ` +
      `${upsertErr?.message || "no row returned"}`,
    );
  }
  storeSummary.orders_upserted += 1;
  const shopifyOrderUuid = upserted.id;

  // ── Upsert the lines ───────────────────────────────────────────────────
  const lines = buildOrderLines(orderPayload, shopifyOrderUuid);
  if (lines.length > 0) {
    const { error: linesErr } = await adminClient
      .from("shopify_order_lines")
      .upsert(lines, { onConflict: "shopify_order_id,line_number" });
    if (linesErr) {
      throw new Error(
        `shopify_order_lines upsert failed for order ${shopifyOrderUuid}: ${linesErr.message}`,
      );
    }
    storeSummary.lines_upserted += lines.length;
  }

  // ── Post the AR JE if not already done ─────────────────────────────────
  // The upsert returned je_id from BEFORE the upsert merged the new payload
  // (PostgREST returns post-update values). je_id is not mutated by the
  // backfill upsert (we never include je_id in orderRow), so the value
  // reflects the latest persisted state: either NULL (needs posting) or a
  // uuid (already posted by webhook or a prior backfill).
  if (upserted.je_id) {
    storeSummary.jes_already_posted += 1;
    return;
  }

  let result;
  try {
    result = await deps.postShopifyOrderJe({
      shopifyOrderId: shopifyOrderUuid,
      adminClient,
    });
  } catch (e) {
    // Per-order JE failures must NOT sink the rest of the page — wrap them
    // as a per-order error and continue. The next backfill cycle will retry.
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`postShopifyOrderJe failed for ${shopifyOrderUuid}: ${msg}`);
  }

  if (result?.status === "already_posted") {
    storeSummary.jes_already_posted += 1;
  } else if (result?.status === "posted") {
    storeSummary.jes_posted += 1;
  }
}
