// api/internal/shopify/webhooks/orders
//
// Shopify "orders/create" + "orders/updated" webhook intake. Upserts
// shopify_orders + shopify_order_lines + the shopify_webhook_log row for
// at-least-once dedup. Does NOT post the AR invoice JE — that lands in
// P11-3 (posting service).
//
// Flow:
//   1. Read raw body for HMAC. NOTE on raw-body access:
//      The Tangerine /api/* dispatcher (api/dispatch.js → routes.js) leaves
//      req.body as whatever Vercel parsed (usually a parsed object for
//      Content-Type: application/json). Per the P11 architecture doc D11,
//      the workaround is to re-JSON.stringify req.body when no raw stream
//      is available. This is imperfect (key order + whitespace can differ
//      from Shopify's bytes) so:
//        a. Always prefer reading the raw stream (when req is unconsumed).
//        b. If that fails (already consumed), fall back to
//           JSON.stringify(req.body) — Shopify uses a canonical compact JSON
//           format so this matches in practice.
//        c. SHOPIFY_WEBHOOK_SKIP_VERIFY=true escapes the check entirely
//           (smoke-test + dev mode only).
//   2. Verify X-Shopify-Hmac-Sha256 against the raw body using
//      HMAC-SHA256(SHOPIFY_WEBHOOK_SECRET).
//   3. Look up shopify_stores row by X-Shopify-Shop-Domain.
//   4. Dedup against shopify_webhook_log.webhook_id (X-Shopify-Webhook-Id).
//   5. INSERT shopify_webhook_log row, status='pending', raw_payload, topic.
//   6. Upsert shopify_orders + shopify_order_lines (idempotent by the
//      schema's UNIQUE constraints).
//   7. Update webhook_log row → status='processed' + processed_at.
//   8. Return 200 { status: 'processed', shopify_order_id: <uuid> }.
//
// Tangerine P11-2.

import { createClient } from "@supabase/supabase-js";
import { createHmac, timingSafeEqual } from "node:crypto";

export const config = { maxDuration: 30 };

