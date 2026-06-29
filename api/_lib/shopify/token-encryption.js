// api/_lib/shopify/token-encryption.js
//
// AES-256-GCM helpers for encrypting/decrypting Shopify Admin API access
// tokens + webhook HMAC secrets at rest. Same algorithm as Plaid
// (api/_lib/plaid/encryption.js, key = PLAID_TOKEN_ENC_KEY) from P6-2 —
// only the storage layout differs.
//
// Key lives in process.env.SHOPIFY_TOKEN_ENC_KEY (32 bytes / 64 hex chars).
//
// Storage layout in shopify_stores:
//   access_token_ciphertext   bytea   — ciphertext only
//   access_token_iv           bytea   — 12-byte IV
//   access_token_tag          bytea   — 16-byte GCM auth tag
//   webhook_secret_ciphertext bytea   — same triple for the webhook HMAC secret
//   webhook_secret_iv         bytea
//   webhook_secret_tag        bytea
//
// Storing IV + tag in separate columns (vs the Plaid concat-in-one-bytea
// approach) makes the audit + rotation story cleaner: each ciphertext is
// addressable by name in pg dumps.
//
// Decryption is service-role only — neither anon nor authenticated may
// SELECT the *_ciphertext / *_iv / *_tag columns under RLS (enforced by
// the standard anon_all + auth_internal template — service-role bypasses
// RLS entirely, anon/authenticated still see the columns but the API
// layer never returns them).
//
// Tangerine P11-2 — real AES-256-GCM impl. Replaces the P11-1 stub.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;

function getKey() {
  const hex = process.env.SHOPIFY_TOKEN_ENC_KEY;
  if (!hex || typeof hex !== "string") {
    throw new Error("SHOPIFY_TOKEN_ENC_KEY env var is required (64 hex chars / 32 bytes)");
  }
  const clean = hex.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new Error("SHOPIFY_TOKEN_ENC_KEY must be exactly 64 hex characters (32 bytes AES-256 key)");
  }
  return Buffer.from(clean, "hex");
}

/**
 * Encrypt a Shopify Admin API access token or webhook secret into the
 * three-buffer {ciphertext, iv, tag} shape the shopify_stores columns
 * expect.
 *
 * Empty plaintext (null / undefined / "") returns
 * {ciphertext: null, iv: null, tag: null} so the caller can pass the
 * triple straight into an upsert without a conditional — the columns
 * are nullable in the schema (a store row can exist before its token
 * is provisioned).
 *
 * @param {string|null|undefined} plaintext
 * @returns {{ciphertext: Buffer|null, iv: Buffer|null, tag: Buffer|null}}
 */
export function encryptToken(plaintext) {
  if (plaintext == null || plaintext === "") {
    return { ciphertext: null, iv: null, tag: null };
  }
  if (typeof plaintext !== "string") {
    throw new Error("encryptToken: plaintext must be a string");
  }
  const key = getKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext, iv, tag };
}

/**
 * Decrypt a {ciphertext, iv, tag} triple back to the original plaintext.
 *
 * Accepts Buffers, hex strings (with optional `\\x` PostgREST prefix), or
 * base64 strings — Supabase's PostgREST returns bytea as `\\xHEX`, while
 * tests pass Buffers directly.
 *
 * @param {Buffer|string} ciphertext
 * @param {Buffer|string} iv
 * @param {Buffer|string} tag
 * @returns {string}
 */
export function decryptToken(ciphertext, iv, tag) {
  if (ciphertext == null || iv == null || tag == null) {
    throw new Error("decryptToken: ciphertext, iv, and tag are all required");
  }
  const ctBuf = toBuffer(ciphertext, "ciphertext");
  const ivBuf = toBuffer(iv, "iv");
  const tagBuf = toBuffer(tag, "tag");

  if (ivBuf.length !== IV_BYTES) {
    throw new Error(`decryptToken: iv must be ${IV_BYTES} bytes (got ${ivBuf.length})`);
  }
  if (tagBuf.length !== TAG_BYTES) {
    throw new Error(`decryptToken: tag must be ${TAG_BYTES} bytes (got ${tagBuf.length})`);
  }

  const key = getKey();
  const decipher = createDecipheriv("aes-256-gcm", key, ivBuf);
  decipher.setAuthTag(tagBuf);
  const out = Buffer.concat([decipher.update(ctBuf), decipher.final()]);
  return out.toString("utf8");
}

/**
 * Encode a Buffer for insertion into a Postgres `bytea` column via PostgREST /
 * supabase-js, which expects the `\xHEX` hex-string form — NOT a raw JS Buffer
 * (a Buffer JSON-serializes to {"type":"Buffer",...} and the insert is rejected
 * with "invalid input syntax for type bytea"). Null/undefined → null.
 * decryptToken's toBuffer() reads this `\x` form back. Mirrors the Plaid/Faire
 * /FBA encryption modules.
 */
export function toByteaHex(buf) {
  if (buf == null) return null;
  return "\\x" + Buffer.from(buf).toString("hex");
}

function toBuffer(v, label) {
  if (Buffer.isBuffer(v)) return v;
  if (typeof v !== "string") {
    throw new Error(`decryptToken: ${label} must be Buffer or string`);
  }
  if (v.startsWith("\\x")) return Buffer.from(v.slice(2), "hex");
  if (/^[0-9a-fA-F]+$/.test(v) && v.length % 2 === 0) return Buffer.from(v, "hex");
  return Buffer.from(v, "base64");
}

/**
 * Roundtrip self-check — used by /health endpoints + tests to verify
 * SHOPIFY_TOKEN_ENC_KEY is present and keys are wired correctly.
 */
export function selfCheck() {
  // Synthetic test value — NOT a real Shopify access token. Format is
  // intentionally NOT the live Shopify prefix to keep GH secret scanning
  // from flagging this string.
  const sample = "test-roundtrip-sample-not-a-real-token";
  const { ciphertext, iv, tag } = encryptToken(sample);
  const round = decryptToken(ciphertext, iv, tag);
  if (round !== sample) {
    throw new Error("Shopify token encryption self-check failed (roundtrip mismatch)");
  }
  return { ok: true, ciphertext_bytes: ciphertext.length };
}
