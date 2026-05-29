// api/_lib/marketplaces/walmart/client.js
//
// Walmart Marketplace REST API client — pure-fetch wrapper.
//
// Per the P12 architecture doc, we keep this client dependency-free so it
// works in Node's stock crypto + fetch environment that Vercel + vitest
// both ship. No @walmart/marketplace-api or similar.
//
// Surface (P12b-2 lands the methods the orders ingest cron + manual
// trigger need; later chunks add settlements posting + returns mirror
// + WFS inventory poller):
//
//   const c = new WalmartClient({
//     partnerId:   '10000xxxxx',          // Walmart Partner ID (seller)
//     accessToken: 'eyJraWQi…',           // from getWalmartAccessToken()
//     baseUrl:     'https://marketplace.walmartapis.com',   // override for tests
//     channelType: 'MARKETPLACE',
//   });
//   await c.listOrders({ createdStartDate, createdEndDate, nextCursor, limit });
//   await c.getOrder(purchaseOrderId);
//   await c.getOrderItems(purchaseOrderId);
//   await c.listSettlementReports({ reportType, requestedFromDate, requestedToDate });
//   await c.listReturns({ returnCreatedStartDate, returnCreatedEndDate, nextCursor });
//
// Each method:
//   - Injects WM_SEC.ACCESS_TOKEN, WM_QOS.CORRELATION_ID (fresh UUID per
//     request), WM_SVC.NAME, WM_CONSUMER.CHANNEL.TYPE, Accept: application/json
//   - Parses `meta.nextCursor` for pagination
//   - Retries 429 with exponential backoff (3 tries, 1s / 2s / 4s)
//   - Throws { status, body } on 4xx/5xx (after retries exhausted)
//
// Tangerine P12b-2.

import { randomUUID } from "node:crypto";

const DEFAULT_BASE_URL = "https://marketplace.walmartapis.com";
const SVC_NAME = "Walmart Marketplace";
const DEFAULT_CHANNEL_TYPE = "MARKETPLACE";
const RETRY_BACKOFFS_MS = [1000, 2000, 4000]; // 3 tries
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

export class WalmartClient {
  constructor({
    partnerId,
    accessToken,
    baseUrl = DEFAULT_BASE_URL,
    channelType = DEFAULT_CHANNEL_TYPE,
  } = {}) {
    if (!partnerId || typeof partnerId !== "string") {
      throw new Error("WalmartClient: partnerId is required");
    }
    if (!accessToken || typeof accessToken !== "string") {
      throw new Error("WalmartClient: accessToken is required");
    }
    this.partnerId = partnerId;
    this.accessToken = accessToken;
    this.baseUrl = baseUrl || DEFAULT_BASE_URL;
    this.channelType = channelType || DEFAULT_CHANNEL_TYPE;
  }

  // ── Orders ──────────────────────────────────────────────────────────────

  /**
   * GET /v3/orders
   *
   * createdStartDate + createdEndDate are required by Walmart unless
   * nextCursor is supplied (in which case Walmart says "no other
   * filters" — same shape as Shopify's page_info rule). We honor that.
   *
   * @param {object} opts
   * @param {string|Date} [opts.createdStartDate]
   * @param {string|Date} [opts.createdEndDate]
   * @param {string} [opts.nextCursor]
   * @param {number} [opts.limit=200]
   * @returns {Promise<{data: any[], nextCursor: string|null}>}
   */
  async listOrders({ createdStartDate, createdEndDate, nextCursor, limit = 200 } = {}) {
    const qs = nextCursor
      ? { nextCursor }
      : {
          ...(createdStartDate ? { createdStartDate: toIso(createdStartDate) } : {}),
          ...(createdEndDate   ? { createdEndDate:   toIso(createdEndDate)   } : {}),
          limit: String(limit),
        };
    const { json } = await this._request("GET", `/v3/orders`, { query: qs });
    const list = json?.list || json?.elements?.order || json?.orders || [];
    const data = Array.isArray(list) ? list : (list?.order || []);
    return {
      data,
      nextCursor: extractCursor(json),
    };
  }

  /**
   * GET /v3/orders/{purchaseOrderId}
   */
  async getOrder(purchaseOrderId) {
    if (!purchaseOrderId) throw new Error("getOrder: purchaseOrderId is required");
    const { json } = await this._request(
      "GET",
      `/v3/orders/${encodeURIComponent(String(purchaseOrderId))}`,
    );
    const order = json?.order || json?.elements?.order || json || null;
    return { data: order, nextCursor: null };
  }

  /**
   * GET /v3/orders/{purchaseOrderId}/lines
   *
   * Walmart calls order items "lines". Returns the array of line objects
   * (each with line_number, item_sku, quantity, etc.).
   */
  async getOrderItems(purchaseOrderId) {
    if (!purchaseOrderId) throw new Error("getOrderItems: purchaseOrderId is required");
    const { json } = await this._request(
      "GET",
      `/v3/orders/${encodeURIComponent(String(purchaseOrderId))}/lines`,
    );
    // Walmart's response shape (per the spec) wraps lines under
    // order.orderLines.orderLine — but we also accept flatter shapes for
    // resilience against API version drift.
    const lines =
      json?.order?.orderLines?.orderLine ??
      json?.orderLines?.orderLine ??
      json?.elements?.orderLines?.orderLine ??
      json?.lines ??
      [];
    const data = Array.isArray(lines) ? lines : (lines ? [lines] : []);
    return { data, nextCursor: null };
  }

