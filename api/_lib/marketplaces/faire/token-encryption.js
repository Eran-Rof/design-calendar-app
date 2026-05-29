// api/_lib/marketplaces/faire/token-encryption.js
//
// AES-256-GCM helpers for encrypting/decrypting the Faire static API key
// at rest. Same shape as the Shopify token-encryption stub
// (api/_lib/shopify/token-encryption.js, key = SHOPIFY_TOKEN_ENC_KEY) and
// the Plaid encryption module (api/_lib/plaid/encryption.js, key =
// PLAID_TOKEN_ENC_KEY) from P6-2.
//
// Key lives in process.env.FAIRE_TOKEN_ENC_KEY (32 bytes / 64 hex chars).
//
// Faire auth model (D3): static API key sent in the X-FAIRE-ACCESS-TOKEN
// header — no OAuth, no token rotation cron. Operator generates the key
// once in the Faire brand portal and pastes it into the Tangerine Faire
// Shops panel; the API layer encrypts it with this module before
// persisting to faire_shops.api_key_*.
//
// Storage layout in faire_shops:
//   api_key_ciphertext   bytea   — ciphertext only
//   api_key_iv           bytea   — 12-byte IV
//   api_key_tag          bytea   — 16-byte GCM auth tag
//
// Storing IV + tag in separate columns (vs the Plaid concat-in-one-bytea
// approach) matches P11-1's pattern: each ciphertext is addressable by
// name in pg dumps and rotation is column-scoped.
//
// Decryption is service-role only — neither anon nor authenticated may
// usefully SELECT the *_ciphertext / *_iv / *_tag columns through the API
// (the API layer never returns them; service-role bypasses RLS for the
// poller cron).
//
// REAL IMPLEMENTATION LANDS IN P12c-2. This module ships the contract
// only (P12c-1 schema chunk). Calling either function before P12c-2
// throws so the test suite can assert the stub is wired.

/**
 * Encrypt a Faire static API key into the three-buffer
 * {ciphertext, iv, tag} shape the faire_shops columns expect.
 *
 * @param {string} plaintext  Faire API key as pasted from the brand portal
 * @returns {{ciphertext: Buffer, iv: Buffer, tag: Buffer}}
 */
export function encryptToken(plaintext) {
  // TODO P12c-2 — AES-256-GCM with key = process.env.FAIRE_TOKEN_ENC_KEY.
  // See api/_lib/plaid/encryption.js for the canonical reference.
  void plaintext;
  throw new Error("faire token encryption not implemented yet (lands in P12c-2)");
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
  // TODO P12c-2 — AES-256-GCM with key = process.env.FAIRE_TOKEN_ENC_KEY.
  void ciphertext;
  void iv;
  void tag;
  throw new Error("faire token decryption not implemented yet (lands in P12c-2)");
}
