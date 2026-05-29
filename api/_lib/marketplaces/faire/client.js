// api/_lib/marketplaces/faire/client.js
//
// Tangerine P12c-2 — Faire REST client.
//
// Faire is WHOLESALE — static API key per shop, NO OAuth dance. The key is
// pasted once in the Faire brand portal and sent in the
// X-FAIRE-OAUTH-ACCESS-TOKEN header on every request. The header name has
// "OAUTH" in it for legacy reasons but Faire treats it as a long-lived
// static credential.
//
// Base URL: https://www.faire.com
//
// Endpoints used:
//   GET /external-api/v2/orders        (orders poller — P12c-2)
//   GET /external-api/v2/orders/:id    (order detail)
//   GET /external-api/v2/payouts       (payouts poller — P12c-2)
//   GET /external-api/v2/payouts/:id   (payout detail)
//   GET /external-api/v2/shipments     (future — shipment status updates)
//
// Pagination: Faire's v2 endpoints accept page + limit. Each method returns
// {data, hasNextPage, page} for caller convenience; the orchestrator walks
// the page cursor until hasNextPage=false.
//
// Rate limit: 1 req/sec per shop (Faire-documented). The client serializes
// requests via an internal "next allowed time" gate; 429s back off with
// 1s/2s/4s exponential up to 3 retries.
//
// Errors: 4xx/5xx throw `FaireApiError` with structured {status, body}.

const DEFAULT_BASE = "https://www.faire.com";
const RATE_LIMIT_MS = 1000;                 // 1 req/sec
const RETRY_DELAYS_MS = [1000, 2000, 4000]; // 3 retries on 429

