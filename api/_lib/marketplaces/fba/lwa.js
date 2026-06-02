// api/_lib/marketplaces/fba/lwa.js
//
// Amazon Login With Amazon (LWA) — refresh-token → access-token flow.
//
// Each fba_seller_accounts row holds an encrypted LWA refresh_token (long-
// lived) plus the LWA client_id / client_secret pair. To call SP-API we
// must exchange those three for a short-lived access_token (1 hour TTL).
//
// Endpoint: POST https://api.amazon.com/auth/o2/token
// Body (application/x-www-form-urlencoded):
//   grant_type=refresh_token
//   refresh_token=<refresh>
//   client_id=<client_id>
//   client_secret=<client_secret>
//
// Response (200):
//   { access_token, token_type, expires_in, refresh_token }
//
// We cache the access_token in-process keyed by refreshToken so a single
// cron invocation that fans out across many SP-API calls only hits LWA
// once per account. Cache TTL = expires_in - 5 minutes safety margin.
//
// Pure fetch + exponential-backoff retry on 429 / 5xx (3 tries: 1s/2s/4s).
// 401 / 400 from LWA = throw immediately (means client_id/secret/refresh
// are wrong; retry is pointless).

const LWA_ENDPOINT = "https://api.amazon.com/auth/o2/token";
const SAFETY_MARGIN_MS = 5 * 60 * 1000; // refresh 5 min before expiry
const DEFAULT_RETRIES = 3;
const RETRY_DELAYS_MS = [1000, 2000, 4000];

/**
 * In-process cache keyed by refresh_token.
 *   refreshToken → { accessToken, tokenType, expiresAt (ms epoch) }
 *
 * Exported for tests so they can clear between runs. The cache survives
 * across requests within the same warm Vercel function instance, which
 * is the cost-saving point: one LWA refresh per cold start instead of
 * one per outbound SP-API call.
 */
export const tokenCache = new Map();

export function _clearCacheForTest() {
  tokenCache.clear();
}

/**
 * Refresh (or return cached) LWA access token.
 *
 * @param {Object} args
 * @param {string} args.clientId      LWA client_id (amzn1.application-oa2-client.*)
 * @param {string} args.clientSecret  LWA client_secret
 * @param {string} args.refreshToken  long-lived LWA refresh_token (Atzr|...)
 * @param {Object} [args.deps]        injection point for tests
 * @param {Function} [args.deps.fetchFn]    override global fetch
 * @param {Function} [args.deps.sleepFn]    override the backoff sleep
 * @param {Function} [args.deps.nowFn]      override Date.now()
 * @returns {Promise<{access_token: string, token_type: string, expires_in: number, cached: boolean}>}
 */
export async function refreshLwaAccessToken(args) {
  if (!args || typeof args !== "object") {
    throw new Error("refreshLwaAccessToken: args object required");
  }
  const { clientId, clientSecret, refreshToken, deps = {} } = args;
  if (!clientId || typeof clientId !== "string") {
    throw new Error("refreshLwaAccessToken: clientId required");
  }
  if (!clientSecret || typeof clientSecret !== "string") {
    throw new Error("refreshLwaAccessToken: clientSecret required");
  }
  if (!refreshToken || typeof refreshToken !== "string") {
    throw new Error("refreshLwaAccessToken: refreshToken required");
  }

  const fetchFn = deps.fetchFn || globalThis.fetch;
  const sleepFn = deps.sleepFn || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const nowFn = deps.nowFn || (() => Date.now());

  const cached = tokenCache.get(refreshToken);
  if (cached && cached.expiresAt - SAFETY_MARGIN_MS > nowFn()) {
    return {
      access_token: cached.accessToken,
      token_type: cached.tokenType,
      expires_in: Math.max(0, Math.floor((cached.expiresAt - nowFn()) / 1000)),
      cached: true,
    };
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  let lastErr = null;
  for (let attempt = 0; attempt < DEFAULT_RETRIES; attempt++) {
    let resp;
    try {
      resp = await fetchFn(LWA_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
    } catch (e) {
      // Network error — retryable.
      lastErr = e instanceof Error ? e : new Error(String(e));
      if (attempt < DEFAULT_RETRIES - 1) {
        await sleepFn(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw lastErr;
    }

    const status = resp.status;
    let text;
    try { text = await resp.text(); } catch { text = ""; }
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }

    if (status >= 200 && status < 300) {
      const accessToken = json.access_token;
      const tokenType = json.token_type || "bearer";
      const expiresIn = Number(json.expires_in) || 3600;
      if (!accessToken) {
        throw new Error(`LWA refresh returned 200 but no access_token: ${text.slice(0, 200)}`);
      }
      const expiresAt = nowFn() + expiresIn * 1000;
      tokenCache.set(refreshToken, { accessToken, tokenType, expiresAt });
      return { access_token: accessToken, token_type: tokenType, expires_in: expiresIn, cached: false };
    }

    if (status === 429 || status >= 500) {
      lastErr = new Error(`LWA refresh ${status}: ${text.slice(0, 200)}`);
      if (attempt < DEFAULT_RETRIES - 1) {
        await sleepFn(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      const err = new Error(`LWA refresh failed after ${DEFAULT_RETRIES} attempts (last status=${status}): ${text.slice(0, 200)}`);
      err.status = status;
      err.body = json;
      throw err;
    }

    // 4xx other than 429 — invalid creds / bad request. Don't retry.
    const err = new Error(`LWA refresh failed (status=${status}): ${json.error_description || json.error || text.slice(0, 200)}`);
    err.status = status;
    err.body = json;
    throw err;
  }
  throw lastErr || new Error("LWA refresh failed (no response)");
}
