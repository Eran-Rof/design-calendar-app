// Tests for the Plaid token encryption helpers (P6-2).
// Sets PLAID_TOKEN_ENC_KEY to a known 64-hex-char value before the suite.

import { describe, it, expect, beforeAll } from "vitest";
import { encryptToken, decryptToken, selfCheck } from "../plaid/encryption.js";

const TEST_KEY = "0".repeat(64);

beforeAll(() => {
  process.env.PLAID_TOKEN_ENC_KEY = TEST_KEY;
});

describe("encryption.encryptToken + decryptToken", () => {
  it("roundtrips a plain ASCII string", () => {
    const t = "access-sandbox-12345678-abcd-1234-abcd-123456789012";
    const blob = encryptToken(t);
    expect(Buffer.isBuffer(blob)).toBe(true);
    expect(decryptToken(blob)).toBe(t);
  });

  it("produces different ciphertexts for the same plaintext (random IV)", () => {
    const t = "the-same-token";
    const a = encryptToken(t);
    const b = encryptToken(t);
    expect(a.equals(b)).toBe(false);
    expect(decryptToken(a)).toBe(t);
    expect(decryptToken(b)).toBe(t);
  });

  it("ciphertext is IV (12) + tag (16) + ciphertext-bytes (>=1)", () => {
    const blob = encryptToken("x");
    expect(blob.length).toBeGreaterThanOrEqual(12 + 16 + 1);
  });

  it("decrypts from PostgreSQL '\\x..' hex string format", () => {
    const blob = encryptToken("hello");
    const pgFormat = "\\x" + blob.toString("hex");
    expect(decryptToken(pgFormat)).toBe("hello");
  });

  it("decrypts from raw hex string", () => {
    const blob = encryptToken("hello");
    expect(decryptToken(blob.toString("hex"))).toBe("hello");
  });

  it("decrypts from base64 string", () => {
    const blob = encryptToken("hello");
    expect(decryptToken(blob.toString("base64"))).toBe("hello");
  });

  it("throws on empty plaintext", () => {
    expect(() => encryptToken("")).toThrow(/non-empty/);
    expect(() => encryptToken(null)).toThrow(/non-empty/);
  });

  it("throws on tampered ciphertext", () => {
    const blob = encryptToken("secret");
    blob[blob.length - 1] ^= 0x01;     // flip a bit
    expect(() => decryptToken(blob)).toThrow();
  });

  it("throws on too-short blob", () => {
    expect(() => decryptToken(Buffer.from("short"))).toThrow(/too short/);
  });
});

describe("encryption.getKey validation", () => {
  it("rejects missing PLAID_TOKEN_ENC_KEY", () => {
    const orig = process.env.PLAID_TOKEN_ENC_KEY;
    delete process.env.PLAID_TOKEN_ENC_KEY;
    expect(() => encryptToken("x")).toThrow(/required/);
    process.env.PLAID_TOKEN_ENC_KEY = orig;
  });
  it("rejects non-hex key", () => {
    const orig = process.env.PLAID_TOKEN_ENC_KEY;
    process.env.PLAID_TOKEN_ENC_KEY = "g".repeat(64);
    expect(() => encryptToken("x")).toThrow(/hex/);
    process.env.PLAID_TOKEN_ENC_KEY = orig;
  });
  it("rejects wrong-length key", () => {
    const orig = process.env.PLAID_TOKEN_ENC_KEY;
    process.env.PLAID_TOKEN_ENC_KEY = "ab".repeat(20);     // 40 chars
    expect(() => encryptToken("x")).toThrow(/64 hex/);
    process.env.PLAID_TOKEN_ENC_KEY = orig;
  });
});

describe("encryption.selfCheck", () => {
  it("passes the roundtrip", () => {
    const r = selfCheck();
    expect(r.ok).toBe(true);
    expect(r.ciphertext_bytes).toBeGreaterThan(0);
  });
});
