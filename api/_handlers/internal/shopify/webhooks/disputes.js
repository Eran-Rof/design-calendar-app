// api/internal/shopify/webhooks/disputes
//
// Tangerine P11-8 — Shopify dispute (chargeback) webhook intake.
//
// Mirrors the P11-2 orders webhook pattern: HMAC verification against the
// raw body, X-Shopify-Webhook-Id dedup via shopify_webhook_log, then hands
// off to processShopifyDispute (api/_lib/shopify/process-dispute.js) which
// opens the M47 case + posts the chargeback JE atomically.
//
// On dispute_created the service:
//   - Resolves the store by X-Shopify-Shop-Domain.
//   - Links to the parent shopify_orders row (by payload.order_id).
//   - Opens an M47 case (P7-9 cases API shape, INSERT inline).
//   - Posts the chargeback JE: DR 6610 Chargeback Expense / CR 1100 Bank.
//   - Stores the chargeback in shopify_disputes with case_id + je_id.
//
// HMAC + dedup behaviour is identical to P11-2 — see that handler's header
// comment for the raw-body workaround documentation.

import { createClient } from "@supabase/supabase-js";
import { createHmac, timingSafeEqual } from "node:crypto";
import { processShopifyDispute } from "../../../../_lib/shopify/process-dispute.js";

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

    // HMAC verification.
    const skipVerify = process.env.SHOPIFY_WEBHOOK_SKIP_VERIFY === "true";
    if (!skipVerify) {
      const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
      if (!secret) {
        console.warn("[shopify disputes webhook] SHOPIFY_WEBHOOK_SECRET not set; rejecting");
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
    const topic      = headerValue(req, "x-shopify-topic") || "disputes/create";
    const webhookId  = headerValue(req, "x-shopify-webhook-id");
    if (!shopDomain) return res.status(400).json({ error: "missing X-Shopify-Shop-Domain" });
    if (!webhookId)  return res.status(400).json({ error: "missing X-Shopify-Webhook-Id" });

    const admin = client();
    if (!admin) return res.status(500).json({ error: "supabase not configured" });

    // Resolve store + log row (mirrors orders.js — store lookup is needed
    // for shopify_webhook_log.shopify_store_id NOT NULL FK).
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

    // Webhook-id dedup.
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

    // Insert webhook_log row (pending).
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

    // Hand off to the processing service.
    let result;
    try {
      result = await processShopifyDispute({
        payload,
        shopDomain,
        adminClient: admin,
      });
    } catch (e) {
      await admin.from("shopify_webhook_log")
        .update({
          status: "failed",
          error_message: e instanceof Error ? e.message : String(e),
          processed_at: new Date().toISOString(),
        })
        .eq("id", logRow.id);
      return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }

    await admin
      .from("shopify_webhook_log")
      .update({ status: "processed", processed_at: new Date().toISOString() })
      .eq("id", logRow.id);

    await admin
      .from("shopify_stores")
      .update({ last_webhook_at: new Date().toISOString() })
      .eq("id", store.id);

    return res.status(200).json({
      status: result.status,
      dispute_id: result.dispute_id || null,
      case_id: result.case_id || null,
      je_id: result.je_id || null,
      webhook_log_id: logRow.id,
    });
  } catch (e) {
    console.error("[shopify webhook disputes] crashed:", e);
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
}

// ────────────────────────────────────────────────────────────────────────
// Helpers — exported for unit tests (mirror of P11-2 orders.js helpers).
// ────────────────────────────────────────────────────────────────────────

/**
 * Verify the X-Shopify-Hmac-Sha256 header against the raw body using
 * HMAC-SHA256(secret). Returns true on match (timing-safe compare).
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
 * Pull a header value by lowercased name. Defensive against test rigs that
 * pass mixed-case keys.
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
 * Read the raw request body. Tries the stream first; falls back to
 * re-stringifying parsed req.body for the Tangerine /api/* dispatcher case
 * (see P11-2 orders.js for the full workaround commentary).
 */
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
