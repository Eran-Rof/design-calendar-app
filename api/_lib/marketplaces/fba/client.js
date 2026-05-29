// api/_lib/marketplaces/fba/client.js
//
// Amazon Selling Partner API (SP-API) REST client.
//
// AUTHENTICATION — LWA TOKEN ONLY
// -------------------------------------------------------------------------
// Amazon deprecated the AWS Sigv4 requirement on SP-API endpoints in 2023
// (https://developer-docs.amazon.com/sp-api/changelog/aws-sigv4-signing-is-
// no-longer-required-for-sp-api-requests). All SP-API requests now
// authenticate with the LWA access token alone, passed in the
// `x-amz-access-token` header. We deliberately do NOT implement Sigv4
// signing in this chunk.
//
// If a legacy account requires Sigv4 via STS::AssumeRole the constructor
// accepts an optional `awsRoleArn` — TODO: implement when we have an
// account that actually needs it. Today no operator path requires it.
//
// REGION → ENDPOINT MAPPING
// -------------------------------------------------------------------------
//   NA → https://sellingpartnerapi-na.amazon.com   (US / CA / MX / BR)
//   EU → https://sellingpartnerapi-eu.amazon.com   (UK / DE / FR / IT / ES / NL / SE / PL / TR / AE / IN / SA / EG / BE / ZA)
//   FE → https://sellingpartnerapi-fe.amazon.com   (JP / AU / SG)
//
// RATE LIMITS (per usage-plan token bucket — Amazon publishes these on
// each endpoint's docs page; these are the documented defaults for the
// endpoints we call):
//   getOrders                     — 0.0167 req/sec  burst=20
//   getOrderItems                 — 0.5    req/sec  burst=30
//   listFinancialEventGroups      — 0.5    req/sec  burst=30
//   getInventorySummaries         — 2      req/sec  burst=2
//   listReturnRequests            — 1      req/sec  burst=5
//
// Our handlers wrap all SP-API calls in `request()` which retries 429 /
// 5xx with exponential backoff + jitter (5 attempts: 2s/4s/8s/16s/32s).
// 4xx other than 429 throws immediately as a structured error
//   { status, body, retryAfter? }.

const REGION_ENDPOINTS = {
  NA: "https://sellingpartnerapi-na.amazon.com",
  EU: "https://sellingpartnerapi-eu.amazon.com",
  FE: "https://sellingpartnerapi-fe.amazon.com",
};

const DEFAULT_RETRIES = 5;
// 2s/4s/8s/16s/32s (jitter ±20% added in request())
const RETRY_DELAYS_MS = [2000, 4000, 8000, 16000, 32000];

export class SpApiError extends Error {
  constructor(message, { status, body, retryAfter, endpoint }) {
    super(message);
    this.name = "SpApiError";
    // `status` may legitimately be 0 (network error before any HTTP
    // response). Use nullish-coalescing so 0 is preserved.
    this.status = status ?? null;
    this.body = body ?? null;
    this.retryAfter = retryAfter ?? null;
    this.endpoint = endpoint ?? null;
  }
}

export class SpApiClient {
  /**
   * @param {Object} opts
   * @param {'NA'|'EU'|'FE'} opts.region
   * @param {string} opts.accessToken      LWA access token from refreshLwaAccessToken()
   * @param {string} opts.marketplaceId    default marketplace id for list endpoints (e.g. ATVPDKIKX0DER for US)
   * @param {string} [opts.awsRoleArn]     legacy Sigv4 hook — TODO not implemented
   * @param {Object} [opts.deps]           injection point for tests
   * @param {Function} [opts.deps.fetchFn] override global fetch
   * @param {Function} [opts.deps.sleepFn] override the backoff sleep
   * @param {Function} [opts.deps.randomFn] override Math.random for jitter
   */
  constructor(opts) {
    if (!opts || typeof opts !== "object") {
      throw new Error("SpApiClient: opts object required");
    }
    if (!opts.region || !REGION_ENDPOINTS[opts.region]) {
      throw new Error(`SpApiClient: region must be one of ${Object.keys(REGION_ENDPOINTS).join("|")}`);
    }
    if (!opts.accessToken || typeof opts.accessToken !== "string") {
      throw new Error("SpApiClient: accessToken required");
    }
    if (!opts.marketplaceId || typeof opts.marketplaceId !== "string") {
      throw new Error("SpApiClient: marketplaceId required");
    }
    this.region = opts.region;
    this.endpoint = REGION_ENDPOINTS[opts.region];
    this.accessToken = opts.accessToken;
    this.marketplaceId = opts.marketplaceId;
    this.awsRoleArn = opts.awsRoleArn || null;
    // TODO: if awsRoleArn is set, implement Sigv4 signing via STS::AssumeRole.
    // No operator path needs this today (per Amazon's 2023 deprecation).
    this.deps = opts.deps || {};
  }

