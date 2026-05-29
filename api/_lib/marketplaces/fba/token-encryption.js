// api/_lib/marketplaces/fba/token-encryption.js
//
// AES-256-GCM helpers for encrypting/decrypting Amazon SP-API LWA OAuth
// credentials at rest. Same pattern as api/_lib/shopify/token-encryption.js
// (SHOPIFY_TOKEN_ENC_KEY) and api/_lib/plaid/encryption.js
// (PLAID_TOKEN_ENC_KEY).
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
//
// REAL IMPLEMENTATION LANDS IN P12a-2. This module ships the contract
// only (P12a-1 schema chunk). Calling either function before P12a-2
// throws so the test suite can assert the stub is wired.

/**
 * Encrypt an Amazon SP-API LWA credential (refresh token / client id /
 * client secret) into the three-buffer {ciphertext, iv, tag} shape the
 * fba_seller_accounts columns expect.
 *
 * @param {string} plaintext  LWA refresh token, client id, or client secret
 * @returns {{ciphertext: Buffer, iv: Buffer, tag: Buffer}}
 */
export function encryptToken(plaintext) {
  // TODO P12a-2 — AES-256-GCM with key = process.env.FBA_TOKEN_ENC_KEY.
  // See api/_lib/shopify/token-encryption.js (when implemented in P11-2)
  // and api/_lib/plaid/encryption.js for the canonical reference.
  void plaintext;
  throw new Error("fba token encryption not implemented yet (lands in P12a-2)");
}

/**
 * Decrypt a {ciphertext, iv, tag} triple back to the original LWA
 * refresh token / client id / client secret.
 *
 * @param {Buffer|string} ciphertext
 * @param {Buffer|string} iv
 * @param {Buffer|string} tag
 * @returns {string}
 */
export function decryptToken(ciphertext, iv, tag) {
  // TODO P12a-2 — AES-256-GCM with key = process.env.FBA_TOKEN_ENC_KEY.
  void ciphertext;
  void iv;
  void tag;
  throw new Error("fba token decryption not implemented yet (lands in P12a-2)");
}
