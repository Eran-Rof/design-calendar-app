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
  // Accept hex (64 chars) or base64 (44 chars incl padding). Anything else → 32-byte scrypt-derived.
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  try {
    const b = Buffer.from(raw, "base64");
    if (b.length === 32) return b;
  } catch { /* fall through */ }
  // Fallback: derive a 32-byte key from arbitrary passphrase.
  return crypto.scryptSync(raw, "vendor_portal_salt_v1", 32);
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
