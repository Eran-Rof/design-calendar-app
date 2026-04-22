import { describe, it, expect, beforeEach } from "vitest";
import { encryptBytes, decryptBytes, revealStillValid, maskCard, issueCardWithProvider } from "../virtual-card.js";

beforeEach(() => {
  // 32-byte key as hex
  process.env.VENDOR_DATA_ENCRYPTION_KEY = "a".repeat(64);
});

describe("encryptBytes / decryptBytes", () => {
  it("round-trips plaintext through AES-256-GCM", () => {
    const pan = "4242424242424242";
    const ct = encryptBytes(pan);
    expect(Buffer.isBuffer(ct)).toBe(true);
    expect(ct.length).toBeGreaterThan(28); // IV(12) + tag(16) + payload
    expect(decryptBytes(ct)).toBe(pan);
  });
  it("produces different ciphertext for the same plaintext (fresh IV)", () => {
    const a = encryptBytes("same");
    const b = encryptBytes("same");
    expect(a.equals(b)).toBe(false); // IVs differ
    expect(decryptBytes(a)).toBe("same");
    expect(decryptBytes(b)).toBe("same");
  });
  it("returns null for null input", () => {
    expect(encryptBytes(null)).toBe(null);
    expect(decryptBytes(null)).toBe(null);
  });
  it("throws on tampered ciphertext (GCM auth tag)", () => {
    const ct = encryptBytes("secret");
    ct[ct.length - 1] ^= 0xff; // flip a byte in the payload
    expect(() => decryptBytes(ct)).toThrow();
  });
});

describe("revealStillValid", () => {
  const issued = "2026-04-19T00:00:00Z";
  it("returns true within 24h window", () => {
    expect(revealStillValid(issued, new Date("2026-04-19T12:00:00Z"))).toBe(true);
    expect(revealStillValid(issued, new Date("2026-04-19T23:59:00Z"))).toBe(true);
  });
  it("returns false past 24h", () => {
    expect(revealStillValid(issued, new Date("2026-04-20T01:00:00Z"))).toBe(false);
  });
  it("returns false for null / missing issued_at", () => {
    expect(revealStillValid(null)).toBe(false);
  });
});

describe("maskCard", () => {
  it("returns only the safe fields (no encrypted PAN/CVV in response)", () => {
    const row = {
      id: "c1", entity_id: "e1", invoice_id: "i1", vendor_id: "v1",
      card_number_last4: "4242", card_number_encrypted: Buffer.from("secret-bytes"),
      cvv_encrypted: Buffer.from("cvv-bytes"),
      expiry_month: 6, expiry_year: 2028,
      credit_limit: 1000, amount_authorized: 0, amount_spent: 0,
      status: "active", provider: "stripe",
      issued_at: "2026-04-19T00:00:00Z", expires_at: "2028-06-30T00:00:00Z",
      spent_at: null,
    };
    const masked = maskCard(row);
    expect(masked).not.toHaveProperty("card_number_encrypted");
    expect(masked).not.toHaveProperty("cvv_encrypted");
    expect(masked.card_number_last4).toBe("4242");
    expect(masked.provider).toBe("stripe");
  });
  it("returns null for null input", () => {
    expect(maskCard(null)).toBe(null);
  });
});

describe("issueCardWithProvider (stub)", () => {
  it("produces a Luhn-valid 16-digit PAN starting with 4242", async () => {
    const card = await issueCardWithProvider({ provider: "stripe", credit_limit: 1000 });
    expect(card.card_number).toMatch(/^4242\d{12}$/);
    // Luhn check
    const digits = card.card_number.split("").map(Number);
    let sum = 0;
    for (let i = 0; i < 16; i++) {
      let d = digits[15 - i];
      if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
      sum += d;
    }
    expect(sum % 10).toBe(0);
    expect(card.card_number_last4).toBe(card.card_number.slice(-4));
    expect(card.cvv).toMatch(/^\d{3}$/);
    expect(card.expiry_month).toBeGreaterThanOrEqual(1);
    expect(card.expiry_month).toBeLessThanOrEqual(12);
    expect(card.credit_limit).toBe(1000);
  });
});
