// api/_lib/marketplaces/walmart/auth.js
//
// Walmart Marketplace OAuth — client_credentials grant.
//
// Walmart uses the OAuth 2.0 client_credentials flow (POST /v3/token with
// Basic-auth header) — different from the refresh_token long-lived loop
// FBA (LWA) and Shopify (Admin API access_token) use. Tokens are short:
// 15 minutes (expires_in = 900s). We cache in-process per clientId and
// refresh whenever <2 minutes remain.
//
// Every request to Walmart Marketplace REST requires three Walmart-specific
// headers:
//   - WM_QOS.CORRELATION_ID    UUID per request (crypto.randomUUID())
//   - WM_SVC.NAME              "Walmart Marketplace" (static)
//   - WM_CONSUMER.CHANNEL.TYPE caller-supplied (default "MARKETPLACE")
//
// Retry: 429 + 5xx → 3 tries with 1s / 2s / 4s backoff. 4xx (non-429) →
// throw immediately with {status, body}.
//
// Tangerine P12b-2.

import { randomUUID } from "node:crypto";

const TOKEN_URL = "https://marketplace.walmartapis.com/v3/token";
const SVC_NAME = "Walmart Marketplace";
const DEFAULT_CHANNEL_TYPE = "MARKETPLACE";
const RETRY_BACKOFFS_MS = [1000, 2000, 4000]; // 3 tries
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
// Refresh whenever <2 minutes remain on the current token.
const REFRESH_BUFFER_MS = 2 * 60 * 1000;

// In-process token cache keyed by clientId. Each entry is
// { access_token, token_type, expires_at_ms, fetched_at_ms }.
const TOKEN_CACHE = new Map();

/**
 * Get a Walmart access token via the client_credentials grant.
 *
 * Caches in-process per clientId and refreshes when <2min remain.
 * Pass `force: true` to bypass the cache (used by tests + manual re-auth).
 *
 * @param {object} opts
 * @param {string} opts.clientId
 * @param {string} opts.clientSecret
 * @param {string} [opts.channelType='MARKETPLACE']
 * @param {boolean} [opts.force=false]   bypass cache
 * @returns {Promise<{access_token: string, token_type: string, expires_in: number, expires_at_ms: number}>}
 */
export async function getWalmartAccessToken({
  clientId,
  clientSecret,
  channelType = DEFAULT_CHANNEL_TYPE,
  force = false,
} = {}) {
  if (!clientId || typeof clientId !== "string") {
    throw new Error("getWalmartAccessToken: clientId is required");
  }
  if (!clientSecret || typeof clientSecret !== "string") {
    throw new Error("getWalmartAccessToken: clientSecret is required");
  }

  const now = Date.now();
  if (!force) {
    const cached = TOKEN_CACHE.get(clientId);
    if (cached && cached.expires_at_ms - now > REFRESH_BUFFER_MS) {
      return { ...cached, expires_in: Math.max(0, Math.floor((cached.expires_at_ms - now) / 1000)) };
    }
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
  const headers = {
    Authorization: `Basic ${basic}`,
    "WM_QOS.CORRELATION_ID": randomUUID(),
    "WM_SVC.NAME": SVC_NAME,
    "WM_CONSUMER.CHANNEL.TYPE": channelType,
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
  };
  const body = "grant_type=client_credentials";

  let lastErr = null;
  for (let attempt = 0; attempt < RETRY_BACKOFFS_MS.length; attempt++) {
    let res;
    try {
      res = await fetch(TOKEN_URL, { method: "POST", headers, body });
    } catch (e) {
      lastErr = { status: 0, body: e instanceof Error ? e.message : String(e) };
      if (attempt < RETRY_BACKOFFS_MS.length - 1) {
        await sleep(RETRY_BACKOFFS_MS[attempt]);
        continue;
      }
      const err = new Error(`Walmart token fetch failed: ${lastErr.body}`);
      err.status = 0;
      err.body = lastErr.body;
      throw err;
    }

    const status = res.status;
    if (status >= 200 && status < 300) {
      const text = await safeText(res);
      let json;
      try { json = JSON.parse(text); }
      catch {
        const err = new Error(`Walmart token response was not JSON: ${text.slice(0, 200)}`);
        err.status = status;
        err.body = text;
        throw err;
      }
      const access_token = json.access_token;
      const token_type = json.token_type || "Bearer";
      const expires_in = Number(json.expires_in) || 900;
      if (!access_token || typeof access_token !== "string") {
        const err = new Error("Walmart token response missing access_token");
        err.status = status;
        err.body = text;
        throw err;
      }
      const expires_at_ms = Date.now() + expires_in * 1000;
      const entry = { access_token, token_type, expires_at_ms, fetched_at_ms: Date.now() };
      TOKEN_CACHE.set(clientId, entry);
      return { ...entry, expires_in };
    }

    const bodyText = await safeText(res);
    if (RETRY_STATUS.has(status) && attempt < RETRY_BACKOFFS_MS.length - 1) {
      lastErr = { status, body: bodyText };
      await sleep(RETRY_BACKOFFS_MS[attempt]);
      continue;
    }
    const err = new Error(`Walmart token POST failed: ${status}`);
    err.status = status;
    err.body = bodyText;
    throw err;
  }

  const err = new Error("Walmart token retries exhausted");
  err.status = lastErr?.status ?? 0;
  err.body = lastErr?.body ?? "";
  throw err;
}

/**
 * Drop the cached token for a clientId. Used by tests + the manual
 * re-auth admin action.
 */
export function clearWalmartTokenCache(clientId) {
  if (clientId === undefined) {
    TOKEN_CACHE.clear();
    return;
  }
  TOKEN_CACHE.delete(clientId);
}

/**
 * Peek at the cache without triggering a refresh. Used by tests.
 * Returns undefined if no entry exists.
 */
export function peekWalmartTokenCache(clientId) {
  return TOKEN_CACHE.get(clientId);
}

/**
 * Build the Basic-auth header value for {clientId, clientSecret}.
 * Exposed for unit tests + reuse from the manual-trigger handler.
 */
export function buildBasicAuthHeader(clientId, clientSecret) {
  if (!clientId || !clientSecret) {
    throw new Error("buildBasicAuthHeader: clientId and clientSecret are required");
  }
  return "Basic " + Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
}

async function safeText(res) {
  try { return await res.text(); }
  catch { return ""; }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
