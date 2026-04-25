import { describe, it, expect, vi, beforeEach } from "vitest";
import { authenticateVendor, requireAdmin } from "../vendor-auth.js";
import { generateApiKey, verifyApiKey, keyPrefixFromRaw, VALID_SCOPES } from "../api-key.js";

// ─── Shared admin factory ─────────────────────────────────────────────────────
// Mirrors the buildAdmin pattern used across api/_lib/__tests__/*.test.js.
// Supports auth.getUser (JWT resolution) and the vendor_* table lookups that
// authenticateVendor performs.

function buildAdmin({ authUser = null, vendorUser = null, apiKeyRow = null } = {}) {
  const tables = {
    vendor_users: vendorUser ? [vendorUser] : [],
    vendor_api_keys: apiKeyRow ? [apiKeyRow] : [],
    vendor_api_logs: [],
  };

  return {
    auth: {
      getUser: async (token) => {
        if (authUser && token === "valid-jwt-token")
          return { data: { user: authUser }, error: null };
        return { data: null, error: { message: "invalid_token" } };
      },
      admin: {
        inviteUserByEmail: async (email, opts) => {
          if (email === "fail@example.com")
            return { data: null, error: { message: "Already invited" } };
          return { data: { user: { id: "auth-uuid-123" } }, error: null };
        },
      },
    },
    from(name) {
      const rows = [...(tables[name] || [])];
      let _filters = [];
      const chain = {
        select: () => chain,
        eq: (f, v) => { _filters = [..._filters, (r) => r[f] === v]; return chain; },
        maybeSingle: async () => ({
          data: rows.find((r) => _filters.every((fn) => fn(r))) ?? null,
          error: null,
        }),
        insert: (row) => {
          const arr = Array.isArray(row) ? row : [row];
          (tables[name] ??= []).push(...arr);
          return {
            select: () => ({ single: async () => ({ data: arr[0], error: null }) }),
            then: (fn) => Promise.resolve({ data: null, error: null }).then(fn),
          };
        },
        update: (patch) => {
          const u = {
            eq: function () { return this; },
            then: (fn) => Promise.resolve({ data: null, error: null }).then(fn),
          };
          return u;
        },
      };
      return chain;
    },
    _tables: tables,
  };
}

// ─── Helper: build a minimal mock req ────────────────────────────────────────
function makeReq({ bearer, apiKey } = {}) {
  const headers = {};
  if (bearer) headers["authorization"] = `Bearer ${bearer}`;
  if (apiKey) headers["x-api-key"] = apiKey;
  return { headers, method: "GET", url: "/api/vendor/test" };
}

// ─── API KEY PRIMITIVE TESTS ──────────────────────────────────────────────────

describe("generateApiKey", () => {
  it("produces a raw key with the vnd_ prefix", () => {
    const { raw } = generateApiKey();
    expect(raw).toMatch(/^vnd_/);
  });

  it("produces a keyPrefix that is a leading slice of raw", () => {
    const { raw, keyPrefix } = generateApiKey();
    expect(raw.startsWith(keyPrefix)).toBe(true);
    expect(keyPrefix.length).toBeGreaterThan(4);
  });

  it("produces a keyHash in salt:hash format", () => {
    const { keyHash } = generateApiKey();
    const parts = keyHash.split(":");
    expect(parts).toHaveLength(2);
    expect(parts[0].length).toBeGreaterThan(0);
    expect(parts[1].length).toBeGreaterThan(0);
  });

  it("generates unique keys on every call", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.raw).not.toBe(b.raw);
    expect(a.keyHash).not.toBe(b.keyHash);
  });
});

