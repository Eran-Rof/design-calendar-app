// api/cron/walmart-orders-nightly
//
// Tangerine P12b-2 — Walmart orders ingest cron.
//
// Runs daily at 03:30 UTC (≈ 22:30 EST / 23:30 EDT) — after the FBA cron
// (03:00) so the two marketplace ingests are back-to-back, both before
// the Xoro mirror at 01:30 UTC (which has a 24h-ish lag anyway). For
// each active walmart_seller_accounts row:
//
//   1. Decrypt client_id + client_secret
//   2. getWalmartAccessToken (client_credentials grant)
//   3. Build WalmartClient
//   4. listOrders with createdStartDate = max(last_orders_sync_at, now - 7d)
//   5. For each order: upsert walmart_orders by
//      (walmart_seller_account_id, purchase_order_id)
//   6. getOrderItems → upsert walmart_order_items by
//      (walmart_order_id, line_number)
//   7. Update walmart_seller_accounts.last_orders_sync_at
//
// Per-account try/catch — one failing account NEVER breaks the others.
// We DO NOT post AR JEs here; that lands in P12b-3 (posting service).
//
// Manual re-run: POST /api/internal/walmart/sync-orders with body
// {walmart_seller_account_id, since?} hits the same orchestrator below
// for a single account.

import { createClient } from "@supabase/supabase-js";
import { decryptToken } from "../_lib/marketplaces/walmart/token-encryption.js";
import { getWalmartAccessToken } from "../_lib/marketplaces/walmart/auth.js";
import { WalmartClient } from "../_lib/marketplaces/walmart/client.js";
import { postWalmartOrderJe } from "../_lib/marketplaces/walmart/post-order-je.js";

export const config = { maxDuration: 300 };

