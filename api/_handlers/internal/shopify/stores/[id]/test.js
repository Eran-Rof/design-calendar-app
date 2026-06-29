// api/internal/shopify/stores/:id/test
//
// POST — verify a connected store's credentials by making a live, read-only
// Admin API call (lists 1 product). Returns { ok, sample_count } or a clear
// error so the operator knows the token/domain/scopes are right before relying
// on sync + image pull.
//
// Tangerine P11 — Shopify store connection.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../../_lib/auth.js";
import { loadStoreById, buildShopClient } from "../../../../../_lib/shopify/pull-product-images.js";

export const config = { maxDuration: 20 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token");
}

function getId(req) {
  if (req.query && req.query.id) return req.query.id;
  const parts = (req.url || "").split("?")[0].split("/").filter(Boolean);
  const idx = parts.lastIndexOf("stores");
  return idx >= 0 ? parts[idx + 1] : null;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed" }); }

  const __internalAuth = authenticateInternalCaller(req);
  if (!__internalAuth.ok) return res.status(__internalAuth.status).json({ error: __internalAuth.error });

  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return res.status(500).json({ error: "Server not configured" });
  const admin = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const id = getId(req);
  if (!id) return res.status(400).json({ error: "Missing store id" });

  try {
    const store = await loadStoreById(admin, id);
    const shop = buildShopClient(store);
    const { data } = await shop.listProducts({ limit: 1 });
    return res.status(200).json({ ok: true, shopify_domain: store.shopify_domain, sample_count: Array.isArray(data) ? data.length : 0 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Surface the common causes plainly.
    return res.status(200).json({ ok: false, error: msg });
  }
}