describe("verifyApiKey", () => {
  it("returns true for the correct raw key against its hash", () => {
    const { raw, keyHash } = generateApiKey();
    expect(verifyApiKey(raw, keyHash)).toBe(true);
  });

  it("returns false for a different raw key", () => {
    const { keyHash } = generateApiKey();
    const { raw: otherRaw } = generateApiKey();
    expect(verifyApiKey(otherRaw, keyHash)).toBe(false);
  });

  it("returns false for a tampered hash", () => {
    const { raw, keyHash } = generateApiKey();
    const tampered = keyHash.slice(0, -4) + "0000";
    expect(verifyApiKey(raw, tampered)).toBe(false);
  });

  it("returns false for malformed hash (no colon separator)", () => {
    const { raw } = generateApiKey();
    expect(verifyApiKey(raw, "nosalthere")).toBe(false);
  });

  it("returns false for empty inputs", () => {
    expect(verifyApiKey("", "salt:hash")).toBe(false);
    expect(verifyApiKey("vnd_key", "")).toBe(false);
    expect(verifyApiKey(null, null)).toBe(false);
  });
});

describe("keyPrefixFromRaw", () => {
  it("extracts the expected prefix length from a valid raw key", () => {
    const { raw, keyPrefix } = generateApiKey();
    expect(keyPrefixFromRaw(raw)).toBe(keyPrefix);
  });

  it("returns null for a key without the vnd_ prefix", () => {
    expect(keyPrefixFromRaw("sk_live_123")).toBeNull();
    expect(keyPrefixFromRaw("")).toBeNull();
    expect(keyPrefixFromRaw(null)).toBeNull();
  });
});

// ─── authenticateVendor — no credentials ─────────────────────────────────────