export class FaireApiError extends Error {
  constructor({ status, body, message }) {
    super(message || `Faire API error ${status}`);
    this.name = "FaireApiError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Sleep helper. Exposed for injection in tests so we don't actually wait
 * 1s between every mocked call.
 */
async function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class FaireClient {
  /**
   * @param {Object} opts
   * @param {string} opts.apiKey               static Faire API key (decrypted)
   * @param {string} [opts.baseUrl]            override base URL (testing)
   * @param {Function} [opts.fetchImpl]        injectable fetch (testing)
   * @param {Function} [opts.sleep]            injectable sleep (testing)
   * @param {boolean} [opts.skipRateLimit]     skip the 1s gate (testing)
   */
  constructor({ apiKey, baseUrl = DEFAULT_BASE, fetchImpl, sleep, skipRateLimit } = {}) {
    if (!apiKey || typeof apiKey !== "string") {
      throw new Error("FaireClient: apiKey is required");
    }
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this._fetch = fetchImpl || globalThis.fetch;
    this._sleep = sleep || defaultSleep;
    this._skipRateLimit = !!skipRateLimit;
    this._nextAllowedAt = 0;
  }

  /**
   * Issue a single GET request with rate-limit gate + retry-on-429.
   * Internal — call the named methods (listOrders / getOrder / ...) instead.
   *
   * @param {string} path           absolute path beginning with '/'
   * @param {Object} [query]        key→value query params
   * @returns {Promise<any>}        parsed JSON body
   */
  async _get(path, query = {}) {
    let attempt = 0;
    // Build URL with non-null query params.
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
    const headers = {
      "X-FAIRE-OAUTH-ACCESS-TOKEN": this.apiKey,
      "Accept": "application/json",
    };

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (!this._skipRateLimit) {
        const now = Date.now();
        const waitMs = Math.max(0, this._nextAllowedAt - now);
        if (waitMs > 0) await this._sleep(waitMs);
        this._nextAllowedAt = Date.now() + RATE_LIMIT_MS;
      }

      let resp;
      try {
        resp = await this._fetch(url.toString(), { method: "GET", headers });
      } catch (e) {
        throw new FaireApiError({
          status: 0,
          body: null,
          message: `Faire network error: ${e instanceof Error ? e.message : String(e)}`,
        });
      }

      if (resp.status === 429 && attempt < RETRY_DELAYS_MS.length) {
        await this._sleep(RETRY_DELAYS_MS[attempt]);
        attempt += 1;
        continue;
      }

      const text = await resp.text();
      let body = null;
      if (text) {
        try { body = JSON.parse(text); } catch { body = text; }
      }

      if (!resp.ok) {
        throw new FaireApiError({
          status: resp.status,
          body,
          message: `Faire ${resp.status} on GET ${path}`,
        });
      }

      return body;
    }
  }

  /**
   * Faire v2 list responses have varying shapes — Faire historically returned
   * {orders: [...]} or {data: [...]} depending on the endpoint version. Pick
   * the data array, and infer hasNextPage from {has_next_page, next_page,
   * cursor} flags or "did we get a full page?" fallback.
   */
  _unwrapList(body, primaryKey, page, limit) {
    const data = Array.isArray(body?.[primaryKey])
      ? body[primaryKey]
      : Array.isArray(body?.data)
        ? body.data
        : Array.isArray(body)
          ? body
          : [];

    let hasNextPage;
    if (typeof body?.has_next_page === "boolean") {
      hasNextPage = body.has_next_page;
    } else if (typeof body?.hasNextPage === "boolean") {
      hasNextPage = body.hasNextPage;
    } else if (body?.next_page) {
      hasNextPage = true;
    } else if (body?.cursor) {
      hasNextPage = true;
    } else {
      // Conservative fallback: if we filled the page exactly, assume there's more.
      hasNextPage = data.length >= limit;
    }

    return { data, hasNextPage, page };
  }

  /**
   * List orders updated since `updatedAtMin`.
   *
   * @param {Object} opts
   * @param {string} opts.updatedAtMin   ISO timestamp (inclusive lower bound)
   * @param {number} [opts.limit=50]
   * @param {number} [opts.page=1]
   * @returns {Promise<{data: any[], hasNextPage: boolean, page: number}>}
   */
  async listOrders({ updatedAtMin, limit = 50, page = 1 } = {}) {
    const body = await this._get("/external-api/v2/orders", {
      updated_at_min: updatedAtMin,
      limit,
      page,
    });
    return this._unwrapList(body, "orders", page, limit);
  }

  /**
   * Fetch full detail for a single order.
   * @param {string} faireOrderId
   */
  async getOrder(faireOrderId) {
    if (!faireOrderId) throw new Error("getOrder: faireOrderId is required");
    return this._get(`/external-api/v2/orders/${encodeURIComponent(faireOrderId)}`);
  }

  /**
   * List payouts paid since `paidAtMin`.
   *
   * @param {Object} opts
   * @param {string} opts.paidAtMin       ISO timestamp (inclusive lower bound)
   * @param {number} [opts.limit=50]
   * @param {number} [opts.page=1]
   * @returns {Promise<{data: any[], hasNextPage: boolean, page: number}>}
   */
  async listPayouts({ paidAtMin, limit = 50, page = 1 } = {}) {
    const body = await this._get("/external-api/v2/payouts", {
      paid_at_min: paidAtMin,
      limit,
      page,
    });
    return this._unwrapList(body, "payouts", page, limit);
  }

  /**
   * Fetch full detail for a single payout.
   * @param {string} fairePayoutId
   */
  async getPayoutDetails(fairePayoutId) {
    if (!fairePayoutId) throw new Error("getPayoutDetails: fairePayoutId is required");
    return this._get(`/external-api/v2/payouts/${encodeURIComponent(fairePayoutId)}`);
  }

  /**
   * List shipments updated since `updatedAtMin`.
   *
   * @param {Object} opts
   * @param {string} opts.updatedAtMin
   * @param {number} [opts.limit=50]
   * @param {number} [opts.page=1]
   */
  async listShipments({ updatedAtMin, limit = 50, page = 1 } = {}) {
    const body = await this._get("/external-api/v2/shipments", {
      updated_at_min: updatedAtMin,
      limit,
      page,
    });
    return this._unwrapList(body, "shipments", page, limit);
  }
}

/**
 * True when FAIRE_TOKEN_ENC_KEY is configured (the only env dep for the
 * cron handlers; the api key itself comes from the row).
 */
export function isFaireConfigured() {
  const hex = process.env.FAIRE_TOKEN_ENC_KEY;
  return !!(hex && typeof hex === "string" && /^[0-9a-fA-F]{64}$/.test(hex.trim()));
}
