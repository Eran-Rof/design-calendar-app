// api/_lib/api-key.js
//
// Helpers for vendor API key generation and verification.
//
// Format:
//   raw key = "vnd_" + 32 random bytes encoded as base64url (~43 chars)
//   key_prefix = first 12 chars of the raw key (includes "vnd_")
//   key_hash:
//     v2 (new):    "scrypt2:{N}:{salt_hex}:{hash_hex}"   — N=131072
//     legacy:      "{salt_hex}:{hash_hex}"               — N=1024 (weak)
//
// CLAUDE.md mandates bcrypt(12) for password/token hashes. We don't
// pull bcrypt as a runtime dependency on Vercel functions (extra
// native build), so we use Node's built-in scrypt with N=131072
// (2^17) — computational cost is comparable to bcrypt cost factor 12
// (~250ms per hash). The legacy N=1024 format is honored for verify
// only so existing keys keep working; any new key is written with v2.
//
// Path prefixed with _ so Vercel does not treat it as a serverless function.

import crypto from "node:crypto";

const KEY_PREFIX = "vnd_";
const PREFIX_LEN = KEY_PREFIX.length + 8; // vnd_ + 8 chars
const SCRYPT_N_V2 = 131072;               // 2^17 — bcrypt(12)-equivalent cost
const SCRYPT_N_LEGACY = 1024;             // pre-2026-04-28 keys
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const HASH_LEN = 32;
// scryptSync defaults to a 32MB max memory budget. N=131072, r=8 needs
// ~134MB (128 * N * r bytes), so we set headroom to 256MB. Vercel
// functions have 1024MB by default so this fits.
const SCRYPT_MAX_MEM = 256 * 1024 * 1024;

export function generateApiKey() {
  const raw = KEY_PREFIX + crypto.randomBytes(32).toString("base64url");
  const keyPrefix = raw.slice(0, PREFIX_LEN);
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(raw, salt, HASH_LEN, {
    N: SCRYPT_N_V2, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAX_MEM,
  });
  const keyHash = `scrypt2:${SCRYPT_N_V2}:${salt.toString("hex")}:${hash.toString("hex")}`;
  return { raw, keyPrefix, keyHash };
}

export function verifyApiKey(raw, stored) {
  if (!raw || !stored || typeof stored !== "string") return false;
  const parts = stored.split(":");

  let saltHex, hashHex, N;
  if (parts[0] === "scrypt2" && parts.length === 4) {
    // v2: scrypt2:{N}:{salt}:{hash}
    N = Number(parts[1]);
    saltHex = parts[2];
    hashHex = parts[3];
    if (!Number.isFinite(N) || N < 1024 || N > 1 << 20) return false;
  } else if (parts.length === 2) {
    // legacy: {salt}:{hash} with implicit N=1024
    [saltHex, hashHex] = parts;
    N = SCRYPT_N_LEGACY;
  } else {
    return false;
  }
  if (!saltHex || !hashHex) return false;

  let candidate;
  try {
    candidate = crypto.scryptSync(raw, Buffer.from(saltHex, "hex"), HASH_LEN, {
      N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAX_MEM,
    });
  } catch { return false; }
  const expected = Buffer.from(hashHex, "hex");
  if (candidate.length !== expected.length) return false;
  try { return crypto.timingSafeEqual(candidate, expected); } catch { return false; }
}

// True when the stored hash uses the legacy weak format. Caller can
// re-hash on a successful verify to upgrade in place.
export function isLegacyKeyHash(stored) {
  if (!stored || typeof stored !== "string") return false;
  return !stored.startsWith("scrypt2:");
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
