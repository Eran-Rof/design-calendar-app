// api/cron/faire-orders-nightly
//
// Tangerine P12c-2 — Faire orders ingest cron.
//
// For each active `faire_shops` row:
//   1. Decrypt the static API key.
//   2. Build a FaireClient.
//   3. Walk listOrders pages with updated_at_min =
//        max(last_orders_sync_at, now - 30 days).
//      (Faire's monthly payout cadence means we look back further than the
//      24h window typical of Shopify/FBA pollers.)
//   4. For each order:
//      - Upsert the buyer into faire_buyers by (faire_shop_id,
//        faire_brand_token) — buyer_email / buyer_name from the order
//        payload.
//      - Detect first-order-for-buyer by checking
//        faire_buyers.is_first_order_completed BEFORE this upsert. If
//        false, commission_rate = 0.2500. Otherwise commission_rate =
//        0.1500. (Per D6 — the in-row split that lets the 25%/15% rule
//        live without separate COA accounts.)
//      - Upsert into faire_orders by (faire_shop_id, faire_order_id).
//      - Upsert lines into faire_order_items keyed by
//        (faire_order_id, line_number).
//      - If this was the buyer's first order, mark
//        faire_buyers.is_first_order_completed = true + set
//        first_order_at = order.placed_at.
//   5. Update faire_shops.last_orders_sync_at.
//
// Per-shop try/catch — one bad shop doesn't sink the rest. Returns a summary
// {shops_scanned, orders_upserted_total, errors, per_shop:[...]}.
//
// Schedule (vercel.json): 4 AM UTC daily — after the FBA + Walmart pollers.

import { createClient } from "@supabase/supabase-js";
import { FaireClient, FaireApiError, isFaireConfigured } from "../_lib/marketplaces/faire/client.js";
import { decryptToken } from "../_lib/marketplaces/faire/token-encryption.js";

export const config = { maxDuration: 300 };

const LOOKBACK_DAYS = 30;
const PAGE_SIZE = 50;
const SAFETY_PAGE_CAP = 200;

