// api/internal/shopify/stores
//
// GET  — list configured Shopify stores (NEVER returns secrets; only flags
//        whether a token / webhook secret is set).
// POST — connect a new store: encrypts the Admin API access token (+ optional
//        webhook secret) at rest via AES-256-GCM and inserts a shopify_stores
//        row. This is the (previously missing) write path that lets an operator
//        connect Shopify from the app instead of a hand-run SQL insert.
//
// Body (POST): { shopify_domain, store_name, api_version?, access_token,
//                webhook_secret? }
//
// Tangerine P11 — Shopify store connection.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../_lib/auth.js";
import { encryptToken, toByteaHex } from "../../../../_lib/shopify/token-encryption.js";

export const config = { maxDuration: 15 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID, X-Internal-Token");
}

async function resolveEntityId(admin, req) {
  const headerId = req.headers["x-entity-id"];
  if (headerId && typeof headerId === "string") return headerId.trim();
  const { data } = await admin.from("entities").select("id").limit(1).maybeSingle();
  return data?.id || null;
}

// Normalize a Shopify domain: strip protocol/path/whitespace → "store.myshopify.com".
export function normalizeShopDomain(raw) {
  if (!raw || typeof raw !== "string") return "";
  let d = raw.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\s+/g, "");
  return d;
}

// Shape a row for the client — strips all ciphertext, exposes only "is set" flags.
function publicRow(row) {
  return {
    id: row.id,
    entity_id: row.entity_id,
    shopify_domain: row.shopify_domain,
    store_name: row.store_name,
    api_version: row.api_version,
    is_active: row.is_active,
    has_token: !!row.access_token_ciphertext,
    has_webhook_secret: !!row.webhook_secret_ciphertext,
    last_backfill_at: row.last_backfill_at,
    last_webhook_at: row.last_webhook_at,
    created_at: row.created_at,
  };
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const __internalAuth = authenticateInternalCaller(req);
  if (!__internalAuth.ok) return res.status(__internalAuth.status).json({ error: __internalAuth.error });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  if (req.method === "GET") {
    const { data, error } = await admin
      .from("shopify_stores")
      .select("id, entity_id, shopify_domain, store_name, api_version, is_active, access_token_ciphertext, webhook_secret_ciphertext, last_backfill_at, last_webhook_at, created_at")
      .order("created_at", { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json((data || []).map(publicRow));
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }

    const domain = normalizeShopDomain(body?.shopify_domain);
    const storeName = (body?.store_name || "").trim();
    const apiVersion = (body?.api_version || "").trim() || "2025-01";
    const accessToken = (body?.access_token || "").trim();
    const webhookSecret = (body?.webhook_secret || "").trim();

    if (!domain) return res.status(400).json({ error: "shopify_domain is required (e.g. your-store.myshopify.com)" });
    if (!/\.myshopify\.com$/.test(domain)) return res.status(400).json({ error: "Use the *.myshopify.com domain (not your public storefront domain)" });
    if (!storeName) return res.status(400).json({ error: "store_name is required" });
    if (!accessToken) return res.status(400).json({ error: "access_token is required (the Admin API access token, starts with shpat_)" });

    let entityId;
    try { entityId = await resolveEntityId(admin, req); } catch (e) { return res.status(500).json({ error: `Could not resolve entity: ${e.message}` }); }
    if (!entityId) return res.status(500).json({ error: "Could not resolve entity_id" });

    let tok, hook;
    try {
      tok = encryptToken(accessToken);
      hook = encryptToken(webhookSecret || null);
    } catch (e) {
      // Most likely SHOPIFY_TOKEN_ENC_KEY missing/invalid.
      return res.status(500).json({ error: `Token encryption failed: ${e.message}` });
    }

    const row = {
      entity_id: entityId,
      shopify_domain: domain,
      store_name: storeName,
      api_version: apiVersion,
      access_token_ciphertext: toByteaHex(tok.ciphertext),
      access_token_iv: toByteaHex(tok.iv),
      access_token_tag: toByteaHex(tok.tag),
      webhook_secret_ciphertext: toByteaHex(hook.ciphertext),
      webhook_secret_iv: toByteaHex(hook.iv),
      webhook_secret_tag: toByteaHex(hook.tag),
      is_active: body?.is_active === false ? false : true,
    };

    const { data, error } = await admin
      .from("shopify_stores")
      .insert(row)
      .select("id, entity_id, shopify_domain, store_name, api_version, is_active, access_token_ciphertext, webhook_secret_ciphertext, last_backfill_at, last_webhook_at, created_at")
      .single();
    if (error) {
      if (/duplicate key|unique/i.test(error.message)) {
        return res.status(409).json({ error: `A store with domain ${domain} is already connected for this entity.` });
      }
      return res.status(500).json({ error: error.message });
    }
    return res.status(201).json(publicRow(data));
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