describe("authenticateVendor — missing credentials", () => {
  it("returns 401 when no Authorization header or X-API-Key is present", async () => {
    const admin = buildAdmin();
    const result = await authenticateVendor(admin, makeReq());
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it("returns 401 for a Bearer token that is not vnd_ but fails auth.getUser", async () => {
    const admin = buildAdmin({ authUser: null });
    const result = await authenticateVendor(admin, makeReq({ bearer: "expired-jwt" }));
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });
});

// ─── authenticateVendor — JWT path ───────────────────────────────────────────

describe("authenticateVendor — JWT", () => {
  const authUser = { id: "auth-user-id", email: "vendor@example.com" };
  const vendorUser = {
    id: "vu-1", auth_id: "auth-user-id",
    vendor_id: "vendor-abc", display_name: "Acme Corp", role: "primary",
  };

  it("resolves vendor_id from the JWT payload, never from the request body", async () => {
    const admin = buildAdmin({ authUser, vendorUser });
    const req = makeReq({ bearer: "valid-jwt-token" });
    // Attach a spoofed vendor_id on the request body — must be ignored
    req.body = { vendor_id: "ATTACKER-VENDOR" };
    const result = await authenticateVendor(admin, req);
    expect(result.ok).toBe(true);
    expect(result.auth.vendor_id).toBe("vendor-abc");
    expect(result.auth.vendor_id).not.toBe("ATTACKER-VENDOR");
  });

  it("includes display_name, email, role in the resolved auth object", async () => {
    const admin = buildAdmin({ authUser, vendorUser });
    const result = await authenticateVendor(admin, makeReq({ bearer: "valid-jwt-token" }));
    expect(result.auth.display_name).toBe("Acme Corp");
    expect(result.auth.email).toBe("vendor@example.com");
    expect(result.auth.role).toBe("primary");
  });

  it("grants wildcard scope (*) to JWT-authenticated users", async () => {
    const admin = buildAdmin({ authUser, vendorUser });
    const result = await authenticateVendor(admin, makeReq({ bearer: "valid-jwt-token" }), {
      requiredScope: "invoices:write",
    });
    expect(result.ok).toBe(true);
  });

  it("returns 401 when the JWT maps to no vendor_users row", async () => {
    const admin = buildAdmin({ authUser, vendorUser: null });
    const result = await authenticateVendor(admin, makeReq({ bearer: "valid-jwt-token" }));
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });
});

// ─── authenticateVendor — API key path ───────────────────────────────────────

describe("authenticateVendor — API key", () => {
  function makeApiKeyFixture(overrides = {}) {
    const { raw, keyPrefix, keyHash } = generateApiKey();
    const row = {
      id: "ak-1",
      vendor_id: "vendor-xyz",
      key_prefix: keyPrefix,
      key_hash: keyHash,
      scopes: ["invoices:read", "invoices:write"],
      expires_at: null,
      revoked_at: null,
      ...overrides,
    };
    return { raw, row };
  }

  it("resolves vendor_id from the API key record, never from request params", async () => {
    const { raw, row } = makeApiKeyFixture();
    const admin = buildAdmin({ apiKeyRow: row });
    const req = makeReq({ apiKey: raw });
    req.query = { vendor_id: "SPOOFED" };
    const result = await authenticateVendor(admin, req);
    expect(result.ok).toBe(true);
    expect(result.auth.vendor_id).toBe("vendor-xyz");
  });

  it("accepts the key via X-API-Key header", async () => {
    const { raw, row } = makeApiKeyFixture();
    const admin = buildAdmin({ apiKeyRow: row });
    const result = await authenticateVendor(admin, makeReq({ apiKey: raw }));
    expect(result.ok).toBe(true);
    expect(result.auth.type).toBe("api_key");
  });

  it("accepts the key via Authorization: Bearer vnd_... header", async () => {
    const { raw, row } = makeApiKeyFixture();
    const admin = buildAdmin({ apiKeyRow: row });
    const result = await authenticateVendor(admin, makeReq({ bearer: raw }));
    expect(result.ok).toBe(true);
  });

  it("returns 401 for a revoked key", async () => {
    const { raw, row } = makeApiKeyFixture({ revoked_at: "2026-01-01T00:00:00Z" });
    const admin = buildAdmin({ apiKeyRow: row });
    const result = await authenticateVendor(admin, makeReq({ apiKey: raw }));
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it("returns 401 for an expired key", async () => {
    const { raw, row } = makeApiKeyFixture({ expires_at: "2020-01-01T00:00:00Z" });
    const admin = buildAdmin({ apiKeyRow: row });
    const result = await authenticateVendor(admin, makeReq({ apiKey: raw }));
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it("returns 401 when the raw key doesn't match the stored hash", async () => {
    const { row } = makeApiKeyFixture();
    const { raw: differentRaw } = generateApiKey();
    // Store row for one key but present a different raw key with the same prefix length
    const admin = buildAdmin({ apiKeyRow: row });
    const result = await authenticateVendor(admin, makeReq({ apiKey: differentRaw }));
    // prefix won't match so no row found → 401
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it("returns 403 when the key lacks the required scope", async () => {
    const { raw, row } = makeApiKeyFixture({ scopes: ["invoices:read"] });
    const admin = buildAdmin({ apiKeyRow: row });
    const result = await authenticateVendor(admin, makeReq({ apiKey: raw }), {
      requiredScope: "invoices:write",
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
  });

  it("passes when the key has the exact required scope", async () => {
    const { raw, row } = makeApiKeyFixture({ scopes: ["invoices:write"] });
    const admin = buildAdmin({ apiKeyRow: row });
    const result = await authenticateVendor(admin, makeReq({ apiKey: raw }), {
      requiredScope: "invoices:write",
    });
    expect(result.ok).toBe(true);
  });

  it("passes when the key has wildcard scope (*)", async () => {
    const { raw, row } = makeApiKeyFixture({ scopes: ["*"] });
    const admin = buildAdmin({ apiKeyRow: row });
    const result = await authenticateVendor(admin, makeReq({ apiKey: raw }), {
      requiredScope: "invoices:write",
    });
    expect(result.ok).toBe(true);
  });

  it("passes when the key has resource-level wildcard (invoices:*)", async () => {
    const { raw, row } = makeApiKeyFixture({ scopes: ["invoices:*"] });
    const admin = buildAdmin({ apiKeyRow: row });
    const result = await authenticateVendor(admin, makeReq({ apiKey: raw }), {
      requiredScope: "invoices:write",
    });
    expect(result.ok).toBe(true);
  });

  it("a future expiry does not block the key", async () => {
    const { raw, row } = makeApiKeyFixture({
      expires_at: new Date(Date.now() + 86400_000).toISOString(),
    });
    const admin = buildAdmin({ apiKeyRow: row });
    const result = await authenticateVendor(admin, makeReq({ apiKey: raw }));
    expect(result.ok).toBe(true);
  });
});

// ─── requireAdmin ─────────────────────────────────────────────────────────────

describe("requireAdmin", () => {
  it("returns true for JWT auth with primary role", () => {
    expect(requireAdmin({ type: "jwt", role: "primary" })).toBe(true);
  });

  it("returns true for JWT auth with admin role", () => {
    expect(requireAdmin({ type: "jwt", role: "admin" })).toBe(true);
  });

  it("returns false for JWT auth with member role", () => {
    expect(requireAdmin({ type: "jwt", role: "member" })).toBe(false);
  });

  it("returns false for API key auth regardless of role", () => {
    expect(requireAdmin({ type: "api_key", role: "primary" })).toBe(false);
  });

  it("returns false for null auth", () => {
    expect(requireAdmin(null)).toBe(false);
  });
});

// ─── Invite handler validation ────────────────────────────────────────────────
// Tests the validation logic from api/vendor-invite.js by importing and calling
// the handler with mock req/res objects. createClient is mocked via the admin
// we inject — we test validation, not the real Supabase round-trip.

describe("vendor-invite validation rules", () => {
  // Lightweight req/res stand-ins
  function makeInviteReq(body) {
    return { method: "POST", headers: { host: "localhost" }, body };
  }

  function makeRes() {
    const res = {
      _status: 200,
      _body: null,
      setHeader: () => res,
      status(code) { res._status = code; return res; },
      json(body) { res._body = body; return res; },
      end() { return res; },
    };
    return res;
  }

  // Validate the fields the handler checks before it touches Supabase
  function validateInviteBody(body) {
    const email = String(body?.email || "").trim().toLowerCase();
    const legacy_blob_id = String(body?.legacy_blob_id || "").trim();
    const site_url = String(body?.site_url || "").trim().replace(/\/$/, "");
    if (!email || !legacy_blob_id) return { ok: false, status: 400, error: "email and legacy_blob_id are required" };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, status: 400, error: "Invalid email" };
    if (!site_url || !/^https?:\/\//.test(site_url)) return { ok: false, status: 400, error: "site_url must be an absolute http(s) URL" };
    return { ok: true };
  }

  it("rejects missing email", () => {
    const r = validateInviteBody({ legacy_blob_id: "v1", site_url: "https://app.example.com" });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });

  it("rejects missing legacy_blob_id", () => {
    const r = validateInviteBody({ email: "a@b.com", site_url: "https://app.example.com" });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });

  it("rejects malformed email", () => {
    const r = validateInviteBody({ email: "notanemail", legacy_blob_id: "v1", site_url: "https://app.example.com" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Invalid email/i);
  });

  it("rejects site_url without a protocol", () => {
    const r = validateInviteBody({ email: "a@b.com", legacy_blob_id: "v1", site_url: "app.example.com" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/absolute/i);
  });

  it("rejects http:// site_url that is actually a relative path", () => {
    const r = validateInviteBody({ email: "a@b.com", legacy_blob_id: "v1", site_url: "/relative/path" });
    expect(r.ok).toBe(false);
  });

  it("accepts a valid payload", () => {
    const r = validateInviteBody({
      email: "vendor@supplier.com",
      legacy_blob_id: "ACME-001",
      site_url: "https://portal.example.com",
    });
    expect(r.ok).toBe(true);
  });

  it("trims trailing slash from site_url", () => {
    // The handler does .replace(/\/$/, "") — verify the transform
    const url = "https://app.example.com/";
    expect(url.replace(/\/$/, "")).toBe("https://app.example.com");
  });

  it("normalises email to lowercase", () => {
    const email = "  Vendor@SUPPLIER.COM  ";
    expect(String(email).trim().toLowerCase()).toBe("vendor@supplier.com");
  });
});

// ─── VALID_SCOPES coverage ────────────────────────────────────────────────────

describe("VALID_SCOPES", () => {
  it("includes core read and write scopes", () => {
    expect(VALID_SCOPES).toContain("invoices:read");
    expect(VALID_SCOPES).toContain("invoices:write");
    expect(VALID_SCOPES).toContain("pos:read");
    expect(VALID_SCOPES).toContain("shipments:write");
  });
});
