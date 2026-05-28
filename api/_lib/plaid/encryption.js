// api/_lib/plaid/encryption.js
//
// AES-256-GCM helpers for encrypting/decrypting Plaid access tokens at rest.
// The key lives in process.env.PLAID_TOKEN_ENC_KEY (32 bytes / 64 hex chars).
//
// Format on disk (bytea in bank_accounts.plaid_access_token_ciphertext):
//   [12-byte IV][16-byte auth tag][N-byte ciphertext]
//
// Decryption is service-role only — neither the anon nor authenticated
// roles can SELECT the ciphertext column under RLS (per P6-1 + cross-check
// in the Plaid handlers).

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;

function getKey() {
  const hex = process.env.PLAID_TOKEN_ENC_KEY;
  if (!hex || typeof hex !== "string") {
    throw new Error("PLAID_TOKEN_ENC_KEY env var is required (64 hex chars / 32 bytes)");
  }
  const clean = hex.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new Error("PLAID_TOKEN_ENC_KEY must be exactly 64 hex characters (32 bytes AES-256 key)");
  }
  return Buffer.from(clean, "hex");
}

/**
 * Encrypt a Plaid access_token (string) into a Buffer suitable for
 * storage in bank_accounts.plaid_access_token_ciphertext (bytea).
 * @param {string} plaintext
 * @returns {Buffer}
 */
export function encryptToken(plaintext) {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("encryptToken: plaintext must be a non-empty string");
  }
  const key = getKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]);
}

/**
 * Decrypt a Buffer (or hex string from PostgREST bytea response) back to
 * the original Plaid access_token.
 * @param {Buffer|string} blob  Buffer, hex string (\\xHEXHEX...), or base64
 * @returns {string}
 */
export function decryptToken(blob) {
  let buf;
  if (Buffer.isBuffer(blob)) {
    buf = blob;
  } else if (typeof blob === "string") {
    // PostgREST returns bytea as the PostgreSQL "hex" format: \\x00ff...
    if (blob.startsWith("\\x")) {
      buf = Buffer.from(blob.slice(2), "hex");
    } else if (/^[0-9a-fA-F]+$/.test(blob)) {
      buf = Buffer.from(blob, "hex");
    } else {
      buf = Buffer.from(blob, "base64");
    }
  } else {
    throw new Error("decryptToken: blob must be Buffer or string");
  }

  if (buf.length < IV_BYTES + TAG_BYTES + 1) {
    throw new Error("decryptToken: ciphertext too short");
  }
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const enc = buf.subarray(IV_BYTES + TAG_BYTES);

  const key = getKey();
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(enc), decipher.final()]);
  return out.toString("utf8");
}

/**
 * Roundtrip self-check — used by /health endpoints + tests to verify
 * PLAID_TOKEN_ENC_KEY is present and keys are wired correctly.
 */
export function selfCheck() {
  const sample = "access-sandbox-12345678-abcd-1234-abcd-123456789012";
  const blob = encryptToken(sample);
  const round = decryptToken(blob);
  if (round !== sample) {
    throw new Error("Plaid token encryption self-check failed (roundtrip mismatch)");
  }
  return { ok: true, ciphertext_bytes: blob.length };
}
