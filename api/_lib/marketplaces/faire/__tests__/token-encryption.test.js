// Tests for the Faire static-API-key encryption helpers (P12c-2).
// Sets FAIRE_TOKEN_ENC_KEY to a known 64-hex-char value before the suite.
//
// Faire stores ciphertext / iv / tag in SEPARATE columns (matching the
// Shopify pattern, not the Plaid concat-in-one-bytea pattern). The
// helpers therefore return / accept a {ciphertext, iv, tag} triple
// rather than a single blob.

import { describe, it, expect, beforeAll } from "vitest";
import { encryptToken, decryptToken, selfCheck } from "../token-encryption.js";

const TEST_KEY = "a".repeat(64);

beforeAll(() => {
  process.env.FAIRE_TOKEN_ENC_KEY = TEST_KEY;
});

describe("faire token-encryption.encryptToken + decryptToken", () => {
  it("roundtrips a plain ASCII Faire API key", () => {
    const t = "faire_sk_live_1234567890abcdef";
    const triple = encryptToken(t);
    expect(Buffer.isBuffer(triple.ciphertext)).toBe(true);
    expect(Buffer.isBuffer(triple.iv)).toBe(true);
    expect(Buffer.isBuffer(triple.tag)).toBe(true);
    expect(decryptToken(triple.ciphertext, triple.iv, triple.tag)).toBe(t);
  });

  it("produces different ciphertexts for the same plaintext (random IV)", () => {
    const t = "the-same-token";
    const a = encryptToken(t);
    const b = encryptToken(t);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(decryptToken(a.ciphertext, a.iv, a.tag)).toBe(t);
    expect(decryptToken(b.ciphertext, b.iv, b.tag)).toBe(t);
  });

  it("iv is 12 bytes / tag is 16 bytes", () => {
    const { iv, tag } = encryptToken("x");
    expect(iv.length).toBe(12);
    expect(tag.length).toBe(16);
  });

  it("decrypts from PostgreSQL '\\x..' hex string format for all three columns", () => {
    const { ciphertext, iv, tag } = encryptToken("hello");
    const round = decryptToken(
      "\\x" + ciphertext.toString("hex"),
      "\\x" + iv.toString("hex"),
      "\\x" + tag.toString("hex"),
    );
    expect(round).toBe("hello");
  });

  it("decrypts from raw hex strings", () => {
    const { ciphertext, iv, tag } = encryptToken("hello");
    expect(
      decryptToken(ciphertext.toString("hex"), iv.toString("hex"), tag.toString("hex")),
    ).toBe("hello");
  });

  it("decrypts from base64 strings", () => {
    const { ciphertext, iv, tag } = encryptToken("hello");
    // Use a plaintext that decodes from base64 unambiguously (no hex collision).
    expect(
      decryptToken(
        ciphertext.toString("base64") + "==",
        iv.toString("base64") + "==",
        tag.toString("base64") + "==",
      ),
    ).toBe("hello");
  });

  it("throws on empty plaintext", () => {
    expect(() => encryptToken("")).toThrow(/non-empty/);
    expect(() => encryptToken(null)).toThrow(/non-empty/);
  });

  it("throws on tampered ciphertext", () => {
    const { ciphertext, iv, tag } = encryptToken("secret");
    ciphertext[ciphertext.length - 1] ^= 0x01;
    expect(() => decryptToken(ciphertext, iv, tag)).toThrow();
  });

  it("throws on tampered auth tag", () => {
    const { ciphertext, iv, tag } = encryptToken("secret");
    tag[0] ^= 0x01;
    expect(() => decryptToken(ciphertext, iv, tag)).toThrow();
  });

  it("throws on wrong-length iv", () => {
    const { ciphertext, tag } = encryptToken("secret");
    expect(() => decryptToken(ciphertext, Buffer.alloc(8), tag)).toThrow(/iv must be 12/);
  });

  it("throws on wrong-length tag", () => {
    const { ciphertext, iv } = encryptToken("secret");
    expect(() => decryptToken(ciphertext, iv, Buffer.alloc(8))).toThrow(/tag must be 16/);
  });

  it("throws on empty ciphertext input", () => {
    const { iv, tag } = encryptToken("secret");
    expect(() => decryptToken(Buffer.alloc(0), iv, tag)).toThrow(/empty/);
  });
});

describe("faire token-encryption.getKey validation", () => {
  it("rejects missing FAIRE_TOKEN_ENC_KEY", () => {
    const orig = process.env.FAIRE_TOKEN_ENC_KEY;
    delete process.env.FAIRE_TOKEN_ENC_KEY;
    expect(() => encryptToken("x")).toThrow(/required/);
    process.env.FAIRE_TOKEN_ENC_KEY = orig;
  });
  it("rejects non-hex key", () => {
    const orig = process.env.FAIRE_TOKEN_ENC_KEY;
    process.env.FAIRE_TOKEN_ENC_KEY = "z".repeat(64);
    expect(() => encryptToken("x")).toThrow(/hex/);
    process.env.FAIRE_TOKEN_ENC_KEY = orig;
  });
  it("rejects wrong-length key", () => {
    const orig = process.env.FAIRE_TOKEN_ENC_KEY;
    process.env.FAIRE_TOKEN_ENC_KEY = "ab".repeat(20);
    expect(() => encryptToken("x")).toThrow(/64 hex/);
    process.env.FAIRE_TOKEN_ENC_KEY = orig;
  });
});

describe("faire token-encryption.selfCheck", () => {
  it("passes the roundtrip", () => {
    const r = selfCheck();
    expect(r.ok).toBe(true);
    expect(r.ciphertext_bytes).toBeGreaterThan(0);
  });
});
