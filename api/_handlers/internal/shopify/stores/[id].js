// api/internal/shopify/stores/:id
//
// PUT    — update a store: rename, api_version, activate/deactivate, and/or
//          ROTATE the access token / webhook secret (only when a new value is
//          supplied; blank = leave unchanged). Secrets are encrypted at rest.
// DELETE — remove a store (blocked by FK if it already has orders/products).
//
// Tangerine P11 — Shopify store connection.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../_lib/auth.js";
import { encryptToken, toByteaHex } from "../../../../_lib/shopify/token-encryption.js";

export const config = { maxDuration: 15 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entity-ID, X-Internal-Token");
}

function getId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("stores");
  return idx >= 0 ? parts[idx + 1] : null;
}

function publicRow(row) {
  return {
    id: row.id, entity_id: row.entity_id, shopify_domain: row.shopify_domain,
    store_name: row.store_name, api_version: row.api_version, is_active: row.is_active,
    has_token: !!row.access_token_ciphertext, has_webhook_secret: !!row.webhook_secret_ciphertext,
    last_backfill_at: row.last_backfill_at, last_webhook_at: row.last_webhook_at, created_at: row.created_at,
  };
}

const SELECT_COLS = "id, entity_id, shopify_domain, store_name, api_version, is_active, access_token_ciphertext, webhook_secret_ciphertext, last_backfill_at, last_webhook_at, created_at";

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const __internalAuth = authenticateInternalCaller(req);
  if (!__internalAuth.ok) return res.status(__internalAuth.status).json({ error: __internalAuth.error });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const id = getId(req);
  if (!id) return res.status(400).json({ error: "Missing store id" });

  if (req.method === "PUT") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "Invalid JSON" }); } }

    const updates = { updated_at: new Date().toISOString() };
    if (typeof body?.store_name === "string" && body.store_name.trim()) updates.store_name = body.store_name.trim();
    if (typeof body?.api_version === "string" && body.api_version.trim()) updates.api_version = body.api_version.trim();
    if (typeof body?.is_active === "boolean") updates.is_active = body.is_active;

    // Rotate token / webhook secret only when a non-empty value is supplied.
    const newToken = (body?.access_token || "").trim();
    const newSecret = (body?.webhook_secret || "").trim();
    try {
      if (newToken) {
        const t = encryptToken(newToken);
        updates.access_token_ciphertext = toByteaHex(t.ciphertext);
        updates.access_token_iv = toByteaHex(t.iv);
        updates.access_token_tag = toByteaHex(t.tag);
      }
      if (newSecret) {
        const h = encryptToken(newSecret);
        updates.webhook_secret_ciphertext = toByteaHex(h.ciphertext);
        updates.webhook_secret_iv = toByteaHex(h.iv);
        updates.webhook_secret_tag = toByteaHex(h.tag);
      }
    } catch (e) {
      return res.status(500).json({ error: `Token encryption failed: ${e.message}` });
    }

    if (Object.keys(updates).length === 1) return res.status(400).json({ error: "No fields to update" });

    const { data, error } = await admin.from("shopify_stores").update(updates).eq("id", id).select(SELECT_COLS).maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Store not found" });
    return res.status(200).json(publicRow(data));
  }

  if (req.method === "DELETE") {
    const { error } = await admin.from("shopify_stores").delete().eq("id", id);
    if (error) {
      if (/foreign key|violates/i.test(error.message)) {
        return res.status(409).json({ error: "Can't delete — this store already has orders/products. Deactivate it instead." });
      }
      return res.status(500).json({ error: error.message });
    }
    return res.status(204).end();
  }

  res.setHeader("Allow", "PUT, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
