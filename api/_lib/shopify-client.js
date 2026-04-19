// api/_lib/shopify-client.js
//
// Server-side Shopify Admin REST helper. Kept deliberately minimal in
// Phase 0 — we just need a working shape that the /api/shopify/* handlers
// can delegate to. GraphQL migration is a Phase 1 call.
//
// Multi-store: the caller picks a storefront by passing `storefront`.
// Credentials are resolved from env by convention:
//
//   SHOPIFY_STORES='{"US":{"shop":"rof-us.myshopify.com","token":"shpat_..."},
//                    "EU":{"shop":"rof-eu.myshopify.com","token":"shpat_..."}}'
//
// If SHOPIFY_STORES is unset we also accept legacy single-store env:
//   SHOPIFY_SHOP_DOMAIN + SHOPIFY_ADMIN_TOKEN
//
// ⚠ Placeholder: neither of these env vars is set in Vercel yet. Handlers
// that call this will return 501 until they are (see api/shopify/*). This
// is intentional — Phase 0 ships the contract, not a live connection.

const DEFAULT_API_VERSION = "2024-10";

function parseStoresEnv() {
  const raw = process.env.SHOPIFY_STORES;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed ? parsed : null;
  } catch { return null; }
}

export function shopifyConfigFor(storefront) {
  const stores = parseStoresEnv();
  if (stores) {
    const entry = stores[storefront] || stores[storefront?.toUpperCase?.() ?? ""];
    if (entry?.shop && entry?.token) return { shop: entry.shop, token: entry.token };
  }
  const fallbackShop = process.env.SHOPIFY_SHOP_DOMAIN;
  const fallbackToken = process.env.SHOPIFY_ADMIN_TOKEN;
  if (fallbackShop && fallbackToken) return { shop: fallbackShop, token: fallbackToken };
  return null;
}

export function storefrontCodes() {
  const stores = parseStoresEnv();
  if (stores) return Object.keys(stores);
  if (process.env.SHOPIFY_SHOP_DOMAIN) return ["DEFAULT"];
  return [];
}

export async function shopifyFetch({ storefront, resource, query = {} }) {
  const cfg = shopifyConfigFor(storefront);
  if (!cfg) {
    return { ok: false, status: 501, body: { error: "SHOPIFY_NOT_CONFIGURED", storefront } };
  }
  const version = process.env.SHOPIFY_API_VERSION || DEFAULT_API_VERSION;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v != null && v !== "") params.set(k, String(v));
  const url = `https://${cfg.shop}/admin/api/${version}/${resource}.json${params.toString() ? `?${params.toString()}` : ""}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 50_000);
  try {
    const r = await fetch(url, {
      method: "GET",
      headers: {
        "X-Shopify-Access-Token": cfg.token,
        "Content-Type": "application/json",
      },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const text = await r.text();
    try { return { ok: r.ok, status: r.status, body: JSON.parse(text), url }; }
    catch { return { ok: false, status: r.status, body: { error: "Non-JSON Shopify response", raw: text.slice(0, 300) }, url }; }
  } catch (err) {
    clearTimeout(t);
    return { ok: false, status: 0, body: { error: String(err?.message || err) }, url };
  }
}