function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Shopify-Hmac-Sha256, X-Shopify-Shop-Domain, X-Shopify-Topic, X-Shopify-Webhook-Id");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const rawBody = await readRawBody(req);

    // ── 1+2. HMAC verification ─────────────────────────────────────────────
    const skipVerify = process.env.SHOPIFY_WEBHOOK_SKIP_VERIFY === "true";
    if (!skipVerify) {
      const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
      if (!secret) {
        console.warn("[shopify webhook] SHOPIFY_WEBHOOK_SECRET not set; rejecting");
        return res.status(401).json({ error: "webhook secret not configured" });
      }
      const sigHeader = headerValue(req, "x-shopify-hmac-sha256");
      const ok = verifyShopifyHmac(sigHeader, rawBody, secret);
      if (!ok) {
        return res.status(401).json({ error: "invalid HMAC" });
      }
    }

    // ── Parse payload ──────────────────────────────────────────────────────
    let payload;
    try { payload = JSON.parse(rawBody); }
    catch { return res.status(400).json({ error: "invalid JSON" }); }
    if (!payload || typeof payload !== "object") {
      return res.status(400).json({ error: "empty payload" });
    }

    const shopDomain = headerValue(req, "x-shopify-shop-domain");
    const topic = headerValue(req, "x-shopify-topic") || "orders/create";
    const webhookId = headerValue(req, "x-shopify-webhook-id");
    if (!shopDomain) return res.status(400).json({ error: "missing X-Shopify-Shop-Domain" });
    if (!webhookId)  return res.status(400).json({ error: "missing X-Shopify-Webhook-Id" });

    const admin = client();
    if (!admin) return res.status(500).json({ error: "supabase not configured" });

    // ── 3. Resolve store ───────────────────────────────────────────────────
    const { data: store, error: storeErr } = await admin
      .from("shopify_stores")
      .select("id, entity_id")
      .eq("shopify_domain", shopDomain)
      .maybeSingle();
    if (storeErr) {
      return res.status(500).json({ error: `store lookup failed: ${storeErr.message}` });
    }
    if (!store) {
      // Unknown shop — log dedup row with NULL store_id so we don't
      // re-process if Shopify retries, then 200 (so Shopify stops
      // retrying — operator will see the row in the log and add the store).
      await admin.from("shopify_webhook_log").upsert({
        shopify_store_id: null,
        webhook_id: webhookId,
        topic,
        status: "failed",
        error_message: `unknown shop_domain: ${shopDomain}`,
        raw_payload: payload,
      }, { onConflict: "webhook_id" });
      return res.status(200).json({ status: "ignored", reason: "unknown_shop" });
    }

    // ── 4. Dedup ───────────────────────────────────────────────────────────
    const { data: existing, error: existingErr } = await admin
      .from("shopify_webhook_log")
      .select("id, status")
      .eq("webhook_id", webhookId)
      .maybeSingle();
    if (existingErr) {
      return res.status(500).json({ error: `dedup lookup failed: ${existingErr.message}` });
    }
    if (existing) {
      return res.status(200).json({ status: "duplicate", webhook_log_id: existing.id });
    }

    // ── 5. Insert webhook_log row ──────────────────────────────────────────
    const { data: logRow, error: logErr } = await admin
      .from("shopify_webhook_log")
      .insert({
        shopify_store_id: store.id,
        webhook_id: webhookId,
        topic,
        status: "pending",
        raw_payload: payload,
      })
      .select("id")
      .single();
    if (logErr) {
      // Race: another concurrent intake won — treat as duplicate.
      return res.status(200).json({ status: "duplicate", error: logErr.message });
    }

    // ── 6. Upsert shopify_orders + lines ───────────────────────────────────
    const orderRow = buildOrderRow(payload, store);
    const { data: upserted, error: upsertErr } = await admin
      .from("shopify_orders")
      .upsert(orderRow, { onConflict: "shopify_store_id,shopify_order_id" })
      .select("id")
      .single();
    if (upsertErr) {
      await admin.from("shopify_webhook_log")
        .update({ status: "failed", error_message: upsertErr.message, processed_at: new Date().toISOString() })
        .eq("id", logRow.id);
      return res.status(500).json({ error: `order upsert failed: ${upsertErr.message}` });
    }
    const shopifyOrderUuid = upserted.id;

    const lines = buildOrderLines(payload, shopifyOrderUuid);
    if (lines.length > 0) {
      const { error: linesErr } = await admin
        .from("shopify_order_lines")
        .upsert(lines, { onConflict: "shopify_order_id,line_number" });
      if (linesErr) {
        await admin.from("shopify_webhook_log")
          .update({ status: "failed", error_message: linesErr.message, processed_at: new Date().toISOString() })
          .eq("id", logRow.id);
        return res.status(500).json({ error: `lines upsert failed: ${linesErr.message}` });
      }
    }

    // ── 7. Mark webhook_log processed ──────────────────────────────────────
    await admin
      .from("shopify_webhook_log")
      .update({ status: "processed", processed_at: new Date().toISOString() })
      .eq("id", logRow.id);

    // touch last_webhook_at on the store row (best-effort)
    await admin
      .from("shopify_stores")
      .update({ last_webhook_at: new Date().toISOString() })
      .eq("id", store.id);

    // ── 8. Done ────────────────────────────────────────────────────────────
    return res.status(200).json({
      status: "processed",
      shopify_order_id: shopifyOrderUuid,
      webhook_log_id: logRow.id,
    });
  } catch (e) {
    console.error("[shopify webhook orders] crashed:", e);
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}

// ────────────────────────────────────────────────────────────────────────
// Helpers — exported for unit tests.
// ────────────────────────────────────────────────────────────────────────

/**
 * Verify Shopify's `X-Shopify-Hmac-Sha256` header (base64-encoded HMAC of
 * the raw request body using the per-store / per-app webhook secret).
 */
