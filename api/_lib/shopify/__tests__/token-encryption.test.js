// Tests for Tangerine P11-2 Shopify token-encryption.js — real AES-256-GCM.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { encryptToken, decryptToken, selfCheck } from "../token-encryption.js";

const VALID_KEY = "0".repeat(64); // 32 bytes of zeros (hex)
const ALT_KEY   = "f".repeat(64); // different key, same length

describe("shopify token-encryption", () => {
  let savedKey;

  beforeEach(() => {
    savedKey = process.env.SHOPIFY_TOKEN_ENC_KEY;
    process.env.SHOPIFY_TOKEN_ENC_KEY = VALID_KEY;
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.SHOPIFY_TOKEN_ENC_KEY;
    else process.env.SHOPIFY_TOKEN_ENC_KEY = savedKey;
  });

  it("round-trips a typical Shopify access token", () => {
    // Synthetic ID — intentionally not the live Shopify token prefix
    // to avoid tripping GH secret scanning.
    const sample = "testtoken-roundtrip-1234567890abcdef";
    const { ciphertext, iv, tag } = encryptToken(sample);
    expect(Buffer.isBuffer(ciphertext)).toBe(true);
    expect(Buffer.isBuffer(iv)).toBe(true);
    expect(Buffer.isBuffer(tag)).toBe(true);
    expect(iv.length).toBe(12);
    expect(tag.length).toBe(16);
    expect(decryptToken(ciphertext, iv, tag)).toBe(sample);
  });

  it("round-trips a webhook secret with special characters", () => {
    const secret = "abc!@#$%^&*()_+-=[]{}|;':\",./<>?\nmulti\nline";
    const { ciphertext, iv, tag } = encryptToken(secret);
    expect(decryptToken(ciphertext, iv, tag)).toBe(secret);
  });

  it("round-trips unicode plaintext", () => {
    const sample = "secrét-with-emoji-rocket";
    const { ciphertext, iv, tag } = encryptToken(sample);
    expect(decryptToken(ciphertext, iv, tag)).toBe(sample);
  });

  it("produces a different IV (and thus ciphertext) each call", () => {
    const sample = "testtoken_aaa";
    const a = encryptToken(sample);
    const b = encryptToken(sample);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    // Both still round-trip
    expect(decryptToken(a.ciphertext, a.iv, a.tag)).toBe(sample);
    expect(decryptToken(b.ciphertext, b.iv, b.tag)).toBe(sample);
  });

  it("empty plaintext returns all-null triple (nullable column shape)", () => {
    expect(encryptToken("")).toEqual({ ciphertext: null, iv: null, tag: null });
    expect(encryptToken(null)).toEqual({ ciphertext: null, iv: null, tag: null });
    expect(encryptToken(undefined)).toEqual({ ciphertext: null, iv: null, tag: null });
  });

  it("rejects non-string plaintext", () => {
    expect(() => encryptToken(123)).toThrow(/string/i);
    expect(() => encryptToken({})).toThrow(/string/i);
  });

  it("throws when SHOPIFY_TOKEN_ENC_KEY is missing", () => {
    delete process.env.SHOPIFY_TOKEN_ENC_KEY;
    expect(() => encryptToken("testtoken_x")).toThrow(/SHOPIFY_TOKEN_ENC_KEY/);
  });

  it("throws when key is wrong length (< 64 hex chars)", () => {
    process.env.SHOPIFY_TOKEN_ENC_KEY = "deadbeef";
    expect(() => encryptToken("testtoken_x")).toThrow(/64 hex/);
  });

  it("throws when key is not hex", () => {
    process.env.SHOPIFY_TOKEN_ENC_KEY = "z".repeat(64);
    expect(() => encryptToken("testtoken_x")).toThrow(/64 hex/);
  });

  it("decryption with wrong key fails (auth tag mismatch)", () => {
    const sample = "testtoken_xxx";
    const { ciphertext, iv, tag } = encryptToken(sample);
    process.env.SHOPIFY_TOKEN_ENC_KEY = ALT_KEY;
    expect(() => decryptToken(ciphertext, iv, tag)).toThrow();
  });

  it("decryption rejects null inputs", () => {
    expect(() => decryptToken(null, Buffer.alloc(12), Buffer.alloc(16))).toThrow(/required/);
    expect(() => decryptToken(Buffer.alloc(8), null, Buffer.alloc(16))).toThrow(/required/);
    expect(() => decryptToken(Buffer.alloc(8), Buffer.alloc(12), null)).toThrow(/required/);
  });

  it("decryption rejects wrong-size IV/tag", () => {
    const { ciphertext, iv, tag } = encryptToken("testtoken_a");
    expect(() => decryptToken(ciphertext, Buffer.alloc(11), tag)).toThrow(/iv must be 12/);
    expect(() => decryptToken(ciphertext, iv, Buffer.alloc(15))).toThrow(/tag must be 16/);
  });

  it("decryption accepts PostgREST hex string format ('\\\\x…')", () => {
    const sample = "testtoken_hex";
    const { ciphertext, iv, tag } = encryptToken(sample);
    const ctHex = "\\x" + ciphertext.toString("hex");
    const ivHex = "\\x" + iv.toString("hex");
    const tagHex = "\\x" + tag.toString("hex");
    expect(decryptToken(ctHex, ivHex, tagHex)).toBe(sample);
  });

  it("selfCheck succeeds with a valid key", () => {
    const r = selfCheck();
    expect(r.ok).toBe(true);
    expect(r.ciphertext_bytes).toBeGreaterThan(0);
  });
});