  /**
   * Low-level GET helper. Returns parsed JSON body on 2xx, throws
   * SpApiError on 4xx/5xx after retries.
   *
   * @param {string} path        e.g. '/orders/v0/orders'
   * @param {Object} [query]     map of query params (values stringified)
   * @returns {Promise<any>}
   */
  async request(path, query) {
    const fetchFn = this.deps.fetchFn || globalThis.fetch;
    const sleepFn = this.deps.sleepFn || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const randomFn = this.deps.randomFn || Math.random;

    const url = this._buildUrl(path, query);
    const headers = {
      "x-amz-access-token": this.accessToken,
      "x-amz-date": new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""),
      "host": new URL(this.endpoint).host,
      "accept": "application/json",
      "user-agent": "Tangerine-SPAPI/1.0 (Language=Node.js)",
    };

    let lastResp = null;
    for (let attempt = 0; attempt < DEFAULT_RETRIES; attempt++) {
      let resp;
      try {
        resp = await fetchFn(url, { method: "GET", headers });
      } catch (e) {
        // Network error — retryable.
        if (attempt < DEFAULT_RETRIES - 1) {
          const jitter = 1 + (randomFn() * 0.4 - 0.2);
          await sleepFn(Math.floor(RETRY_DELAYS_MS[attempt] * jitter));
          continue;
        }
        throw new SpApiError(`SP-API network error: ${e?.message || String(e)}`, {
          status: 0, body: null, endpoint: path,
        });
      }

      const status = resp.status;
      const retryAfterHdr = resp.headers && (resp.headers.get ? resp.headers.get("retry-after") : resp.headers["retry-after"]);
      const retryAfter = retryAfterHdr ? Number(retryAfterHdr) : null;
      let text;
      try { text = await resp.text(); } catch { text = ""; }
      let json;
      try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }

      if (status >= 200 && status < 300) {
        return json;
      }

      lastResp = { status, body: json, retryAfter };

      if (status === 429 || status >= 500) {
        if (attempt < DEFAULT_RETRIES - 1) {
          const base = RETRY_DELAYS_MS[attempt];
          const jitter = 1 + (randomFn() * 0.4 - 0.2);
          const delayMs = retryAfter && Number.isFinite(retryAfter)
            ? Math.max(retryAfter * 1000, Math.floor(base * jitter))
            : Math.floor(base * jitter);
          await sleepFn(delayMs);
          continue;
        }
      }

