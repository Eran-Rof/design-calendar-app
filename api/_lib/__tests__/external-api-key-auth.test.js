// Tests for the external/partner API key auth helper
// (api/_lib/external/apiKeyAuth.js). Locks the generate -> hash -> verify
// contract and the prefix-lookup authentication path so a regression can't
// silently let an unauthenticated / inactive key through.

import { describe, it, expect } from "vitest";
import {
  generateApiKey,
  hashKey,
  verifyKey,
  keyPrefixFromRaw,
  bearerToken,
  authenticateApiKey,
  KEY_PREFIX_TAG,
} from "../external/apiKeyAuth.js";

describe("generateApiKey", () => {
  it("mints a prefix.secret key with a stored sha-256 hash", () => {
    const { raw, keyPrefix, keyHash } = generateApiKey();
    expect(raw.startsWith(KEY_PREFIX_TAG)).toBe(true);
    expect(raw).toContain(".");
    expect(keyPrefix).toBe(raw.split(".")[0]);
    expect(keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(keyHash).toBe(hashKey(raw));
  });

  it("produces unique keys and prefixes", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.raw).not.toBe(b.raw);
    expect(a.keyPrefix).not.toBe(b.keyPrefix);
    expect(a.keyHash).not.toBe(b.keyHash);
  });
});

describe("verifyKey", () => {
  it("accepts the correct raw key and rejects the wrong one", () => {
    const { raw, keyHash } = generateApiKey();
    expect(verifyKey(raw, keyHash)).toBe(true);
    expect(verifyKey(raw + "x", keyHash)).toBe(false);
    expect(verifyKey("rofk_zzzz.nope", keyHash)).toBe(false);
  });

  it("is safe on malformed inputs", () => {
    expect(verifyKey("", "abc")).toBe(false);
    expect(verifyKey("x", "")).toBe(false);
    expect(verifyKey("x", "not-hex-!!")).toBe(false);
    expect(verifyKey(null, null)).toBe(false);
  });
});

describe("keyPrefixFromRaw / bearerToken", () => {
  it("extracts the public prefix", () => {
    const { raw, keyPrefix } = generateApiKey();
    expect(keyPrefixFromRaw(raw)).toBe(keyPrefix);
    expect(keyPrefixFromRaw("noprefix.secret")).toBe(null);
    expect(keyPrefixFromRaw("rofk_only-no-dot")).toBe(null);
    expect(keyPrefixFromRaw(null)).toBe(null);
  });

  it("parses the Bearer header case-insensitively", () => {
    expect(bearerToken({ headers: { authorization: "Bearer abc.def" } })).toBe("abc.def");
    expect(bearerToken({ headers: { authorization: "bearer  abc.def " } })).toBe("abc.def");
    expect(bearerToken({ headers: {} })).toBe(null);
    expect(bearerToken({ headers: { authorization: "Basic xxx" } })).toBe(null);
  });
});

// Minimal fake service-role client that backs a single external_api_keys row.
function fakeAdmin(row) {
  return {
    from(table) {
      expect(table).toBe("external_api_keys");
      const q = {
        _eqPrefix: null,
        select() { return q; },
        eq(col, val) { if (col === "key_prefix") q._eqPrefix = val; return q; },
        async maybeSingle() {
          if (!row || q._eqPrefix !== row.key_prefix) return { data: null, error: null };
          return { data: row, error: null };
        },
        update() { return { eq: () => Promise.resolve({}) }; },
      };
      return q;
    },
  };
}

describe("authenticateApiKey", () => {
  it("returns entity + scopes for a valid active key", async () => {
    const { raw, keyPrefix, keyHash } = generateApiKey();
    const admin = fakeAdmin({
      id: "key-1", entity_id: "ent-1", key_prefix: keyPrefix,
      key_hash: keyHash, scopes: ["read"], is_active: true,
    });
    const out = await authenticateApiKey(admin, { headers: { authorization: `Bearer ${raw}` } });
    expect(out).toEqual({ entity_id: "ent-1", scopes: ["read"], key_id: "key-1" });
  });

  it("rejects a missing header", async () => {
    const out = await authenticateApiKey(fakeAdmin(null), { headers: {} });
    expect(out).toBe(null);
  });

  it("rejects an inactive key", async () => {
    const { raw, keyPrefix, keyHash } = generateApiKey();
    const admin = fakeAdmin({
      id: "key-1", entity_id: "ent-1", key_prefix: keyPrefix,
      key_hash: keyHash, scopes: ["read"], is_active: false,
    });
    const out = await authenticateApiKey(admin, { headers: { authorization: `Bearer ${raw}` } });
    expect(out).toBe(null);
  });

  it("rejects a forged secret with a known prefix", async () => {
    const { keyPrefix, keyHash } = generateApiKey();
    const admin = fakeAdmin({
      id: "key-1", entity_id: "ent-1", key_prefix: keyPrefix,
      key_hash: keyHash, scopes: ["read"], is_active: true,
    });
    const forged = `${keyPrefix}.totally-wrong-secret`;
    const out = await authenticateApiKey(admin, { headers: { authorization: `Bearer ${forged}` } });
    expect(out).toBe(null);
  });
});