const FIRST_ORDER_RATE = 0.2500;
const RECURRING_RATE   = 0.1500;

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: "Server not configured" });
  }
  if (!isFaireConfigured()) {
    return res.status(200).json({ ok: true, skipped: "Faire not configured (FAIRE_TOKEN_ENC_KEY missing)" });
  }
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  let onlyShopId = null;
  let sinceOverride = null;
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    onlyShopId = url.searchParams.get("faire_shop_id");
    sinceOverride = url.searchParams.get("since");
  } catch { /* fallback to all */ }

  try {
    const out = await runFaireOrdersIngest(admin, { onlyShopId, sinceOverride });
    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Compute the per-shop lookback floor.
 *   updated_at_min = max(last_orders_sync_at, now - 30 days)
 *
 * Exported for tests.
 */
export function computeUpdatedAtMin(lastSyncAt, sinceOverride, nowMs = Date.now()) {
  if (sinceOverride) return sinceOverride;
  const floor = new Date(nowMs - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  if (!lastSyncAt) return floor.toISOString();
  const lastMs = new Date(lastSyncAt).getTime();
  if (!Number.isFinite(lastMs) || lastMs < floor.getTime()) return floor.toISOString();
  return new Date(lastMs).toISOString();
}

/**
 * @param {Object} supabase  service-role client
 * @param {Object} [opts]
 * @param {string} [opts.onlyShopId]    only run a single shop
 * @param {string} [opts.sinceOverride] override updated_at_min
 * @param {Object} [opts.deps]          injection point for tests:
 *                                      { makeClient, decryptToken, now }
 */
export async function runFaireOrdersIngest(supabase, opts = {}) {
  const deps = {
    makeClient: (apiKey) => new FaireClient({ apiKey }),
    decryptToken,
    now: () => Date.now(),
    ...(opts.deps || {}),
  };

  let q = supabase
    .from("faire_shops")
    .select("id, entity_id, shop_name, faire_shop_token, api_key_ciphertext, api_key_iv, api_key_tag, last_orders_sync_at")
    .eq("is_active", true)
    .not("api_key_ciphertext", "is", null);
  if (opts.onlyShopId) q = q.eq("id", opts.onlyShopId);

  const { data: shops, error: sErr } = await q;
  if (sErr) throw new Error(`faire_shops read failed: ${sErr.message}`);

  const summary = {
    shops_scanned: 0,
    orders_upserted_total: 0,
    lines_upserted_total: 0,
    buyers_upserted_total: 0,
    errors: [],
    per_shop: [],
  };

  for (const shop of shops || []) {
    summary.shops_scanned += 1;
    const shopSummary = {
      faire_shop_id: shop.id,
      shop_name: shop.shop_name,
      orders_upserted: 0,
      lines_upserted: 0,
      buyers_upserted: 0,
      pages_walked: 0,
      cursor_updated: false,
      error: null,
    };
    summary.per_shop.push(shopSummary);

    try {
      await ingestShop(supabase, shop, opts, deps, shopSummary);
    } catch (e) {
      const msg = e instanceof FaireApiError
        ? `Faire ${e.status}: ${e.message}`
        : (e instanceof Error ? e.message : String(e));
      shopSummary.error = msg;
      summary.errors.push(`faire_shop ${shop.id}: ${msg}`);
    }

    summary.orders_upserted_total += shopSummary.orders_upserted;
    summary.lines_upserted_total  += shopSummary.lines_upserted;
    summary.buyers_upserted_total += shopSummary.buyers_upserted;
  }

  return summary;
}

async function ingestShop(supabase, shop, opts, deps, shopSummary) {
  // 1. Decrypt API key.
  const apiKey = deps.decryptToken(
    shop.api_key_ciphertext,
    shop.api_key_iv,
    shop.api_key_tag,
  );

  // 2. Build client.
  const client = deps.makeClient(apiKey);

  // 3. Lookback floor.
  const updatedAtMin = computeUpdatedAtMin(
    shop.last_orders_sync_at,
    opts.sinceOverride,
    deps.now(),
  );

  // 4. Walk pages.
  let page = 1;
  let safety = 0;
  while (safety < SAFETY_PAGE_CAP) {
    safety += 1;
    shopSummary.pages_walked = safety;

    const { data: orders, hasNextPage } = await client.listOrders({
      updatedAtMin, limit: PAGE_SIZE, page,
    });

    for (const order of orders || []) {
      await ingestOrder(supabase, shop, order, shopSummary);
    }

    if (!hasNextPage) break;
    page += 1;
  }

  // 5. Update cursor.
  const { error: cErr } = await supabase
    .from("faire_shops")
    .update({
      last_orders_sync_at: new Date(deps.now()).toISOString(),
      updated_at: new Date(deps.now()).toISOString(),
    })
    .eq("id", shop.id);
  if (cErr) {
    throw new Error(`last_orders_sync_at update failed: ${cErr.message}`);
  }
  shopSummary.cursor_updated = true;
}

async function ingestOrder(supabase, shop, order, shopSummary) {
  // ── Resolve buyer ───────────────────────────────────────────────────────
  // Faire's payload exposes the buyer token under a few field names depending
  // on API version; pick the first non-empty.
  const brandToken =
    order.brand_token ||
    order.retailer_token ||
    order.faire_brand_token ||
    order.buyer?.brand_token ||
    order.buyer_token ||
    null;

  if (!brandToken) {
    // Can't resolve buyer — skip this order rather than insert a half-row.
    return;
  }

  const buyerName =
    order.buyer?.name ||
    order.retailer_name ||
    order.brand_name ||
    "Unknown Faire Buyer";
  const buyerEmail = order.buyer?.email || order.buyer_email || null;

  // Read the existing buyer row (if any) BEFORE upserting — we need the
  // pre-existing is_first_order_completed to make the commission split.
  const { data: existingBuyer, error: bReadErr } = await supabase
    .from("faire_buyers")
    .select("id, is_first_order_completed")
    .eq("faire_shop_id", shop.id)
    .eq("faire_brand_token", brandToken)
    .maybeSingle();
  if (bReadErr) {
    throw new Error(`faire_buyers read failed for ${brandToken}: ${bReadErr.message}`);
  }

  // First-order detection — true if the buyer row didn't exist OR
  // is_first_order_completed=false (per the cached buyer-level flag). The
  // order-level `is_first_order` flag from Faire is preferred when present.
  const apiSaysFirstOrder =
    typeof order.is_first_order === "boolean" ? order.is_first_order : null;
  const isFirstOrderForBuyer = apiSaysFirstOrder !== null
    ? apiSaysFirstOrder
    : !(existingBuyer?.is_first_order_completed === true);

  const commissionRate = isFirstOrderForBuyer ? FIRST_ORDER_RATE : RECURRING_RATE;

  // Upsert the buyer row.
  const { data: upBuyer, error: bUpErr } = await supabase
    .from("faire_buyers")
    .upsert(
      {
        entity_id: shop.entity_id,
        faire_shop_id: shop.id,
        faire_brand_token: brandToken,
        buyer_name: buyerName,
        buyer_email: buyerEmail,
        raw_payload: order.buyer || {},
        // Don't blindly overwrite is_first_order_completed on every upsert —
        // we set it explicitly after the order succeeds.
        is_first_order_completed: existingBuyer?.is_first_order_completed === true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "faire_shop_id,faire_brand_token" },
    )
    .select("id")
    .maybeSingle();
  if (bUpErr || !upBuyer) {
    throw new Error(`faire_buyers upsert failed for ${brandToken}: ${bUpErr?.message || "no row"}`);
  }
  shopSummary.buyers_upserted += 1;
  const faireBuyerId = upBuyer.id;

  // ── Compute order economics ─────────────────────────────────────────────
  const subtotalCents  = toCents(order.subtotal ?? order.subtotal_cents ?? order.subtotal_amount);
  const shippingCents  = toCents(order.shipping ?? order.shipping_cents ?? order.shipping_amount ?? 0);
  const apiCommissionCents = order.commission_cents != null ? toCents(order.commission_cents) : null;
  const commissionCents = apiCommissionCents != null
    ? apiCommissionCents
    : Math.round(subtotalCents * commissionRate);
  const netPayoutCents = subtotalCents + shippingCents - commissionCents;

  // ── Upsert order ────────────────────────────────────────────────────────
  const orderRow = {
    entity_id: shop.entity_id,
    faire_shop_id: shop.id,
    faire_order_id: String(order.id || order.order_id || order.faire_order_id),
    faire_brand_token: brandToken,
    faire_buyer_id: faireBuyerId,
    placed_at: order.placed_at || order.created_at || new Date().toISOString(),
    ship_by_at: order.ship_by_at || order.ship_by || null,
    order_status: (order.state || order.status || "NEW").toUpperCase(),
    currency: order.currency || "USD",
    subtotal_cents: subtotalCents,
    shipping_cents: shippingCents,
    commission_cents: commissionCents,
    commission_rate: commissionRate,
    net_payout_cents: netPayoutCents,
    is_first_order_for_buyer: isFirstOrderForBuyer,
    raw_payload: order,
    source: "faire",
    updated_at: new Date().toISOString(),
  };

  const { data: upOrder, error: oUpErr } = await supabase
    .from("faire_orders")
    .upsert(orderRow, { onConflict: "faire_shop_id,faire_order_id" })
    .select("id")
    .maybeSingle();
  if (oUpErr || !upOrder) {
    throw new Error(`faire_orders upsert failed for ${orderRow.faire_order_id}: ${oUpErr?.message || "no row"}`);
  }
  shopSummary.orders_upserted += 1;
  const faireOrderRowId = upOrder.id;

  // ── Upsert line items ───────────────────────────────────────────────────
  const items = Array.isArray(order.items) ? order.items
              : Array.isArray(order.line_items) ? order.line_items
              : [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const lineRow = {
      faire_order_id: faireOrderRowId,
      line_number: i + 1,
      faire_item_token: String(it.id || it.item_token || it.faire_item_token || `line-${i + 1}`),
      sku: it.sku || it.product_sku || null,
      product_name: it.product_name || it.name || "Unknown product",
      quantity: Number(it.quantity ?? 1),
      unit_price_wholesale_cents: toCents(it.unit_price_wholesale ?? it.unit_price ?? it.price ?? 0),
      line_total_cents: toCents(it.line_total ?? it.total ?? (Number(it.quantity ?? 1) * Number(it.unit_price_wholesale ?? it.unit_price ?? 0))),
      raw_payload: it,
    };
    const { error: lErr } = await supabase
      .from("faire_order_items")
      .upsert(lineRow, { onConflict: "faire_order_id,line_number" });
    if (lErr) {
      throw new Error(`faire_order_items upsert failed for line ${i + 1}: ${lErr.message}`);
    }
    shopSummary.lines_upserted += 1;
  }

  // ── If this was the buyer's first order, flip the buyer flag ───────────
  if (isFirstOrderForBuyer && !(existingBuyer?.is_first_order_completed === true)) {
    const { error: fErr } = await supabase
      .from("faire_buyers")
      .update({
        is_first_order_completed: true,
        first_order_at: orderRow.placed_at,
        updated_at: new Date().toISOString(),
      })
      .eq("id", faireBuyerId);
    if (fErr) {
      throw new Error(`faire_buyers first-order flag set failed: ${fErr.message}`);
    }
  }
}

/**
 * Coerce a Faire money value to integer cents. Faire returns amounts in two
 * shapes depending on field:
 *   - Float dollars: 12.34   → 1234 cents
 *   - Cents int:     1234    → 1234 cents
 * We assume any value with a fractional part is dollars and round to cents;
 * otherwise we treat as already-cents.
 *
 * Exported for tests.
 */
export function toCents(value) {
  if (value == null) return 0;
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return 0;
  // If it has a fractional component, it's dollars.
  if (Math.floor(num) !== num) return Math.round(num * 100);
  // Whole numbers ≥ 100,000 (i.e. >= $1000) are almost certainly already-cents.
  // Whole-number small values are ambiguous — treat as cents to match
  // Faire's standardized "_cents" field convention.
  return Math.round(num);
}
