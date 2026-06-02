// api/_lib/marketplaces/fba/token-encryption.js
//
// AES-256-GCM helpers for encrypting/decrypting Amazon SP-API LWA OAuth
// credentials at rest. Pattern matches api/_lib/plaid/encryption.js
// (PLAID_TOKEN_ENC_KEY) from P6-2, but uses the three-buffer
// {ciphertext, iv, tag} return shape required by the fba_seller_accounts
// column layout (one *_ciphertext / *_iv / *_tag triple per secret).
//
// Key lives in process.env.FBA_TOKEN_ENC_KEY (32 bytes / 64 hex chars).
//
// Storage layout in fba_seller_accounts:
//   lwa_client_id_ciphertext         bytea
//   lwa_client_id_iv                 bytea   — 12-byte IV
//   lwa_client_id_tag                bytea   — 16-byte GCM auth tag
//   lwa_client_secret_ciphertext     bytea
//   lwa_client_secret_iv             bytea
//   lwa_client_secret_tag            bytea
//   refresh_token_ciphertext         bytea
//   refresh_token_iv                 bytea
//   refresh_token_tag                bytea
//
// Storing IV + tag in separate columns (vs the Plaid concat-in-one-bytea
// approach) matches the Shopify P11 pattern: each ciphertext is
// addressable by name in pg dumps for auditability + rotation.
//
// Decryption is service-role only — neither anon nor authenticated may
// SELECT the *_ciphertext / *_iv / *_tag columns under RLS (enforced by
// the standard anon_all + auth_internal template — service-role bypasses
// RLS entirely, anon/authenticated still see the columns but the API
// layer never returns them).

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;

function getKey() {
  const hex = process.env.FBA_TOKEN_ENC_KEY;
  if (!hex || typeof hex !== "string") {
    throw new Error("FBA_TOKEN_ENC_KEY env var is required (64 hex chars / 32 bytes)");
  }
  const clean = hex.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new Error("FBA_TOKEN_ENC_KEY must be exactly 64 hex characters (32 bytes AES-256 key)");
  }
  return Buffer.from(clean, "hex");
}

/**
 * Coerce a Buffer | hex-string ("\\x...") | base64-string back into a Buffer.
 * Mirrors plaid/encryption.js — PostgREST returns bytea as "\\xHEX".
 *
 * @param {Buffer|string} input
 * @param {string} label
 * @returns {Buffer}
 */
function coerceBuffer(input, label) {
  if (Buffer.isBuffer(input)) return input;
  if (typeof input !== "string") {
    throw new Error(`decryptToken: ${label} must be Buffer or string`);
  }
  if (input.startsWith("\\x")) return Buffer.from(input.slice(2), "hex");
  if (/^[0-9a-fA-F]+$/.test(input)) return Buffer.from(input, "hex");
  return Buffer.from(input, "base64");
}

/**
 * Encrypt an Amazon SP-API LWA credential (refresh token / client id /
 * client secret) into the three-buffer {ciphertext, iv, tag} shape the
 * fba_seller_accounts columns expect.
 *
 * @param {string} plaintext  LWA refresh token, client id, or client secret
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
 * Decrypt a {ciphertext, iv, tag} triple back to the original LWA
 * refresh token / client id / client secret.
 *
 * Each argument may be a Buffer or a PostgREST-style bytea string
 * (\\xHEX | raw hex | base64).
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
  const ctBuf = coerceBuffer(ciphertext, "ciphertext");
  const ivBuf = coerceBuffer(iv, "iv");
  const tagBuf = coerceBuffer(tag, "tag");

  if (ivBuf.length !== IV_BYTES) {
    throw new Error(`decryptToken: iv must be ${IV_BYTES} bytes (got ${ivBuf.length})`);
  }
  if (tagBuf.length !== TAG_BYTES) {
    throw new Error(`decryptToken: tag must be ${TAG_BYTES} bytes (got ${tagBuf.length})`);
  }
  if (ctBuf.length < 1) {
    throw new Error("decryptToken: ciphertext too short");
  }

  const key = getKey();
  const decipher = createDecipheriv("aes-256-gcm", key, ivBuf);
  decipher.setAuthTag(tagBuf);
  const out = Buffer.concat([decipher.update(ctBuf), decipher.final()]);
  return out.toString("utf8");
}

/**
 * Roundtrip self-check — used by /health endpoints + tests to verify
 * FBA_TOKEN_ENC_KEY is present and keys are wired correctly.
 */
export function selfCheck() {
  const sample = "Atzr|IwEBIE_sample_lwa_refresh_token_for_selfcheck_only";
  const blob = encryptToken(sample);
  const round = decryptToken(blob.ciphertext, blob.iv, blob.tag);
  if (round !== sample) {
    throw new Error("FBA token encryption self-check failed (roundtrip mismatch)");
  }
  return {
    ok: true,
    ciphertext_bytes: blob.ciphertext.length,
    iv_bytes: blob.iv.length,
    tag_bytes: blob.tag.length,
  };
}
