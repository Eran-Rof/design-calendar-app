// api/_lib/marketplaces/faire/token-encryption.js
//
// AES-256-GCM helpers for encrypting/decrypting the Faire static API key
// at rest. P12c-2 ships the real implementation; the contract shape was
// frozen in P12c-1 (separate ciphertext / iv / tag buffers, matching the
// Shopify pattern — each addressable by name for pg-dump audit + rotation).
//
// Key lives in process.env.FAIRE_TOKEN_ENC_KEY (32 bytes / 64 hex chars).
//
// Faire auth model (D3): static API key sent in the X-FAIRE-OAUTH-ACCESS-TOKEN
// header (despite the "OAUTH" in the name — Faire has no OAuth dance; it's a
// long-lived static key the operator pastes once in the Faire brand portal).
// No rotation cron; the API layer encrypts on insert and decrypts on use.
//
// Storage layout in faire_shops:
//   api_key_ciphertext   bytea   — ciphertext only
//   api_key_iv           bytea   — 12-byte IV
//   api_key_tag          bytea   — 16-byte GCM auth tag
//
// Decryption is service-role only — neither anon nor authenticated may
// usefully SELECT the *_ciphertext / *_iv / *_tag columns through the API
// (the API layer never returns them; service-role bypasses RLS for the
// poller cron).

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;

function getKey() {
  const hex = process.env.FAIRE_TOKEN_ENC_KEY;
  if (!hex || typeof hex !== "string") {
    throw new Error("FAIRE_TOKEN_ENC_KEY env var is required (64 hex chars / 32 bytes)");
  }
  const clean = hex.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new Error("FAIRE_TOKEN_ENC_KEY must be exactly 64 hex characters (32 bytes AES-256 key)");
  }
  return Buffer.from(clean, "hex");
}

/**
 * Coerce a bytea field (Buffer, PostgREST '\\xHEX' string, raw hex string,
 * or base64 string) to a Buffer.
 */
function coerceBytea(blob, label) {
  if (Buffer.isBuffer(blob)) return blob;
  if (typeof blob !== "string") {
    throw new Error(`decryptToken: ${label} must be Buffer or string`);
  }
  if (blob.startsWith("\\x")) return Buffer.from(blob.slice(2), "hex");
  if (/^[0-9a-fA-F]+$/.test(blob) && blob.length % 2 === 0) return Buffer.from(blob, "hex");
  return Buffer.from(blob, "base64");
}

/**
 * Encrypt a Faire static API key into the three-buffer
 * {ciphertext, iv, tag} shape the faire_shops columns expect.
 *
 * @param {string} plaintext  Faire API key as pasted from the brand portal
 * @returns {{ciphertext: Buffer, iv: Buffer, tag: Buffer}}
 */
export function encryptToken(plaintext) {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("encryptToken: plaintext must be a non-empty string");
  }
  const key = getKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext, iv, tag };
}

/**
 * Decrypt a {ciphertext, iv, tag} triple back to the original Faire API key.
 *
 * @param {Buffer|string} ciphertext
 * @param {Buffer|string} iv
 * @param {Buffer|string} tag
 * @returns {string}
 */
export function decryptToken(ciphertext, iv, tag) {
  const cBuf = coerceBytea(ciphertext, "ciphertext");
  const iBuf = coerceBytea(iv, "iv");
  const tBuf = coerceBytea(tag, "tag");

  if (iBuf.length !== IV_BYTES) {
    throw new Error(`decryptToken: iv must be ${IV_BYTES} bytes (got ${iBuf.length})`);
  }
  if (tBuf.length !== TAG_BYTES) {
    throw new Error(`decryptToken: tag must be ${TAG_BYTES} bytes (got ${tBuf.length})`);
  }
  if (cBuf.length === 0) {
    throw new Error("decryptToken: ciphertext is empty");
  }

  const key = getKey();
  const decipher = createDecipheriv("aes-256-gcm", key, iBuf);
  decipher.setAuthTag(tBuf);
  const out = Buffer.concat([decipher.update(cBuf), decipher.final()]);
  return out.toString("utf8");
}

/**
 * Roundtrip self-check — used by /health endpoints + tests to verify
 * FAIRE_TOKEN_ENC_KEY is present and keys are wired correctly.
 */
export function selfCheck() {
  const sample = "faire-test-static-api-key-1234567890";
  const { ciphertext, iv, tag } = encryptToken(sample);
  const round = decryptToken(ciphertext, iv, tag);
  if (round !== sample) {
    throw new Error("Faire token encryption self-check failed (roundtrip mismatch)");
  }
  return { ok: true, ciphertext_bytes: ciphertext.length };
}
