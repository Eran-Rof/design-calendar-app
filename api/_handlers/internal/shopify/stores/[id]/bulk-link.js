// api/internal/shopify/stores/:id/bulk-link
//
// Walk the store's active Shopify catalog, match each product to a Tangerine
// style by SKU prefix → style_code (denim inseam fallback), and link them:
// upsert a shopify_products mirror + point style_master.shopify_product_id at
// it. `?dry_run=true` reports matches WITHOUT writing. Fast (no images) — image
// re-host happens in bulk-pull.
//
// Tangerine P11-10-bulk.

import { createClient } from "@supabase/supabase-js";
import { authenticateInternalCaller } from "../../../../../_lib/auth.js";
import { loadStoreById, buildShopClient, upsertShopifyProduct } from "../../../../../_lib/shopify/pull-product-images.js";
import { matchProductToStyleCode, styleCodeFromSku } from "../../../../../_lib/shopify/bulkMatch.js";

export const config = { maxDuration: 60 };

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
function client() {
  const SB_URL = process.env.VITE_SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB_URL || !SERVICE_KEY) return null;
  return createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

/** Load every style_code → { id, entity_id } (UPPER-cased key). */
async function loadStyleMap(admin) {
  const map = new Map();
  let from = 0;
  for (;;) {
    const { data, error } = await admin
      .from("style_master").select("id, entity_id, style_code")
      .not("style_code", "is", null).range(from, from + 999);
    if (error) throw new Error(`style_master read failed: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) {
      const k = String(r.style_code).trim().toUpperCase();
      if (k && !map.has(k)) map.set(k, { id: r.id, entity_id: r.entity_id });
    }
    if (data.length < 1000) break;
    from += 1000;
  }
  return map;
}

export default async function handler(req, res) {
  corsHeaders(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Method not allowed" }); }

  const __a = authenticateInternalCaller(req);
  if (!__a.ok) return res.status(__a.status).json({ error: __a.error });

  const admin = client();
  if (!admin) return res.status(500).json({ error: "Server not configured" });

  const id = getId(req);
  if (!id) return res.status(400).json({ error: "Missing store id" });
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const dryRun = req.query?.dry_run === "true" || body?.dry_run === true;

  try {
    const store = await loadStoreById(admin, id);
    const shop = buildShopClient(store);
    const styleMap = await loadStyleMap(admin);

    // Walk active products.
    let products = [], pageInfo = null, pages = 0;
    do {
      const { data, nextPageInfo } = await shop.listProducts(pageInfo ? { page_info: pageInfo, limit: 250 } : { limit: 250, status: "active" });
      products.push(...data); pageInfo = nextPageInfo; pages++;
    } while (pageInfo && pages < 20);

    const summary = { total_products: products.length, matched: 0, linked: 0, already_linked: 0, unmatched: [], errors: [] };

    for (const p of products) {
      const code = matchProductToStyleCode(p, new Set(styleMap.keys()));
      if (!code) {
        if (summary.unmatched.length < 50) {
          const prefixes = Array.from(new Set((p.variants || []).map((v) => styleCodeFromSku(v.sku)).filter(Boolean))).slice(0, 3);
          summary.unmatched.push({ handle: p.handle, title: p.title, sku_prefixes: prefixes });
        }
        continue;
      }
      summary.matched += 1;
      if (dryRun) continue;
      const style = styleMap.get(code);
      try {
        const mirrorId = await upsertShopifyProduct(admin, { entityId: style.entity_id, store, product: p, styleId: style.id });
        const { error: upErr } = await admin.from("style_master").update({ shopify_product_id: mirrorId }).eq("id", style.id);
        if (upErr) throw new Error(upErr.message);
        summary.linked += 1;
      } catch (e) {
        summary.errors.push(`${p.handle} → ${code}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return res.status(200).json({ dry_run: !!dryRun, ...summary });
  } catch (e) {
    return res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
}
