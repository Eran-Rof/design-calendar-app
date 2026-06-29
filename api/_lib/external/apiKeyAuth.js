// api/_lib/external/apiKeyAuth.js
//
// Authentication for the READ-ONLY external/partner API (/api/external/v1/*).
//
// Key shape:  "prefix.secret"
//   prefix = "rofk_" + 8 url-safe chars   (public, stored, used for O(1) lookup)
//   secret = 32 random bytes base64url     (never stored)
//   raw    = prefix + "." + secret         (shown to the operator exactly once)
//
// We store only:
//   key_prefix — the part before the dot (UNIQUE column → single-row lookup)
//   key_hash   — sha-256 hex of the FULL raw key
//
// Verification re-hashes the presented Bearer key and timing-safe compares
// against the stored hash. sha-256 is appropriate here because the secret is
// 256 bits of CSPRNG entropy (not a low-entropy password), so a fast hash is
// safe and lets us look up by prefix without scanning.
//
// Path is under _lib so Vercel does not treat it as a serverless function.

import crypto from "node:crypto";

export const KEY_PREFIX_TAG = "rofk_";
const PREFIX_RAND_LEN = 8;

/** sha-256 hex of an arbitrary string. */
export function hashKey(raw) {
  return crypto.createHash("sha256").update(String(raw), "utf8").digest("hex");
}

/**
 * Mint a new external API key.
 * @returns {{ raw:string, keyPrefix:string, keyHash:string }}
 *   raw     — the full "prefix.secret" key (return to caller ONCE, never store)
 *   keyPrefix — the public prefix (store + display)
 *   keyHash — sha-256 hex of raw (store; never reversible to the secret)
 */
export function generateApiKey() {
  const rand = crypto.randomBytes(6).toString("base64url").slice(0, PREFIX_RAND_LEN);
  const keyPrefix = `${KEY_PREFIX_TAG}${rand}`;
  const secret = crypto.randomBytes(32).toString("base64url");
  const raw = `${keyPrefix}.${secret}`;
  return { raw, keyPrefix, keyHash: hashKey(raw) };
}

/** Extract the public prefix (text before the first dot) from a raw key. */
export function keyPrefixFromRaw(raw) {
  if (!raw || typeof raw !== "string") return null;
  const dot = raw.indexOf(".");
  if (dot <= 0) return null;
  const prefix = raw.slice(0, dot);
  if (!prefix.startsWith(KEY_PREFIX_TAG)) return null;
  return prefix;
}

/** Constant-time compare of a raw key against a stored sha-256 hex hash. */
export function verifyKey(raw, storedHash) {
  if (!raw || typeof storedHash !== "string" || storedHash.length === 0) return false;
  const candidate = Buffer.from(hashKey(raw), "hex");
  let expected;
  try { expected = Buffer.from(storedHash, "hex"); } catch { return false; }
  if (candidate.length !== expected.length || candidate.length === 0) return false;
  try { return crypto.timingSafeEqual(candidate, expected); } catch { return false; }
}

/** Pull the bearer token out of an Authorization header. */
export function bearerToken(req) {
  const h = req?.headers?.authorization || req?.headers?.Authorization;
  if (typeof h !== "string") return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

/**
 * Authenticate an external API request against external_api_keys.
 *
 * @param {object} admin  service-role Supabase client
 * @param {object} req    the incoming request (reads Authorization header)
 * @returns {Promise<null | { entity_id:string, scopes:string[], key_id:string }>}
 *   null when no/invalid/inactive key. On success, best-effort updates
 *   last_used_at and returns the entity + scopes for downstream filtering.
 */
export async function authenticateApiKey(admin, req) {
  if (!admin) return null;
  const raw = bearerToken(req);
  if (!raw) return null;
  const keyPrefix = keyPrefixFromRaw(raw);
  if (!keyPrefix) return null;

  const { data, error } = await admin
    .from("external_api_keys")
    .select("id, entity_id, key_hash, scopes, is_active")
    .eq("key_prefix", keyPrefix)
    .maybeSingle();
  if (error || !data || data.is_active === false) return null;
  if (!verifyKey(raw, data.key_hash)) return null;

  // Best-effort touch — never blocks or fails the request.
  admin.from("external_api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", data.id)
    .then(() => {}, () => {});

  return {
    entity_id: data.entity_id,
    scopes: Array.isArray(data.scopes) ? data.scopes : ["read"],
    key_id: data.id,
  };
}
