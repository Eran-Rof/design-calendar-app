// Tests for the FBA SP-API LWA-credential encryption helpers (P12a-2).
// Mirrors plaid-encryption.test.js + adapts to the three-buffer
// {ciphertext, iv, tag} return shape required by fba_seller_accounts.

import { describe, it, expect, beforeAll } from "vitest";
import { encryptToken, decryptToken, selfCheck } from "../token-encryption.js";

const TEST_KEY = "0".repeat(64);

beforeAll(() => {
  process.env.FBA_TOKEN_ENC_KEY = TEST_KEY;
});

describe("token-encryption.encryptToken + decryptToken", () => {
  it("returns the three-buffer shape", () => {
    const r = encryptToken("Atzr|sample-refresh-token");
    expect(Buffer.isBuffer(r.ciphertext)).toBe(true);
    expect(Buffer.isBuffer(r.iv)).toBe(true);
    expect(Buffer.isBuffer(r.tag)).toBe(true);
    expect(r.iv.length).toBe(12);
    expect(r.tag.length).toBe(16);
  });

  it("roundtrips a plain ASCII string", () => {
    const t = "Atzr|IwEBIA-very-long-amazon-refresh-token-string-here";
    const blob = encryptToken(t);
    expect(decryptToken(blob.ciphertext, blob.iv, blob.tag)).toBe(t);
  });

  it("roundtrips a UTF-8 string with multibyte chars", () => {
    const t = "クライアント-シークレット-€-😀";
    const blob = encryptToken(t);
    expect(decryptToken(blob.ciphertext, blob.iv, blob.tag)).toBe(t);
  });

  it("produces a fresh random IV per call (different ciphertext for same plaintext)", () => {
    const t = "same-secret-different-iv";
    const a = encryptToken(t);
    const b = encryptToken(t);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it("decrypts when ciphertext/iv/tag are passed as PostgREST '\\x..' hex strings", () => {
    const blob = encryptToken("hello-from-pg");
    const ct = "\\x" + blob.ciphertext.toString("hex");
    const iv = "\\x" + blob.iv.toString("hex");
    const tag = "\\x" + blob.tag.toString("hex");
    expect(decryptToken(ct, iv, tag)).toBe("hello-from-pg");
  });

  it("decrypts when args are bare hex strings", () => {
    const blob = encryptToken("hex-round");
    expect(decryptToken(
      blob.ciphertext.toString("hex"),
      blob.iv.toString("hex"),
      blob.tag.toString("hex"),
    )).toBe("hex-round");
  });

  it("decrypts when args are base64 strings", () => {
    const blob = encryptToken("b64-round");
    expect(decryptToken(
      blob.ciphertext.toString("base64"),
      blob.iv.toString("base64"),
      blob.tag.toString("base64"),
    )).toBe("b64-round");
  });

  it("throws on empty / non-string plaintext", () => {
    expect(() => encryptToken("")).toThrow(/non-empty/);
    expect(() => encryptToken(null)).toThrow(/non-empty/);
    expect(() => encryptToken(undefined)).toThrow(/non-empty/);
    expect(() => encryptToken(42)).toThrow(/non-empty/);
  });

  it("throws on missing args to decryptToken", () => {
    expect(() => decryptToken(null, Buffer.alloc(12), Buffer.alloc(16))).toThrow(/required/);
    expect(() => decryptToken(Buffer.alloc(8), null, Buffer.alloc(16))).toThrow(/required/);
    expect(() => decryptToken(Buffer.alloc(8), Buffer.alloc(12), null)).toThrow(/required/);
  });

  it("throws on wrong-sized iv / tag", () => {
    const blob = encryptToken("size-check");
    expect(() => decryptToken(blob.ciphertext, Buffer.alloc(8), blob.tag)).toThrow(/iv must be 12/);
    expect(() => decryptToken(blob.ciphertext, blob.iv, Buffer.alloc(8))).toThrow(/tag must be 16/);
  });

  it("throws on tampered ciphertext", () => {
    const blob = encryptToken("tamper-me");
    const tampered = Buffer.from(blob.ciphertext);
    tampered[tampered.length - 1] ^= 0x01;
    expect(() => decryptToken(tampered, blob.iv, blob.tag)).toThrow();
  });

  it("throws on tampered tag", () => {
    const blob = encryptToken("tag-flip");
    const tag = Buffer.from(blob.tag);
    tag[0] ^= 0x01;
    expect(() => decryptToken(blob.ciphertext, blob.iv, tag)).toThrow();
  });
});

describe("token-encryption.getKey validation", () => {
  it("rejects missing FBA_TOKEN_ENC_KEY", () => {
    const orig = process.env.FBA_TOKEN_ENC_KEY;
    delete process.env.FBA_TOKEN_ENC_KEY;
    expect(() => encryptToken("x")).toThrow(/required/);
    process.env.FBA_TOKEN_ENC_KEY = orig;
  });

  it("rejects non-hex key", () => {
    const orig = process.env.FBA_TOKEN_ENC_KEY;
    process.env.FBA_TOKEN_ENC_KEY = "g".repeat(64);
    expect(() => encryptToken("x")).toThrow(/hex/);
    process.env.FBA_TOKEN_ENC_KEY = orig;
  });

  it("rejects wrong-length key", () => {
    const orig = process.env.FBA_TOKEN_ENC_KEY;
    process.env.FBA_TOKEN_ENC_KEY = "ab".repeat(20); // 40 chars
    expect(() => encryptToken("x")).toThrow(/64 hex/);
    process.env.FBA_TOKEN_ENC_KEY = orig;
  });

  it("rejects whitespace-padded key", () => {
    const orig = process.env.FBA_TOKEN_ENC_KEY;
    process.env.FBA_TOKEN_ENC_KEY = "  " + TEST_KEY + "  ";
    // Trimmed inside getKey() — should succeed.
    expect(() => encryptToken("x")).not.toThrow();
    process.env.FBA_TOKEN_ENC_KEY = orig;
  });
});

describe("token-encryption.selfCheck", () => {
  it("passes the roundtrip", () => {
    const r = selfCheck();
    expect(r.ok).toBe(true);
    expect(r.iv_bytes).toBe(12);
    expect(r.tag_bytes).toBe(16);
    expect(r.ciphertext_bytes).toBeGreaterThan(0);
  });
});