export function verifyShopifyHmac(sigHeader, rawBody, secret) {
  if (!sigHeader || !rawBody || !secret) return false;
  const provided = String(Array.isArray(sigHeader) ? sigHeader[0] : sigHeader).trim();
  if (!provided) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  if (provided.length !== expected.length) return false;
  try {
    const a = Buffer.from(provided, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Pull a header value by lowercased name (Vercel/Node give us lowercased
 * keys, but be defensive — some test rigs pass mixed case).
 */
export function headerValue(req, name) {
  const h = req.headers || {};
  const lower = name.toLowerCase();
  if (h[lower] != null) return Array.isArray(h[lower]) ? h[lower][0] : h[lower];
  for (const k of Object.keys(h)) {
    if (k.toLowerCase() === lower) {
      return Array.isArray(h[k]) ? h[k][0] : h[k];
    }
  }
  return null;
}

/**
 * Build the shopify_orders insert row from a Shopify order payload.
 * Exported for tests.
 */
export function buildOrderRow(payload, store) {
  // Shopify gives us `id` as a numeric, `admin_graphql_api_id` as a GID
  // ("gid://shopify/Order/123"). Store the numeric stringified — it's
  // stable and dedup-friendly.
  const shopifyOrderId = String(payload.id ?? extractIdFromGid(payload.admin_graphql_api_id) ?? "");
  return {
    entity_id: store.entity_id,
    shopify_store_id: store.id,
    shopify_order_id: shopifyOrderId,
    order_number: payload.name || `#${payload.order_number ?? shopifyOrderId}`,
    financial_status: payload.financial_status || "pending",
    fulfillment_status: payload.fulfillment_status ?? null,
    processed_at: payload.processed_at || payload.created_at || new Date().toISOString(),
    currency: payload.currency || "USD",
    total_amount_cents: dollarsToCents(payload.total_price),
    subtotal_amount_cents: dollarsToCents(payload.subtotal_price),
    tax_amount_cents: dollarsToCents(payload.total_tax),
    shipping_amount_cents: extractShippingCents(payload),
    discount_amount_cents: dollarsToCents(payload.total_discounts),
    payment_gateway: Array.isArray(payload.payment_gateway_names)
      ? (payload.payment_gateway_names[0] ?? null)
      : null,
    discount_codes: Array.isArray(payload.discount_codes) ? payload.discount_codes : [],
    customer_email: payload.email ?? null,
    raw_payload: payload,
  };
}

/**
 * Build shopify_order_lines insert rows. Exported for tests.
 */
export function buildOrderLines(payload, shopifyOrderUuid) {
  const items = Array.isArray(payload.line_items) ? payload.line_items : [];
  return items.map((li, idx) => ({
    shopify_order_id: shopifyOrderUuid,
    line_number: idx + 1,
    shopify_line_id: String(li.id ?? extractIdFromGid(li.admin_graphql_api_id) ?? `${idx + 1}`),
    sku: li.sku || null,
    title: li.title || "(untitled)",
    quantity: Number(li.quantity) || 0,
    unit_price_cents: dollarsToCents(li.price),
    line_total_cents: dollarsToCents(
      li.price != null && li.quantity != null
        ? (parseFloat(li.price) * Number(li.quantity)).toFixed(2)
        : 0,
    ),
    line_tax_cents: sumTaxLines(li.tax_lines),
    line_discount_cents: sumDiscountAllocs(li.discount_allocations),
    raw_payload: li,
  }));
}

function sumTaxLines(taxLines) {
  if (!Array.isArray(taxLines)) return 0;
  let total = 0;
  for (const t of taxLines) total += dollarsToCents(t.price);
  return total;
}

function sumDiscountAllocs(allocs) {
  if (!Array.isArray(allocs)) return 0;
  let total = 0;
  for (const d of allocs) total += dollarsToCents(d.amount);
  return total;
}

function extractShippingCents(payload) {
  if (!Array.isArray(payload.shipping_lines) || payload.shipping_lines.length === 0) return 0;
  let total = 0;
  for (const sl of payload.shipping_lines) total += dollarsToCents(sl.price);
  return total;
}

/**
 * Convert a Shopify dollar string ("12.99") to integer cents (1299).
 * Returns 0 for null/undefined/empty. Exported for tests.
 */
export function dollarsToCents(v) {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function extractIdFromGid(gid) {
  if (!gid || typeof gid !== "string") return null;
  // "gid://shopify/Order/12345" → "12345"
  const parts = gid.split("/");
  const tail = parts[parts.length - 1];
  return tail || null;
}

/**
 * Read the raw request body. Tries the stream first (only works when the
 * platform hasn't already consumed it), then falls back to re-stringifying
 * the parsed req.body (per the D11 architectural workaround for the
 * Tangerine dispatcher).
 */
async function readRawBody(req) {
  if (typeof req.body === "string") return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");

  // Try the underlying stream first.
  if (req && typeof req.on === "function" && req.readable !== false) {
    try {
      const chunks = await new Promise((resolve, reject) => {
        const bufs = [];
        let done = false;
        const finish = (err) => { if (done) return; done = true; err ? reject(err) : resolve(bufs); };
        req.on("data", (c) => bufs.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        req.on("end", () => finish());
        req.on("error", finish);
        // Safety: if the stream is already consumed it will emit `end`
        // immediately with no data — handled below by the fallback.
      });
      if (chunks.length > 0) {
        return Buffer.concat(chunks).toString("utf8");
      }
    } catch {
      // fall through to re-stringify
    }
  }

  // Fallback: re-stringify parsed JSON. Documented limitation: HMAC may
  // not match if Shopify's serializer differs (whitespace / key order).
  if (req.body && typeof req.body === "object") {
    return JSON.stringify(req.body);
  }
  return "";
}
