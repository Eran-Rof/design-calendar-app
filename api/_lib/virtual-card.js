// api/_lib/virtual-card.js
//
// Virtual-card helpers: provider-stub issuance + AES-256-GCM encryption for
// PAN/CVV bytes. The DB columns are `bytea` (api/_lib/crypto.js stores text
// for the banking flow; here we need the raw Buffer form to match the schema).
//
// Provider abstraction: this file's `issueCardWithProvider()` returns a
// plaintext card object. Real Stripe/Marqeta plumbing hooks in via
// switch(provider) and the env vars documented in each branch. The stub
// generates a Luhn-valid test PAN so QA flows work end to end.
//
// IMPORTANT: plaintext PAN/CVV never leave this module except inside the
// one-time reveal window (24h after issuance) enforced by callers.

import crypto from "node:crypto";

const MS_24H = 24 * 60 * 60 * 1000;

function loadKey() {
  const raw = process.env.VENDOR_DATA_ENCRYPTION_KEY;
  if (!raw) throw new Error("VENDOR_DATA_ENCRYPTION_KEY is not set");
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  try {
    const b = Buffer.from(raw, "base64");
    if (b.length === 32) return b;
  } catch { /* fall through */ }
  return crypto.scryptSync(raw, "vendor_portal_salt_v1", 32);
}

// Encrypt → Buffer suitable for a bytea column.
// Layout inside the buffer: [12-byte IV][16-byte auth tag][ciphertext...]
export function encryptBytes(plaintext) {
  if (plaintext == null) return null;
  const key = loadKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

export function decryptBytes(stored) {
  if (stored == null) return null;
  const key = loadKey();
  const buf = Buffer.isBuffer(stored) ? stored : Buffer.from(stored, "hex");
  if (buf.length < 28) throw new Error("ciphertext too short");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct  = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

// ──────────────────────────────────────────────────────────────────────────
// Luhn-valid test PAN generator (for the stub provider)
// ──────────────────────────────────────────────────────────────────────────

function luhnCheckDigit(digitsWithoutCheck) {
  let sum = 0;
  for (let i = 0; i < digitsWithoutCheck.length; i++) {
    let d = Number(digitsWithoutCheck[digitsWithoutCheck.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}

function randomTestPan() {
  // 4242 prefix (Stripe test pattern), 15 random digits, Luhn check digit
  const prefix = "4242";
  let body = "";
  for (let i = 0; i < 11; i++) body += Math.floor(Math.random() * 10);
  const base = prefix + body;
  return base + luhnCheckDigit(base);
}

function randomCvv() {
  return String(Math.floor(Math.random() * 900) + 100);
}

function expiryTwoYearsOut(now = new Date()) {
  const year = now.getUTCFullYear() + 2;
  const month = now.getUTCMonth() + 1;
  return { expiry_month: month, expiry_year: year };
}

// Stub provider: produces a deterministic-ish card for testing.
// Real integrations replace this function body.
export async function issueCardWithProvider({ provider, credit_limit, metadata = {} }) {
  const pan = randomTestPan();
  const cvv = randomCvv();
  const exp = expiryTwoYearsOut();
  return {
    card_number: pan,
    card_number_last4: pan.slice(-4),
    cvv,
    expiry_month: exp.expiry_month,
    expiry_year: exp.expiry_year,
    credit_limit,
    provider,
    provider_card_id: `stub_${crypto.randomBytes(8).toString("hex")}`,
    metadata,
  };
}

// Optional cancel call — real providers hit their API; stub is a no-op.
export async function cancelCardWithProvider({ provider, provider_card_id }) {
  return { ok: true, provider, provider_card_id };
}

// Reveal window: 24 hours from issuance. After that, callers must treat
// the card as masked (last4 only).
export function revealStillValid(issued_at, now = new Date()) {
  if (!issued_at) return false;
  const age = now.getTime() - new Date(issued_at).getTime();
  return age >= 0 && age <= MS_24H;
}

// Derive a redacted view of a card row for clients.
export function maskCard(row) {
  if (!row) return null;
  return {
    id: row.id,
    entity_id: row.entity_id,
    invoice_id: row.invoice_id,
    vendor_id: row.vendor_id,
    card_number_last4: row.card_number_last4,
    expiry_month: row.expiry_month,
    expiry_year: row.expiry_year,
    credit_limit: row.credit_limit,
    amount_authorized: row.amount_authorized,
    amount_spent: row.amount_spent,
    status: row.status,
    provider: row.provider,
    issued_at: row.issued_at,
    expires_at: row.expires_at,
    spent_at: row.spent_at,
  };
}
