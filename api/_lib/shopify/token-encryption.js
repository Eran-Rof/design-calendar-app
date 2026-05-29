// api/_lib/shopify/token-encryption.js
//
// AES-256-GCM helpers for encrypting/decrypting Shopify Admin API access
// tokens + webhook HMAC secrets at rest. Same pattern as Plaid
// (api/_lib/plaid/encryption.js, key = PLAID_TOKEN_ENC_KEY) from P6-2.
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
// REAL IMPLEMENTATION LANDS IN P11-2. This module ships the contract
// only (P11-1 schema chunk). Calling either function before P11-2
// throws so the test suite can assert the stub is wired.

/**
 * Encrypt a Shopify Admin API access token or webhook secret into the
 * three-buffer {ciphertext, iv, tag} shape the shopify_stores columns
 * expect.
 *
 * @param {string} plaintext  Shopify access token (shpat_...) or webhook secret
 * @returns {{ciphertext: Buffer, iv: Buffer, tag: Buffer}}
 */
export function encryptToken(plaintext) {
  // TODO P11-2 — AES-256-GCM with key = process.env.SHOPIFY_TOKEN_ENC_KEY.
  // See api/_lib/plaid/encryption.js for the canonical reference.
  void plaintext;
  throw new Error("shopify token encryption not implemented yet (lands in P11-2)");
}

/**
 * Decrypt a {ciphertext, iv, tag} triple back to the original Shopify
 * access token / webhook secret.
 *
 * @param {Buffer|string} ciphertext
 * @param {Buffer|string} iv
 * @param {Buffer|string} tag
 * @returns {string}
 */
export function decryptToken(ciphertext, iv, tag) {
  // TODO P11-2 — AES-256-GCM with key = process.env.SHOPIFY_TOKEN_ENC_KEY.
  void ciphertext;
  void iv;
  void tag;
  throw new Error("shopify token decryption not implemented yet (lands in P11-2)");
}
