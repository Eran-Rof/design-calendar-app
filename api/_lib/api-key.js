// api/_lib/api-key.js
//
// Helpers for vendor API key generation and verification.
//
// Format:
//   raw key = "vnd_" + 32 random bytes encoded as base64url (~43 chars)
//   key_prefix = first 12 chars of the raw key (includes "vnd_")
//   key_hash   = "{salt_hex}:{scrypt_hash_hex}"
//
// Path prefixed with _ so Vercel does not treat it as a serverless function.

import crypto from "node:crypto";

const KEY_PREFIX = "vnd_";
const PREFIX_LEN = KEY_PREFIX.length + 8; // vnd_ + 8 chars
const SCRYPT_N = 1024;                    // fast enough for per-request verify
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const HASH_LEN = 32;

export function generateApiKey() {
  const raw = KEY_PREFIX + crypto.randomBytes(32).toString("base64url");
  const keyPrefix = raw.slice(0, PREFIX_LEN);
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(raw, salt, HASH_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  const keyHash = `${salt.toString("hex")}:${hash.toString("hex")}`;
  return { raw, keyPrefix, keyHash };
}

export function verifyApiKey(raw, stored) {
  if (!raw || !stored || typeof stored !== "string") return false;
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  let candidate;
  try {
    candidate = crypto.scryptSync(raw, Buffer.from(saltHex, "hex"), HASH_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  } catch { return false; }
  const expected = Buffer.from(hashHex, "hex");
  if (candidate.length !== expected.length) return false;
  try { return crypto.timingSafeEqual(candidate, expected); } catch { return false; }
}

export function keyPrefixFromRaw(raw) {
  if (!raw || typeof raw !== "string") return null;
  if (!raw.startsWith(KEY_PREFIX)) return null;
  return raw.slice(0, PREFIX_LEN);
}

export const VALID_SCOPES = [
  "pos:read",
  "invoices:read",
  "invoices:write",
  "shipments:write",
  "catalog:read",
  "catalog:write",
];
