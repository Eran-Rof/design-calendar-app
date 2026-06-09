// api/_lib/shopify/client.js
//
// Shopify Admin REST API client — pure-fetch wrapper (no @shopify/shopify-api
// dep). Per the P11 architecture doc decision D11, we keep this client
// dependency-free so it works in Node's stock crypto + fetch environment
// that Vercel + vitest both ship.
//
// Surface (P11-2 lands the methods the backfill + webhook handlers need;
// later chunks add product/variant/inventory sync):
//
//   const c = new ShopifyClient({
//     shopifyDomain: 'rof.myshopify.com',
//     accessToken:   'shpat_…',           // decrypted by token-encryption.js
//     apiVersion:    '2025-01',           // optional, defaults to '2025-01'
//   });
//   await c.listOrders({ since, until, limit, page_info });   // → { data, nextPageInfo }
//   await c.getOrder(orderId);                                // → { data, nextPageInfo: null }
//   await c.listRefunds(orderId);                             // → { data, nextPageInfo }
//   await c.listPayouts({ since, until, page_info });         // → { data, nextPageInfo }
//   await c.getPayoutTransactions(payoutId);                  // → { data, nextPageInfo }
//
// Each method:
//   - Injects X-Shopify-Access-Token header
//   - Parses the `Link: <…>; rel="next"` cursor header into `nextPageInfo`
//   - Retries 429 with exponential backoff (3 tries, 1s / 2s / 4s)
//   - Throws { status, body } on 4xx/5xx (after retries exhausted)
//
// Tangerine P11-2.

const DEFAULT_API_VERSION = "2025-01";
const RETRY_BACKOFFS_MS = [1000, 2000, 4000]; // 3 tries
const RETRY_STATUS = new Set([429]);

export class ShopifyClient {
  constructor({ shopifyDomain, accessToken, apiVersion = DEFAULT_API_VERSION } = {}) {
    if (!shopifyDomain || typeof shopifyDomain !== "string") {
      throw new Error("ShopifyClient: shopifyDomain is required (e.g. 'rof.myshopify.com')");
    }
    if (!accessToken || typeof accessToken !== "string") {
      throw new Error("ShopifyClient: accessToken is required");
    }
    this.shopifyDomain = shopifyDomain;
    this.accessToken = accessToken;
    this.apiVersion = apiVersion || DEFAULT_API_VERSION;
  }

  // ── Orders ──────────────────────────────────────────────────────────────

  /**
   * GET /admin/api/{v}/orders.json
   * @param {{since?: string|Date, until?: string|Date, limit?: number, page_info?: string, status?: string}} opts
   * @returns {Promise<{data: any[], nextPageInfo: string|null}>}
   */
  async listOrders({ since, until, limit = 250, page_info, status = "any" } = {}) {
    // Per Shopify: when page_info is set, no other filters may be sent
    // alongside it (Shopify rejects with 400). Honor that.
    const qs = page_info
      ? { page_info, limit: String(limit) }
      : {
          ...(since ? { created_at_min: toIso(since) } : {}),
          ...(until ? { created_at_max: toIso(until) } : {}),
          limit: String(limit),
          status,
        };
    const { json, link } = await this._request("GET", `/orders.json`, { query: qs });
    return { data: json.orders || [], nextPageInfo: parseLinkHeader(link) };
  }

  /**
   * GET /admin/api/{v}/orders/{id}.json
   */
  async getOrder(orderId) {
    if (!orderId) throw new Error("getOrder: orderId is required");
    const { json } = await this._request("GET", `/orders/${encodeURIComponent(orderId)}.json`);
    return { data: json.order || null, nextPageInfo: null };
  }

  // ── Products (P11-10) ───────────────────────────────────────────────────

  /**
   * GET /admin/api/{v}/products.json
   *
   * Paginated walk of the product catalog. Same Link-header cursor as orders.
   * @param {{since?: string|Date, until?: string|Date, limit?: number, page_info?: string, status?: string, vendor?: string}} opts
   * @returns {Promise<{data: any[], nextPageInfo: string|null}>}
   */
  async listProducts({ since, until, limit = 250, page_info, status, vendor } = {}) {
    const qs = page_info
      ? { page_info, limit: String(limit) }
      : {
          ...(since ? { updated_at_min: toIso(since) } : {}),
          ...(until ? { updated_at_max: toIso(until) } : {}),
          ...(status ? { status } : {}),
          ...(vendor ? { vendor } : {}),
          limit: String(limit),
        };
    const { json, link } = await this._request("GET", `/products.json`, { query: qs });
    return { data: json.products || [], nextPageInfo: parseLinkHeader(link) };
  }

  /**
   * GET /admin/api/{v}/products/{id}.json
   *
   * Single-product fetch — used by the webhook handler on products/create and
   * products/update events, and by the pull-images flow when re-syncing one
   * product's image set.
   */
  async getProduct(productId) {
    if (!productId) throw new Error("getProduct: productId is required");
    const { json } = await this._request("GET", `/products/${encodeURIComponent(productId)}.json`);
    return { data: json.product || null, nextPageInfo: null };
  }

  /**
   * GET /admin/api/{v}/products/{id}/images.json
   *
   * Sometimes a product webhook fires before its image set is ready; this
   * lets the pull-images flow refresh the image list independently of the
   * product payload. The product.images array on getProduct is usually
   * authoritative — prefer that when available.
   */
  async getProductImages(productId) {
    if (!productId) throw new Error("getProductImages: productId is required");
    const { json } = await this._request(
      "GET",
      `/products/${encodeURIComponent(productId)}/images.json`,
    );
    return { data: json.images || [], nextPageInfo: null };
  }