  // ── Settlement reports ─────────────────────────────────────────────────

  /**
   * GET /v3/getReport
   *
   * Returns the raw report metadata + URL — the caller fetches the actual
   * CSV from `downloadUrl`. Used by the weekly settlement reconciler
   * (lands in P12b-4).
   */
  async listSettlementReports({
    reportType = "SETTLEMENT",
    requestedFromDate,
    requestedToDate,
  } = {}) {
    const qs = {
      reportType,
      reportVersion: "v1",
      ...(requestedFromDate ? { requestedFromDate: toIso(requestedFromDate) } : {}),
      ...(requestedToDate   ? { requestedToDate:   toIso(requestedToDate)   } : {}),
    };
    const { json } = await this._request("GET", `/v3/getReport`, { query: qs });
    const list = json?.results || json?.reports || (Array.isArray(json) ? json : []);
    const data = Array.isArray(list) ? list : (list ? [list] : []);
    return { data, nextCursor: extractCursor(json) };
  }

  // ── Returns ────────────────────────────────────────────────────────────

  /**
   * GET /v3/returns
   *
   * Walmart returns a cursor-paginated list under meta.nextCursor.
   */
  async listReturns({
    returnCreatedStartDate,
    returnCreatedEndDate,
    nextCursor,
    limit = 200,
  } = {}) {
    const qs = nextCursor
      ? { nextCursor }
      : {
          ...(returnCreatedStartDate ? { returnCreatedStartDate: toIso(returnCreatedStartDate) } : {}),
          ...(returnCreatedEndDate   ? { returnCreatedEndDate:   toIso(returnCreatedEndDate)   } : {}),
          limit: String(limit),
        };
    const { json } = await this._request("GET", `/v3/returns`, { query: qs });
    const list = json?.returnOrders?.returnOrder ?? json?.list ?? json?.returns ?? [];
    const data = Array.isArray(list) ? list : (list ? [list] : []);
    return { data, nextCursor: extractCursor(json) };
  }

  // ── Low-level request w/ 429 retry ─────────────────────────────────────

  async _request(method, path, { query, body } = {}) {
    const url = this._url(path, query);
    const headers = {
      "WM_SEC.ACCESS_TOKEN": this.accessToken,
      "WM_QOS.CORRELATION_ID": randomUUID(),
      "WM_SVC.NAME": SVC_NAME,
      "WM_CONSUMER.CHANNEL.TYPE": this.channelType,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const init = {
      method,
      headers,
      ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    };

    let lastErr = null;
    for (let attempt = 0; attempt < RETRY_BACKOFFS_MS.length; attempt++) {
      // Fresh correlation id on every retry attempt as well.
      init.headers["WM_QOS.CORRELATION_ID"] = randomUUID();
      let res;
      try {
        res = await fetch(url, init);
      } catch (e) {
        lastErr = { status: 0, body: e instanceof Error ? e.message : String(e) };
        if (attempt < RETRY_BACKOFFS_MS.length - 1) {
          await sleep(RETRY_BACKOFFS_MS[attempt]);
          continue;
        }
        const err = new Error(`Walmart ${method} ${path} network error: ${lastErr.body}`);
        err.status = 0;
        err.body = lastErr.body;
        throw err;
      }
      const status = res.status;

      if (status >= 200 && status < 300) {
        const text = await safeReadText(res);
        let json = {};
        if (text) {
          try { json = JSON.parse(text); }
          catch { json = { _raw: text }; }
        }
        return { json, status };
      }

      const bodyText = await safeReadText(res);
      if (RETRY_STATUS.has(status) && attempt < RETRY_BACKOFFS_MS.length - 1) {
        lastErr = { status, body: bodyText };
        await sleep(RETRY_BACKOFFS_MS[attempt]);
        continue;
      }
      const err = new Error(`Walmart ${method} ${path} failed: ${status}`);
      err.status = status;
      err.body = bodyText;
      throw err;
    }
    const err = new Error(`Walmart ${method} ${path} retries exhausted`);
    err.status = lastErr?.status ?? 0;
    err.body = lastErr?.body ?? "";
    throw err;
  }

  _url(path, query) {
    const base = `${this.baseUrl}${path}`;
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
 * Extract Walmart's cursor from a response body. Walmart sometimes nests
 * the cursor under `meta.nextCursor` and sometimes under
 * `list.meta.nextCursor` — we accept both. Returns null when no cursor
 * is present.
 */
export function extractCursor(json) {
  if (!json || typeof json !== "object") return null;
  const candidates = [
    json?.meta?.nextCursor,
    json?.list?.meta?.nextCursor,
    json?.elements?.meta?.nextCursor,
    json?.nextCursor,
  ];
  for (const c of candidates) {
    if (c && typeof c === "string") return c;
  }
  return null;
}

function toIso(d) {
  if (d instanceof Date) return d.toISOString();
  return String(d);
}

async function safeReadText(res) {
  try { return await res.text(); }
  catch { return ""; }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
