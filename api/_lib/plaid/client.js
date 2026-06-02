// api/_lib/plaid/client.js
//
// Thin wrapper over Plaid's REST API. No npm dependency — just fetch() to
// https://{env}.plaid.com endpoints. Env-driven (PLAID_ENV=sandbox|production).
//
// Endpoints used:
//   POST /link/token/create
//   POST /item/public_token/exchange
//   POST /transactions/sync
//   POST /accounts/balance/get  (optional balance refresh)
//   POST /webhook/verification_key/get  (for webhook signature verification)
//
// Errors are normalized into a PlaidError class with .code (Plaid's
// error_code) and .type (error_type) for handler-side mapping.

export class PlaidError extends Error {
  constructor(message, { code, type, status, request_id }) {
    super(message);
    this.code = code || null;
    this.type = type || null;
    this.status = status || null;
    this.request_id = request_id || null;
  }
}

function baseUrl() {
  const env = (process.env.PLAID_ENV || "sandbox").toLowerCase();
  switch (env) {
    case "sandbox":    return "https://sandbox.plaid.com";
    case "development":return "https://development.plaid.com";
    case "production": return "https://production.plaid.com";
    default:
      throw new Error(`PLAID_ENV must be sandbox|development|production (got ${env})`);
  }
}

function requireEnv() {
  if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) {
    throw new Error("Plaid integration disabled: PLAID_CLIENT_ID and PLAID_SECRET env vars required");
  }
}

/**
 * Generic Plaid POST request. Adds client_id+secret to the body
 * automatically; returns parsed JSON on 2xx, throws PlaidError on 4xx/5xx.
 */
export async function plaidPost(path, body) {
  requireEnv();
  const url = `${baseUrl()}${path}`;
  const payload = {
    client_id: process.env.PLAID_CLIENT_ID,
    secret:    process.env.PLAID_SECRET,
    ...body,
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; }
  catch { json = { raw: text }; }
  if (!r.ok) {
    throw new PlaidError(
      json.error_message || `Plaid ${r.status} on ${path}`,
      {
        code: json.error_code,
        type: json.error_type,
        status: r.status,
        request_id: json.request_id,
      },
    );
  }
  return json;
}

/**
 * POST /link/token/create — generates the link_token consumed by the
 * Plaid Link frontend SDK. Operator opens Plaid Link → signs in to their
 * bank → returns a public_token → backend exchanges it (see exchange()).
 *
 * @param {Object} ctx
 * @param {string} ctx.client_user_id   stable per-operator id (entity_users.auth_id is fine)
 * @param {string} ctx.client_name      shown to the user in Link UI; default "Tangerine"
 * @param {string[]} [ctx.products]     defaults to ['transactions']
 * @param {string[]} [ctx.country_codes] defaults to ['US']
 * @param {string} [ctx.webhook]        absolute URL Plaid will ping; should be /api/webhooks/plaid
 */
export async function createLinkToken(ctx) {
  if (!ctx.client_user_id) throw new Error("createLinkToken: client_user_id required");
  return plaidPost("/link/token/create", {
    client_name:   ctx.client_name || "Tangerine",
    user:          { client_user_id: String(ctx.client_user_id) },
    products:      ctx.products      || ["transactions"],
    country_codes: ctx.country_codes  || ["US"],
    language:      ctx.language       || "en",
    ...(ctx.webhook ? { webhook: ctx.webhook } : {}),
  });
}

/**
 * POST /item/public_token/exchange — exchanges a Plaid Link public_token
 * for a long-lived access_token + item_id. The access_token is what's
 * encrypted + stored in bank_accounts.plaid_access_token_ciphertext.
 */
export async function exchangePublicToken(public_token) {
  if (!public_token) throw new Error("exchangePublicToken: public_token required");
  return plaidPost("/item/public_token/exchange", { public_token });
}

/**
 * POST /accounts/get — lists the sub-accounts inside a Plaid Item. Used
 * during exchange to enumerate which accounts to mirror as bank_accounts
 * rows (one Item = one institution login; may contain multiple accounts).
 */
export async function getAccounts(access_token) {
  if (!access_token) throw new Error("getAccounts: access_token required");
  return plaidPost("/accounts/get", { access_token });
}

/**
 * POST /transactions/sync — cursor-based incremental transaction pull.
 * On first call (cursor=null), Plaid returns the initial chunk + a cursor.
 * Subsequent calls with that cursor return only deltas since then.
 *
 * Returns Plaid's full response: { added, modified, removed, next_cursor,
 *   has_more, accounts, ... }.
 */
export async function syncTransactions(access_token, cursor) {
  if (!access_token) throw new Error("syncTransactions: access_token required");
  return plaidPost("/transactions/sync", {
    access_token,
    ...(cursor ? { cursor } : {}),
    options: { include_personal_finance_category: true },
  });
}

/**
 * POST /webhook/verification_key/get — Plaid signs webhooks with a JWS;
 * this fetches the verification key corresponding to the kid in the JWS
 * header. Cache the key by kid for the lifetime of the function instance.
 */
export async function getWebhookVerificationKey(key_id) {
  if (!key_id) throw new Error("getWebhookVerificationKey: key_id required");
  return plaidPost("/webhook/verification_key/get", { key_id });
}

/**
 * Helper for handlers: is the Plaid integration available right now?
 * Returns false (rather than throwing) when env vars are missing — lets
 * callers degrade gracefully ("Plaid not configured; use CSV upload").
 */
export function isPlaidConfigured() {
  return !!(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
}
