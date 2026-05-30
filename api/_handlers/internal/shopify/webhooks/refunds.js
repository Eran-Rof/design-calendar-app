// api/internal/shopify/webhooks/refunds
//
// Tangerine P11-6 — Shopify refunds/create webhook intake.
//
// Mirrors the P11-2 orders webhook flow:
//   1. Read raw body, verify X-Shopify-Hmac-Sha256 (skippable via
//      SHOPIFY_WEBHOOK_SKIP_VERIFY=true).
//   2. Resolve shopify_stores row by X-Shopify-Shop-Domain.
//   3. Dedup against shopify_webhook_log.webhook_id.
//   4. Find the parent shopify_orders row by
//      (shopify_store_id, shopify_order_id = payload.order_id).
//   5. Upsert shopify_refunds keyed by (shopify_store_id, shopify_refund_id).
//      Actually shopify_refunds.unique constraint is just shopify_refund_id
//      scoped via the FK to shopify_orders; we use shopify_refund_id as the
//      conflict target.
//   6. Call processShopifyRefund (P11-6 service) — full void OR partial CM.
//   7. Update webhook_log row → status='processed'.
//   8. Return 200 { status, shopify_refund_id, refund_type, ... }.
//
// Topics:
//   - "refunds/create" — fired when a refund is created in Shopify.
//   - "orders/refunded" — also fired by Shopify; payload is the order with
//     embedded refunds[]. We accept either topic; if "orders/refunded", we
//     process each refund in payload.refunds[] individually.

import { createClient } from "@supabase/supabase-js";
import { createHmac, timingSafeEqual } from "node:crypto";
import { processShopifyRefund } from "../../../../_lib/shopify/process-refund.js";

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
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Shopify-Hmac-Sha256, X-Shopify-Shop-Domain, X-Shopify-Topic, X-Shopify-Webhook-Id",
  );
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const rawBody = await readRawBody(req);

    // HMAC verify
    const skipVerify = process.env.SHOPIFY_WEBHOOK_SKIP_VERIFY === "true";
    if (!skipVerify) {
      const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
      if (!secret) {
        console.warn("[shopify webhook refunds] SHOPIFY_WEBHOOK_SECRET not set; rejecting");
        return res.status(401).json({ error: "webhook secret not configured" });
      }
      const sigHeader = headerValue(req, "x-shopify-hmac-sha256");
      const ok = verifyShopifyHmac(sigHeader, rawBody, secret);
      if (!ok) {
        return res.status(401).json({ error: "invalid HMAC" });
      }
    }

    let payload;
    try { payload = JSON.parse(rawBody); }
    catch { return res.status(400).json({ error: "invalid JSON" }); }
    if (!payload || typeof payload !== "object") {
      return res.status(400).json({ error: "empty payload" });
    }

    const shopDomain = headerValue(req, "x-shopify-shop-domain");
    const topic      = headerValue(req, "x-shopify-topic") || "refunds/create";
    const webhookId  = headerValue(req, "x-shopify-webhook-id");
    if (!shopDomain) return res.status(400).json({ error: "missing X-Shopify-Shop-Domain" });
    if (!webhookId)  return res.status(400).json({ error: "missing X-Shopify-Webhook-Id" });

    const admin = client();
    if (!admin) return res.status(500).json({ error: "supabase not configured" });

    // Resolve store
    const { data: store, error: storeErr } = await admin
      .from("shopify_stores")
      .select("id, entity_id")
      .eq("shopify_domain", shopDomain)
      .maybeSingle();
    if (storeErr) {
      return res.status(500).json({ error: `store lookup failed: ${storeErr.message}` });
    }
    if (!store) {
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

    // Dedup
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

    // Insert webhook_log
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
      return res.status(200).json({ status: "duplicate", error: logErr.message });
    }

    // Extract refund descriptors from the payload (supports both topics)
    const refundsPayload = extractRefundsFromPayload(payload, topic);
    if (refundsPayload.length === 0) {
      await admin
        .from("shopify_webhook_log")
        .update({
          status: "processed",
          processed_at: new Date().toISOString(),
          error_message: "no refunds in payload",
        })
        .eq("id", logRow.id);
      return res.status(200).json({ status: "noop", reason: "no_refunds_in_payload" });
    }

    const processed = [];
    for (const refundPayload of refundsPayload) {
      try {
        const result = await upsertAndProcessRefund({
          admin, store, refundPayload, rawTopic: topic,
        });
        processed.push(result);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        processed.push({ status: "error", error: msg, shopify_refund_id: String(refundPayload?.id || "") });
      }
    }

    // Mark webhook_log processed
    const anyFailed = processed.some((p) => p.status === "error");
    await admin
      .from("shopify_webhook_log")
      .update({
        status: anyFailed ? "failed" : "processed",
        processed_at: new Date().toISOString(),
        error_message: anyFailed
          ? processed.filter((p) => p.status === "error").map((p) => p.error).join("; ")
          : null,
      })
      .eq("id", logRow.id);

    await admin
      .from("shopify_stores")
      .update({ last_webhook_at: new Date().toISOString() })
      .eq("id", store.id);

    return res.status(200).json({
      status: anyFailed ? "partial" : "processed",
      webhook_log_id: logRow.id,
      refunds_processed: processed,
    });
  } catch (e) {
    console.error("[shopify webhook refunds] crashed:", e);
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}