      // Non-retryable 4xx, or retries exhausted.
      throw new SpApiError(
        `SP-API ${status} on ${path}: ${JSON.stringify(json).slice(0, 300)}`,
        { status, body: json, retryAfter, endpoint: path },
      );
    }

    // Defensive — shouldn't reach here.
    throw new SpApiError("SP-API retries exhausted with no response captured", {
      status: lastResp?.status || 0,
      body: lastResp?.body || null,
      retryAfter: lastResp?.retryAfter || null,
      endpoint: path,
    });
  }

  _buildUrl(path, query) {
    const url = new URL(path, this.endpoint);
    if (query && typeof query === "object") {
      for (const [k, v] of Object.entries(query)) {
        if (v == null || v === "") continue;
        if (Array.isArray(v)) {
          url.searchParams.set(k, v.join(","));
        } else {
          url.searchParams.set(k, String(v));
        }
      }
    }
    return url.toString();
  }

  // ── ORDERS ────────────────────────────────────────────────────────────

  /**
   * GET /orders/v0/orders — list orders for the configured marketplace.
   *
   * @param {Object} args
   * @param {string} [args.createdAfter]       ISO timestamp; mutually-exclusive with lastUpdatedAfter
   * @param {string} [args.lastUpdatedAfter]   ISO timestamp; mutually-exclusive with createdAfter
   * @param {string} [args.nextToken]          pagination cursor (round-trip from prior call)
   * @param {number} [args.maxResults=100]     1..100
   * @returns {Promise<{Orders: any[], NextToken?: string, LastUpdatedBefore?: string}>}
   */
  async listOrders(args = {}) {
    const { createdAfter, lastUpdatedAfter, nextToken, maxResults = 100 } = args;
    if (!createdAfter && !lastUpdatedAfter && !nextToken) {
      throw new Error("listOrders: createdAfter or lastUpdatedAfter required (or nextToken to continue)");
    }
    const query = {
      MarketplaceIds: this.marketplaceId,
      MaxResultsPerPage: Math.min(100, Math.max(1, Number(maxResults) || 100)),
    };
    if (createdAfter) query.CreatedAfter = createdAfter;
    if (lastUpdatedAfter) query.LastUpdatedAfter = lastUpdatedAfter;
    if (nextToken) query.NextToken = nextToken;
    const r = await this.request("/orders/v0/orders", query);
    // SP-API wraps payload under `payload`. Be defensive — some endpoints
    // return the payload at the top level when called via the gateway.
    return r.payload || r;
  }

  /**
   * GET /orders/v0/orders/{amazonOrderId}/orderItems
   *
   * @param {string} amazonOrderId   e.g. '111-1111111-1111111'
   * @param {string} [nextToken]     pagination
   * @returns {Promise<{OrderItems: any[], NextToken?: string, AmazonOrderId: string}>}
   */
  async getOrderItems(amazonOrderId, nextToken) {
    if (!amazonOrderId || typeof amazonOrderId !== "string") {
      throw new Error("getOrderItems: amazonOrderId required");
    }
    const path = `/orders/v0/orders/${encodeURIComponent(amazonOrderId)}/orderItems`;
    const query = nextToken ? { NextToken: nextToken } : null;
    const r = await this.request(path, query);
    return r.payload || r;
  }

  // ── FINANCES ──────────────────────────────────────────────────────────

  /**
   * GET /finances/v0/financialEventGroups
   *
   * @param {Object} args
   * @param {string} [args.postedAfter]  ISO
   * @param {string} [args.postedBefore] ISO
   * @param {string} [args.nextToken]
   * @param {number} [args.maxResults=100]
   * @returns {Promise<{FinancialEventGroupList: any[], NextToken?: string}>}
   */
  async listFinancialEventGroups(args = {}) {
    const { postedAfter, postedBefore, nextToken, maxResults = 100 } = args;
    const query = {
      MaxResultsPerPage: Math.min(100, Math.max(1, Number(maxResults) || 100)),
    };
    if (postedAfter) query.FinancialEventGroupStartedAfter = postedAfter;
    if (postedBefore) query.FinancialEventGroupStartedBefore = postedBefore;
    if (nextToken) query.NextToken = nextToken;
    const r = await this.request("/finances/v0/financialEventGroups", query);
    return r.payload || r;
  }

  // ── INVENTORY ─────────────────────────────────────────────────────────

  /**
   * GET /fba/inventory/v1/summaries
   *
   * @param {Object} args
   * @param {string} [args.marketplaceId]    defaults to constructor's marketplaceId
   * @param {string} [args.granularityType='Marketplace']
   * @param {string} [args.nextToken]
   * @param {string[]} [args.sellerSkus]     optional filter — up to 50
   * @returns {Promise<{inventorySummaries: any[], pagination?: {nextToken?: string}}>}
   */
  async getInventorySummaries(args = {}) {
    const marketplaceId = args.marketplaceId || this.marketplaceId;
    const granularityType = args.granularityType || "Marketplace";
    const query = {
      details: "true",
      granularityType,
      granularityId: marketplaceId,
      marketplaceIds: marketplaceId,
    };
    if (args.nextToken) query.nextToken = args.nextToken;
    if (Array.isArray(args.sellerSkus) && args.sellerSkus.length) {
      query.sellerSkus = args.sellerSkus.slice(0, 50).join(",");
    }
    const r = await this.request("/fba/inventory/v1/summaries", query);
    return r.payload || r;
  }

  // ── RETURNS ───────────────────────────────────────────────────────────

  /**
   * GET /fba/returns/v1/returnRequests — FBA customer-returns feed.
   *
   * @param {Object} args
   * @param {string} [args.createdAfter]  ISO; required by Amazon
   * @param {string} [args.createdBefore] ISO
   * @param {string} [args.nextToken]
   * @param {number} [args.maxResults=50]
   * @returns {Promise<{returnRequests: any[], pagination?: {nextToken?: string}}>}
   */
  async listReturnRequests(args = {}) {
    const { createdAfter, createdBefore, nextToken, maxResults = 50 } = args;
    if (!createdAfter && !nextToken) {
      throw new Error("listReturnRequests: createdAfter or nextToken required");
    }
    const query = {
      maxResults: Math.min(100, Math.max(1, Number(maxResults) || 50)),
    };
    if (createdAfter) query.createdAfter = createdAfter;
    if (createdBefore) query.createdBefore = createdBefore;
    if (nextToken) query.nextToken = nextToken;
    const r = await this.request("/fba/returns/v1/returnRequests", query);
    return r.payload || r;
  }
}

export const REGIONS = Object.keys(REGION_ENDPOINTS);
export const _REGION_ENDPOINTS = REGION_ENDPOINTS; // for tests