const DEFAULT_LOOKBACK_DAYS = 7;
const SAFETY_MAX_PAGES = 50; // hard cap to keep one runaway account from spinning forever

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
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  try {
    const out = await runWalmartOrdersNightly(admin);
    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Orchestrator — exposed for testability. Walks every active
 * walmart_seller_accounts row and ingests orders. Per-account errors
 * are captured into `out.accounts[].error` without aborting the run.
 *
 * @param {Object} supabase  service-role client
 * @param {Object} [opts]
 * @param {string|null} [opts.account_id]    only this account (used by manual handler)
 * @param {string|null} [opts.since]         ISO timestamp override (used by manual handler)
 * @param {Object} [opts.deps]               injection point for tests
 *   - getAccessToken(clientId, clientSecret) → {access_token,...}
 *   - WalmartClient                          → constructor
 *   - decryptToken(ciphertext, iv, tag)      → plaintext
 */
export async function runWalmartOrdersNightly(supabase, opts = {}) {
  const deps = {
    getAccessToken: opts.deps?.getAccessToken || (({ clientId, clientSecret }) =>
      getWalmartAccessToken({ clientId, clientSecret })),
    ClientCtor: opts.deps?.ClientCtor || WalmartClient,
    decrypt: opts.deps?.decrypt || decryptToken,
    // P12b-3 — JE posting hook. Tests inject a stub; production calls
    // the real posting service. Per-order errors are captured into
    // acctResult.je_errors, NOT thrown — a single bad order must not
    // break the rest of the ingest.
    postJe: opts.deps?.postJe || postWalmartOrderJe,
  };

  const accounts = await loadAccounts(supabase, opts.account_id || null);
  const out = {
    started_at: new Date().toISOString(),
    accounts: [],
    total_orders_upserted: 0,
    total_items_upserted: 0,
    total_je_posted: 0,
    total_je_already_posted: 0,
    total_je_errors: 0,
    total_errors: 0,
  };

  for (const acct of accounts) {
    const acctResult = await ingestOneAccount(supabase, acct, deps, { since: opts.since || null });
    out.accounts.push(acctResult);
    out.total_orders_upserted += acctResult.orders_upserted || 0;
    out.total_items_upserted += acctResult.items_upserted || 0;
    out.total_je_posted += acctResult.je_posted || 0;
    out.total_je_already_posted += acctResult.je_already_posted || 0;
    out.total_je_errors += acctResult.je_errors?.length || 0;
    if (acctResult.error) out.total_errors += 1;
  }

  out.finished_at = new Date().toISOString();
  return out;
}

async function loadAccounts(supabase, account_id) {
  let q = supabase
    .from("walmart_seller_accounts")
    .select(
      "id, entity_id, partner_id, account_name, " +
        "client_id_ciphertext, client_id_iv, client_id_tag, " +
        "client_secret_ciphertext, client_secret_iv, client_secret_tag, " +
        "is_active, last_orders_sync_at",
    )
    .eq("is_active", true);
  if (account_id) q = q.eq("id", account_id);
  const { data, error } = await q;
  if (error) throw new Error(`load walmart_seller_accounts failed: ${error.message}`);
  return Array.isArray(data) ? data : [];
}

/**
 * Process a single seller account. Captures every throw into
 * acctResult.error rather than rethrowing — the parent orchestrator
 * needs per-account isolation.
 */
export async function ingestOneAccount(supabase, acct, deps, { since } = {}) {
  const acctResult = {
    walmart_seller_account_id: acct.id,
    partner_id: acct.partner_id,
    account_name: acct.account_name,
    orders_seen: 0,
    orders_upserted: 0,
    items_upserted: 0,
    pages_walked: 0,
    // P12b-3 — JE posting bookkeeping (per-account, never throws).
    je_posted: 0,
    je_already_posted: 0,
    je_errors: [],
    error: null,
  };

  try {
    if (
      acct.client_id_ciphertext == null ||
      acct.client_id_iv == null ||
      acct.client_id_tag == null ||
      acct.client_secret_ciphertext == null ||
      acct.client_secret_iv == null ||
      acct.client_secret_tag == null
    ) {
      throw new Error("account missing client_id / client_secret ciphertext triple");
    }
    const clientId = deps.decrypt(
      acct.client_id_ciphertext,
      acct.client_id_iv,
      acct.client_id_tag,
    );
    const clientSecret = deps.decrypt(
      acct.client_secret_ciphertext,
      acct.client_secret_iv,
      acct.client_secret_tag,
    );

    const tok = await deps.getAccessToken({ clientId, clientSecret });
    const client = new deps.ClientCtor({
      partnerId: acct.partner_id,
      accessToken: tok.access_token,
    });

    const createdStartDate = computeStartDate(since || acct.last_orders_sync_at);
    const createdEndDate = new Date().toISOString();

    let cursor = null;
    let page = 0;
    do {
      const { data, nextCursor } = await client.listOrders({
        createdStartDate,
        createdEndDate,
        nextCursor: cursor,
      });
      page += 1;
      acctResult.pages_walked = page;
      const orders = Array.isArray(data) ? data : [];
      acctResult.orders_seen += orders.length;
      for (const order of orders) {
        const wm_order_row = await upsertOrder(supabase, acct, order);
        if (wm_order_row) {
          acctResult.orders_upserted += 1;
          const itemsUpserted = await upsertOrderItems(supabase, client, wm_order_row, order);
          acctResult.items_upserted += itemsUpserted;

          // P12b-3 — auto-post AR JE after each upsert. Per-order
          // failures land in je_errors so they're visible in the cron
          // summary but never block the rest of the run. Idempotent:
          // already_posted is a normal outcome (re-ingest doesn't
          // double-post).
          try {
            const r = await deps.postJe({
              walmartOrderId: wm_order_row.id,
              adminClient: supabase,
            });
            if (r?.status === "posted") acctResult.je_posted += 1;
            else if (r?.status === "already_posted") acctResult.je_already_posted += 1;
          } catch (jeErr) {
            acctResult.je_errors.push({
              walmart_order_id: wm_order_row.id,
              purchase_order_id: wm_order_row.purchase_order_id,
              code: jeErr?.code || null,
              error: jeErr instanceof Error ? jeErr.message : String(jeErr),
            });
          }
        }
      }
      cursor = nextCursor || null;
      if (page >= SAFETY_MAX_PAGES) break;
    } while (cursor);

    await supabase
      .from("walmart_seller_accounts")
      .update({
        last_orders_sync_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", acct.id);
  } catch (e) {
    acctResult.error = e instanceof Error ? e.message : String(e);
  }

  return acctResult;
}

/**
 * Compute the createdStartDate filter:
 *   max(since|last_orders_sync_at, now - 7d)
 */
export function computeStartDate(lastSyncIso, nowMs = Date.now()) {
  const lookbackMs = nowMs - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const lookbackIso = new Date(lookbackMs).toISOString();
  if (!lastSyncIso) return lookbackIso;
  const lastMs = Date.parse(lastSyncIso);
  if (!Number.isFinite(lastMs)) return lookbackIso;
  return lastMs > lookbackMs ? new Date(lastMs).toISOString() : lookbackIso;
}

/**
 * Upsert a single order into walmart_orders. Returns the upserted row
 * (with id) on success, null on hard error.
 */
async function upsertOrder(supabase, acct, order) {
  const purchase_order_id = String(
    order?.purchaseOrderId ?? order?.purchase_order_id ?? order?.purchaseorderId ?? "",
  );
  if (!purchase_order_id) return null;

  const customer_order_id = order?.customerOrderId ?? order?.customer_order_id ?? null;
  const order_date = order?.orderDate || order?.order_date || null;
  const order_status = pickOrderStatus(order);
  const ship_node_type = order?.shipNode?.type || order?.shipNodeType || order?.ship_node_type || null;

  const totals = extractOrderTotals(order);

  const row = {
    entity_id: acct.entity_id,
    walmart_seller_account_id: acct.id,
    purchase_order_id,
    customer_order_id,
    order_date: order_date ? toIso(order_date) : null,
    order_status,
    ship_node_type,
    currency: totals.currency || "USD",
    order_total_cents: totals.order_total_cents,
    item_subtotal_cents: totals.item_subtotal_cents,
    tax_collected_cents: totals.tax_collected_cents,
    shipping_cents: totals.shipping_cents,
    discount_cents: totals.discount_cents,
    raw_payload: order,
    source: "walmart",
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("walmart_orders")
    .upsert(row, { onConflict: "walmart_seller_account_id,purchase_order_id" })
    .select("id, purchase_order_id")
    .maybeSingle();
  if (error) {
    throw new Error(`walmart_orders upsert failed (${purchase_order_id}): ${error.message}`);
  }
  return data;
}

/**
 * Pull order items via GET /v3/orders/{id}/lines and upsert each into
 * walmart_order_items. If the order payload already carried the lines
 * inline, we use those without an extra round-trip.
 */
async function upsertOrderItems(supabase, client, wm_order_row, orderPayload) {
  let lines =
    orderPayload?.orderLines?.orderLine ??
    orderPayload?.order?.orderLines?.orderLine ??
    null;
  if (!lines) {
    try {
      const r = await client.getOrderItems(wm_order_row.purchase_order_id);
      lines = r?.data || [];
    } catch (e) {
      // surface as a soft error so the order row still exists, but bail.
      throw new Error(`getOrderItems(${wm_order_row.purchase_order_id}): ${e.message || e}`);
    }
  }
  const list = Array.isArray(lines) ? lines : (lines ? [lines] : []);
  if (list.length === 0) return 0;

  const rows = list.map((ln, idx) => extractLineRow(ln, idx, wm_order_row));
  const { error } = await supabase
    .from("walmart_order_items")
    .upsert(rows, { onConflict: "walmart_order_id,line_number" });
  if (error) {
    throw new Error(`walmart_order_items upsert failed: ${error.message}`);
  }
  return rows.length;
}

export function extractLineRow(ln, idx, wm_order_row) {
  const line_number = Number(ln?.lineNumber ?? ln?.line_number ?? idx + 1);
  const item_sku = ln?.item?.sku ?? ln?.sku ?? ln?.item_sku ?? null;
  const product_name = ln?.item?.productName ?? ln?.productName ?? ln?.product_name ?? null;
  const quantity = pickInt(
    ln?.orderLineQuantity?.amount ?? ln?.quantity ?? ln?.amount,
  );
  const unit_price_cents = pickCents(
    ln?.charges?.charge?.[0]?.chargeAmount?.amount ?? ln?.unitPrice ?? ln?.unit_price,
  );
  const line_total_cents = pickCents(ln?.lineTotal ?? ln?.line_total ?? null);
  const tax_cents = pickCents(ln?.tax?.amount ?? ln?.tax_cents);

  return {
    walmart_order_id: wm_order_row.id,
    line_number: Number.isFinite(line_number) && line_number > 0 ? line_number : idx + 1,
    item_sku,
    product_name,
    quantity,
    unit_price_cents,
    line_total_cents,
    tax_cents: tax_cents ?? 0,
    raw_payload: ln,
  };
}

function pickOrderStatus(order) {
  // Walmart sometimes ships status under orderLines per-line. We pull a
  // top-level hint if present, else fall back to the first line's status.
  if (order?.orderStatus) return String(order.orderStatus);
  if (order?.status) return String(order.status);
  const first = order?.orderLines?.orderLine?.[0]?.orderLineStatuses?.orderLineStatus?.[0]?.status;
  if (first) return String(first);
  return null;
}

export function extractOrderTotals(order) {
  // Walmart orders don't always carry a header total; we sum charges across
  // lines when present. amount fields are decimal strings — convert to
  // cents (integer) to keep schema columns as bigint.
  let order_total = null;
  let item_subtotal = 0;
  let tax = 0;
  let shipping = 0;
  let discount = 0;
  let currency = null;

  const lines = order?.orderLines?.orderLine || [];
  const list = Array.isArray(lines) ? lines : [lines];
  for (const ln of list) {
    const charges = ln?.charges?.charge || [];
    const chargeList = Array.isArray(charges) ? charges : [charges];
    for (const ch of chargeList) {
      const amount = Number(ch?.chargeAmount?.amount);
      if (!Number.isFinite(amount)) continue;
      const cents = Math.round(amount * 100);
      const cur = ch?.chargeAmount?.currency || null;
      if (cur && !currency) currency = cur;
      const cat = String(ch?.chargeType || ch?.chargeCategory || "").toUpperCase();
      if (cat.includes("TAX")) tax += cents;
      else if (cat.includes("SHIPPING") || cat.includes("SHIP")) shipping += cents;
      else if (cat.includes("DISCOUNT")) discount += cents;
      else item_subtotal += cents;
    }
  }
  order_total = item_subtotal + tax + shipping - discount;
  if (!Number.isFinite(order_total)) order_total = null;

  return {
    currency,
    order_total_cents: order_total,
    item_subtotal_cents: item_subtotal,
    tax_collected_cents: tax,
    shipping_cents: shipping,
    discount_cents: discount,
  };
}

function pickInt(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function pickCents(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function toIso(v) {
  if (v instanceof Date) return v.toISOString();
  const s = String(v);
  // Pass through ISO; otherwise try Date parsing.
  const d = new Date(s);
  if (Number.isFinite(d.getTime())) return d.toISOString();
  return s;
}