// ────────────────────────────────────────────────────────────────────────
// Helpers — exported for unit tests.
// ────────────────────────────────────────────────────────────────────────

/**
 * Upsert one shopify_refunds row + invoke processShopifyRefund. Returns the
 * per-refund result envelope for the handler response.
 *
 * Exported for unit tests.
 */
export async function upsertAndProcessRefund({
  admin, store, refundPayload, rawTopic,
  deps = {},
}) {
  const processRefundFn = deps.processShopifyRefund || processShopifyRefund;

  const shopifyRefundId = String(refundPayload?.id ?? "");
  const orderId = String(refundPayload?.order_id ?? "");
  if (!shopifyRefundId) {
    throw new Error("refund payload missing id");
  }
  if (!orderId) {
    throw new Error(`refund ${shopifyRefundId} payload missing order_id`);
  }

  // Lookup parent order
  const { data: parentOrder, error: orderErr } = await admin
    .from("shopify_orders")
    .select("id, total_amount_cents, ar_invoice_id, entity_id")
    .eq("shopify_store_id", store.id)
    .eq("shopify_order_id", orderId)
    .maybeSingle();
  if (orderErr) {
    throw new Error(`shopify_orders lookup failed: ${orderErr.message}`);
  }
  if (!parentOrder) {
    throw new Error(
      `parent shopify_orders not found (store ${store.id}, shopify_order_id ${orderId}) — backfill will retry`,
    );
  }

  // Build the refund row
  const refundRow = buildRefundRow({
    refundPayload, store, parentOrder, rawTopic,
  });

  // Upsert by shopify_refund_id (unique scoped to store via parent FK)
  const { data: upsertedRefund, error: upsertErr } = await admin
    .from("shopify_refunds")
    .upsert(refundRow, { onConflict: "shopify_refund_id" })
    .select("id, ar_credit_memo_id, refund_type")
    .single();
  if (upsertErr || !upsertedRefund) {
    throw new Error(
      `shopify_refunds upsert failed for ${shopifyRefundId}: ${upsertErr?.message || "no row returned"}`,
    );
  }

  // If already linked, short-circuit before calling the service.
  if (upsertedRefund.ar_credit_memo_id) {
    return {
      status: "already_processed",
      shopify_refund_id: shopifyRefundId,
      refund_id: upsertedRefund.id,
      ar_credit_memo_id: upsertedRefund.ar_credit_memo_id,
      refund_type: upsertedRefund.refund_type,
    };
  }

  // Invoke processing service
  const result = await processRefundFn({
    shopifyRefundId: upsertedRefund.id,
    adminClient: admin,
  });
  return {
    status: result.status,
    shopify_refund_id: shopifyRefundId,
    refund_id: upsertedRefund.id,
    refund_type: result.refund_type,
    ar_credit_memo_id: result.ar_credit_memo_id ?? null,
    ar_invoice_id: result.ar_invoice_id ?? null,
    je_id: result.je_id ?? null,
    cogs_je_id: result.cogs_je_id ?? null,
  };
}

/**
 * Build the shopify_refunds insert row from a Shopify refund payload.
 *
 * Exported for unit tests.
 */
export function buildRefundRow({ refundPayload, store, parentOrder, rawTopic }) {
  const shopifyRefundId = String(refundPayload?.id ?? "");
  const refundAmountCents = computeRefundAmountCents(refundPayload);
  const restockingFeeCents = computeRestockingFeeCents(refundPayload);
  const processedAt = refundPayload?.processed_at
    || refundPayload?.created_at
    || new Date().toISOString();
  // Classify against the parent order's total. Webhook upsert sets a tentative
  // refund_type; the service re-verifies before posting.
  const parentTotal = toBigIntSafe(parentOrder?.total_amount_cents);
  const refundType =
    BigInt(refundAmountCents) >= parentTotal && parentTotal > 0n
      ? "full"
      : "partial";

  return {
    entity_id: parentOrder?.entity_id || store.entity_id,
    shopify_order_id: parentOrder.id,
    shopify_refund_id: shopifyRefundId,
    refund_type: refundType,
    refund_amount_cents: refundAmountCents,
    restocking_fee_cents: restockingFeeCents,
    processed_at: processedAt,
    raw_payload: { ...refundPayload, _webhook_topic: rawTopic || null },
  };
}

