// api/_lib/marketplaces/walmart/token-encryption.js
//
// AES-256-GCM helpers for encrypting/decrypting Walmart Marketplace
// client_credentials OAuth pair (client_id + client_secret) at rest.
// Same pattern as Plaid (api/_lib/plaid/encryption.js, key =
// PLAID_TOKEN_ENC_KEY) from P6-2 and Shopify (api/_lib/shopify/
// token-encryption.js, key = SHOPIFY_TOKEN_ENC_KEY) from P11-1.
//
// Key lives in process.env.WALMART_TOKEN_ENC_KEY (32 bytes / 64 hex chars).
//
// Storage layout in walmart_seller_accounts:
//   client_id_ciphertext       bytea   — ciphertext only
//   client_id_iv               bytea   — 12-byte IV
//   client_id_tag              bytea   — 16-byte GCM auth tag
//   client_secret_ciphertext   bytea   — same triple for the client_secret
//   client_secret_iv           bytea
//   client_secret_tag          bytea
//
// Storing IV + tag in separate columns (vs the Plaid concat-in-one-bytea
// approach) matches the Shopify P11-1 pattern: each ciphertext is
// addressable by name in pg dumps, audit + rotation story stays clean.
//
// Decryption is service-role only — neither anon nor authenticated may
// SELECT the *_ciphertext / *_iv / *_tag columns under RLS (enforced by
// the standard anon_all + auth_internal template — service-role bypasses
// RLS entirely, anon/authenticated still see the columns but the API
// layer never returns them).
//
// REAL IMPLEMENTATION LANDS IN P12b-2. This module ships the contract
// only (P12b-1 schema chunk). Calling either function before P12b-2
// throws so the test suite can assert the stub is wired.

/**
 * Encrypt a Walmart client_credentials OAuth client_id or client_secret
 * into the three-buffer {ciphertext, iv, tag} shape the
 * walmart_seller_accounts columns expect.
 *
 * @param {string} plaintext  Walmart client_id or client_secret
 * @returns {{ciphertext: Buffer, iv: Buffer, tag: Buffer}}
 */
export function encryptToken(plaintext) {
  // TODO P12b-2 — AES-256-GCM with key = process.env.WALMART_TOKEN_ENC_KEY.
  // See api/_lib/plaid/encryption.js for the canonical reference.
  void plaintext;
  throw new Error("walmart token encryption not implemented yet (lands in P12b-2)");
}

/**
 * Decrypt a {ciphertext, iv, tag} triple back to the original Walmart
 * client_id / client_secret.
 *
 * @param {Buffer|string} ciphertext
 * @param {Buffer|string} iv
 * @param {Buffer|string} tag
 * @returns {string}
 */
export function decryptToken(ciphertext, iv, tag) {
  // TODO P12b-2 — AES-256-GCM with key = process.env.WALMART_TOKEN_ENC_KEY.
  void ciphertext;
  void iv;
  void tag;
  throw new Error("walmart token decryption not implemented yet (lands in P12b-2)");
}