  /**
   * GET /admin/api/{v}/products/{id}/metafields.json
   *
   * Used by the description sync to read SEO fields — Shopify stores the SEO
   * title / meta description as metafields under namespace `global`
   * (key `title_tag` / `description_tag`). Pass { namespace } to filter.
   */
  async getProductMetafields(productId, { namespace } = {}) {
    if (!productId) throw new Error("getProductMetafields: productId is required");
    const { json } = await this._request(
      "GET",
      `/products/${encodeURIComponent(productId)}/metafields.json`,
      { query: namespace ? { namespace } : undefined },
    );
    return { data: json.metafields || [], nextPageInfo: null };
  }

  // ── Refunds ─────────────────────────────────────────────────────────────

  /**
   * GET /admin/api/{v}/orders/{id}/refunds.json
   */
  async listRefunds(orderId) {
    if (!orderId) throw new Error("listRefunds: orderId is required");
    const { json, link } = await this._request(
      "GET",
      `/orders/${encodeURIComponent(orderId)}/refunds.json`,
    );
    return { data: json.refunds || [], nextPageInfo: parseLinkHeader(link) };
  }

  // ── Payouts (Shopify Payments) ──────────────────────────────────────────

  /**
   * GET /admin/api/{v}/shopify_payments/payouts.json
   */
  async listPayouts({ since, until, page_info, limit = 250 } = {}) {
    const qs = page_info
      ? { page_info, limit: String(limit) }
      : {
          ...(since ? { date_min: toDateOnly(since) } : {}),
          ...(until ? { date_max: toDateOnly(until) } : {}),
          limit: String(limit),
        };
    const { json, link } = await this._request(
      "GET",
      `/shopify_payments/payouts.json`,
      { query: qs },
    );
    return { data: json.payouts || [], nextPageInfo: parseLinkHeader(link) };
  }

  /**
   * GET /admin/api/{v}/shopify_payments/payouts/{id}/transactions.json
   *
   * Shopify actually exposes this as a top-level filter
   * (`/shopify_payments/balance/transactions.json?payout_id=…`) — keep the
   * payoutId-in-path signature stable for the handler caller; we
   * translate to the canonical URL here.
   */
  async getPayoutTransactions(payoutId, { page_info, limit = 250 } = {}) {
    if (!payoutId) throw new Error("getPayoutTransactions: payoutId is required");
    const qs = page_info
      ? { page_info, limit: String(limit) }
      : { payout_id: String(payoutId), limit: String(limit) };
    const { json, link } = await this._request(
      "GET",
      `/shopify_payments/balance/transactions.json`,
      { query: qs },
    );
    return { data: json.transactions || [], nextPageInfo: parseLinkHeader(link) };
  }

  // ── Low-level request w/ 429 retry ──────────────────────────────────────

  async _request(method, path, { query, body } = {}) {
    const url = this._url(path, query);
    const headers = {
      "X-Shopify-Access-Token": this.accessToken,
      "Accept": "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const init = {
      method,
      headers,
      ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    };

    let lastErr = null;
    for (let attempt = 0; attempt < RETRY_BACKOFFS_MS.length; attempt++) {
      const res = await fetch(url, init);
      const status = res.status;

      if (status >= 200 && status < 300) {
        const link = res.headers.get("link") || res.headers.get("Link") || "";
        const text = await res.text();
        let json = {};
        if (text) {
          try { json = JSON.parse(text); }
          catch { json = { _raw: text }; }
        }
        return { json, link, status };
      }

      const bodyText = await safeReadText(res);
      if (RETRY_STATUS.has(status) && attempt < RETRY_BACKOFFS_MS.length - 1) {
        lastErr = { status, body: bodyText };
        await sleep(RETRY_BACKOFFS_MS[attempt]);
        continue;
      }
      // 4xx (non-retryable) or 5xx after retries exhausted, or 429 final.
      const err = new Error(`Shopify ${method} ${path} failed: ${status}`);
      err.status = status;
      err.body = bodyText;
      throw err;
    }
    // Shouldn't reach — loop always returns or throws.
    const err = new Error(`Shopify ${method} ${path} retries exhausted`);
    err.status = lastErr?.status ?? 0;
    err.body = lastErr?.body ?? "";
    throw err;
  }

  _url(path, query) {
    const base = `https://${this.shopifyDomain}/admin/api/${this.apiVersion}${path}`;
    if (!query || Object.keys(query).length === 0) return base;
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v == null) continue;
      params.set(k, String(v));
    }
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  }
}

// ────────────────────────────────────────────────────────────────────────
// Helpers — exported for unit tests.
// ────────────────────────────────────────────────────────────────────────

/**
 * Extract the `page_info` cursor from a Shopify `Link` header.
 * Shape: `<https://x.myshopify.com/admin/api/2025-01/orders.json?page_info=abc&limit=250>; rel="next"`
 *
 * If multiple rels are present (next + previous), only `rel="next"` is
 * returned. Returns null when no next link is present.
 */
export function parseLinkHeader(link) {
  if (!link || typeof link !== "string") return null;
  // Split on commas that separate distinct rels — but NOT commas inside
  // angle brackets. Shopify URLs don't contain bare commas, but be safe.
  const parts = link.split(/,(?![^<]*>)/);
  for (const part of parts) {
    const m = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(part);
    if (!m) continue;
    try {
      const u = new URL(m[1]);
      const pi = u.searchParams.get("page_info");
      if (pi) return pi;
    } catch {
      // ignore malformed URL
    }
  }
  return null;
}

function toIso(d) {
  if (d instanceof Date) return d.toISOString();
  return String(d);
}

function toDateOnly(d) {
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  const s = String(d);
  // accept either YYYY-MM-DD or ISO timestamp
  return s.length >= 10 ? s.slice(0, 10) : s;
}

async function safeReadText(res) {
  try { return await res.text(); }
  catch { return ""; }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