/**
 * Walk a Shopify refund payload and total up the cents amount being refunded.
 * Uses `transactions[]` (Shopify's source of truth for cash movement) first;
 * falls back to summing refund_line_items.subtotal + total_tax.
 *
 * Exported for unit tests.
 */
export function computeRefundAmountCents(payload) {
  if (!payload || typeof payload !== "object") return 0;
  // Prefer transactions[]
  if (Array.isArray(payload.transactions) && payload.transactions.length > 0) {
    let cents = 0;
    for (const t of payload.transactions) {
      if (!t || t.kind !== "refund" || (t.status && t.status !== "success")) continue;
      cents += dollarsToCents(t.amount);
    }
    if (cents > 0) return cents;
  }
  // Fallback: sum refund_line_items + adjustment_amounts
  let cents = 0;
  if (Array.isArray(payload.refund_line_items)) {
    for (const li of payload.refund_line_items) {
      cents += dollarsToCents(li?.subtotal);
      cents += dollarsToCents(li?.total_tax);
    }
  }
  if (Array.isArray(payload.order_adjustments)) {
    for (const a of payload.order_adjustments) {
      // Skip restocking_fee adjustments — they're income we KEEP, not cash
      // we owe the customer back. Those are captured separately by
      // computeRestockingFeeCents and handled by the JE builder.
      if (!a || a.kind === "restocking_fee") continue;
      // Other refund adjustments (shipping_refund etc.) typically negative
      // ("-5.00"); take absolute cents.
      cents += Math.abs(dollarsToCents(a.amount));
    }
  }
  return cents;
}

/**
 * Pull the restocking fee out of `order_adjustments[].kind='restocking_fee'`.
 * Shopify stores this as a positive amount tagged with kind=restocking_fee.
 *
 * Exported for unit tests.
 */
export function computeRestockingFeeCents(payload) {
  if (!payload || typeof payload !== "object") return 0;
  if (!Array.isArray(payload.order_adjustments)) return 0;
  let cents = 0;
  for (const a of payload.order_adjustments) {
    if (!a || a.kind !== "restocking_fee") continue;
    cents += Math.abs(dollarsToCents(a.amount));
  }
  return cents;
}

/**
 * Extract the array of individual refund payloads from a webhook body.
 * Handles both:
 *   - "refunds/create" — payload IS the refund (so [payload]).
 *   - "orders/refunded" — payload is the order; refunds live under
 *     payload.refunds[].
 *
 * Exported for unit tests.
 */
export function extractRefundsFromPayload(payload, topic) {
  if (!payload || typeof payload !== "object") return [];
  const t = String(topic || "").toLowerCase();
  if (t === "orders/refunded" || Array.isArray(payload.refunds)) {
    const refunds = Array.isArray(payload.refunds) ? payload.refunds : [];
    // Each entry must carry order_id; if missing, copy from parent.
    return refunds.map((r) => (r && !r.order_id && payload.id ? { ...r, order_id: payload.id } : r))
      .filter((r) => r && typeof r === "object");
  }
  // refunds/create — payload itself is the refund.
  if (payload.id && (payload.order_id || payload.order_id === 0)) {
    return [payload];
  }
  // Fallback: nothing parseable
  return [];
}

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

export function dollarsToCents(v) {
  if (v == null || v === "") return 0;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function toBigIntSafe(v) {
  if (v == null || v === "") return 0n;
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return 0n;
    return BigInt(Math.trunc(v));
  }
  if (typeof v === "string") {
    if (!/^-?\d+$/.test(v)) return 0n;
    return BigInt(v);
  }
  return 0n;
}

async function readRawBody(req) {
  if (typeof req.body === "string") return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");

  if (req && typeof req.on === "function" && req.readable !== false) {
    try {
      const chunks = await new Promise((resolve, reject) => {
        const bufs = [];
        let done = false;
        const finish = (err) => { if (done) return; done = true; err ? reject(err) : resolve(bufs); };
        req.on("data", (c) => bufs.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        req.on("end", () => finish());
        req.on("error", finish);
      });
      if (chunks.length > 0) {
        return Buffer.concat(chunks).toString("utf8");
      }
    } catch {
      // fall through
    }
  }

  if (req.body && typeof req.body === "object") {
    return JSON.stringify(req.body);
  }
  return "";
}
