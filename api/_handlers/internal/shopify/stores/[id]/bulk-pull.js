// api/internal/shopify/stores/:id/bulk-pull
//
// Re-host Shopify images for styles already linked (style_master.shopify_product_id
// set), in BATCHES so we stay under the function timeout. The client loops:
//   POST .../bulk-pull?offset=0&limit=8  → { processed, next_offset, done, ... }
// until `done`. Idempotent — pullShopifyImages dedups on shopify_image_id.
//
// Tangerine P11-10-bulk.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../../_lib/auth.js";
import { pullShopifyImages } from "../../../../../_lib/shopify/pull-product-images.js";

export const config = { maxDuration: 300 };

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Internal-Token");
}
function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed" }); }

  const __a = authenticateInternalCaller(req);
  if (!__a.ok) return res.status(__a.status).json({ error: __a.error });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const offset = Math.max(0, parseInt(req.query?.offset, 10) || 0);
  const limit = Math.min(20, Math.max(1, parseInt(req.query?.limit, 10) || 8));

  // Linked styles, stable order, one batch.
  const { data: styles, error } = await admin
    .from("style_master")
    .select("id, style_code")
    .not("shopify_product_id", "is", null)
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) return res.status(500).json({ error: error.message });

  // Total for progress / done detection.
  const { count: total } = await admin
    .from("style_master")
    .select("id", { count: "exact", head: true })
    .not("shopify_product_id", "is", null);

  const batch = styles || [];
  let pulled = 0, skipped = 0, failed = 0;
  const errors = [];
  for (const s of batch) {
    try {
      const r = await pullShopifyImages({ admin, styleId: s.id });
      pulled += r.pulled; skipped += r.skipped; failed += r.failed;
      if (r.errors?.length) errors.push(...r.errors.slice(0, 2).map((e) => `${s.style_code}: ${e}`));
    } catch (e) {
      failed += 1;
      errors.push(`${s.style_code}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const nextOffset = offset + batch.length;
  const done = batch.length === 0 || nextOffset >= (total || 0);
  return res.status(200).json({
    offset, limit, batch_size: batch.length, total_linked: total || 0,
    pulled, skipped, failed, errors: errors.slice(0, 20),
    next_offset: nextOffset, done,
  });
}
