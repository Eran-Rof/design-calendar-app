// api/_lib/crypto.js
//
// AES-256-GCM encryption helpers for vendor sensitive fields (banking
// account numbers, ERP config, tax IDs). The key comes from env:
//
//   VENDOR_DATA_ENCRYPTION_KEY — 32 raw bytes as hex (64 chars) or
//                                base64. Rotate by re-encrypting all
//                                rows from the API layer.
//
// Ciphertext format stored in the DB: "{iv_hex}:{tag_hex}:{ct_hex}".
// The leading underscore on this directory excludes it from Vercel's
// serverless function build.

import crypto from "node:crypto";

function loadKey() {
  const raw = process.env.VENDOR_DATA_ENCRYPTION_KEY;
  if (!raw) throw new Error("VENDOR_DATA_ENCRYPTION_KEY is not set");
  // Accept hex (64 chars) or base64-encoded 32 bytes. ANYTHING ELSE FAILS
  // CLOSED (2026-07-07): the old fallback silently scrypt-derived a key from
  // an arbitrary passphrase, so a mis-set env var still "worked" — banking/tax
  // data would be encrypted under a low-entropy key with no one the wiser.
  // Prod runs a proper 64-hex key (verified against Vercel 2026-07-07), so the
  // fallback was dead code; removing it cannot break decryption of existing
  // rows. If this ever throws, the ENV VAR is wrong — do NOT change the key
  // itself (rows are encrypted under it).
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  try {
    const b = Buffer.from(raw, "base64");
    if (b.length === 32) return b;
  } catch { /* fall through */ }
  throw new Error("VENDOR_DATA_ENCRYPTION_KEY must be 32 bytes (64-char hex or base64) — refusing weak/malformed key");
}

export function encryptFieldValue(plaintext) {
  if (plaintext == null) return null;
  const key = loadKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${ct.toString("hex")}`;
}

export function decryptFieldValue(stored) {
  if (!stored || typeof stored !== "string") return null;
  const [ivHex, tagHex, ctHex] = stored.split(":");
  if (!ivHex || !tagHex || !ctHex) return null;
  const key = loadKey();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const pt = Buffer.concat([decipher.update(Buffer.from(ctHex, "hex")), decipher.final()]);
  return pt.toString("utf8");
}

export function last4(plaintext) {
  if (plaintext == null) return null;
  const s = String(plaintext).replace(/\s|-/g, "");
  return s.slice(-4);
}
