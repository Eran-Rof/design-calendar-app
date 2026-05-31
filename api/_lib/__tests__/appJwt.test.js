// Tests for the P14 per-user JWT primitive (api/_lib/auth/appJwt.js).
// HMAC-SHA256 sign + local verify, gated entirely on SUPABASE_JWT_SECRET.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { signAppJwt, verifyAppJwt, isAppJwtEnabled } from "../auth/appJwt.js";

const SECRET = "test-jwt-secret-aaaaaaaaaaaaaaaaaaaaaaaa";
const UID = "11111111-1111-1111-1111-111111111111";

describe("appJwt — disabled (no secret)", () => {
  beforeEach(() => { delete process.env.TANGERINE_JWT_SECRET; delete process.env.SUPABASE_JWT_SECRET; });
  it("isAppJwtEnabled is false", () => expect(isAppJwtEnabled()).toBe(false));
  it("signAppJwt returns null", () => expect(signAppJwt(UID, { email: "a@b.com" })).toBeNull());
  it("verifyAppJwt returns null", () => expect(verifyAppJwt("anything")).toBeNull());
});

describe("appJwt — env var names", () => {
  afterEach(() => { delete process.env.TANGERINE_JWT_SECRET; delete process.env.SUPABASE_JWT_SECRET; });
  it("TANGERINE_JWT_SECRET enables minting (canonical name)", () => {
    delete process.env.SUPABASE_JWT_SECRET;
    process.env.TANGERINE_JWT_SECRET = SECRET;
    expect(isAppJwtEnabled()).toBe(true);
    const { access_token } = signAppJwt(UID, {});
    expect(verifyAppJwt(access_token)?.sub).toBe(UID);
  });
  it("legacy SUPABASE_JWT_SECRET still works (back-compat)", () => {
    delete process.env.TANGERINE_JWT_SECRET;
    process.env.SUPABASE_JWT_SECRET = SECRET;
    expect(isAppJwtEnabled()).toBe(true);
  });
});

describe("appJwt — enabled", () => {
  beforeEach(() => { process.env.TANGERINE_JWT_SECRET = SECRET; });
  afterEach(() => { delete process.env.TANGERINE_JWT_SECRET; });

  it("round-trips sub + email", () => {
    const minted = signAppJwt(UID, { email: "ceo@rof.com" });
    expect(minted).not.toBeNull();
    expect(minted.expires_in).toBeGreaterThan(0);
    const v = verifyAppJwt(minted.access_token);
    expect(v).toEqual({ sub: UID, email: "ceo@rof.com" });
  });

  it("rejects a tampered payload", () => {
    const { access_token } = signAppJwt(UID, { email: "x@y.com" });
    const [h, , s] = access_token.split(".");
    const forged = Buffer.from(JSON.stringify({
      sub: "00000000-0000-0000-0000-000000000000", role: "authenticated",
      aud: "authenticated", iss: "tangerine-ms-bridge", exp: 9999999999,
    })).toString("base64url");
    expect(verifyAppJwt(`${h}.${forged}.${s}`)).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    const { access_token } = signAppJwt(UID, {});
    process.env.TANGERINE_JWT_SECRET = "a-totally-different-secret-value-zzzzz";
    expect(verifyAppJwt(access_token)).toBeNull();
  });

  it("rejects an expired token", () => {
    // Mint with iat far in the past so exp is already behind a fixed 'now'.
    const minted = signAppJwt(UID, { ttlSec: 60, nowSec: 1000 });
    expect(verifyAppJwt(minted.access_token, { nowSec: 2000 })).toBeNull();
    // Same token is valid at a time within its window.
    expect(verifyAppJwt(minted.access_token, { nowSec: 1030 })?.sub).toBe(UID);
  });

  it("rejects a non-bridge token (wrong claims) even with a valid signature", () => {
    // A token signed with the same secret but lacking our iss/role/aud must not
    // be honoured as an internal session.
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: UID, exp: 9999999999 })).toString("base64url");
    const sig = createHmac("sha256", SECRET).update(`${header}.${payload}`).digest("base64url");
    expect(verifyAppJwt(`${header}.${payload}.${sig}`)).toBeNull();
  });

  it("rejects malformed tokens", () => {
    expect(verifyAppJwt("")).toBeNull();
    expect(verifyAppJwt("a.b")).toBeNull();
    expect(verifyAppJwt("a.b.c.d")).toBeNull();
    expect(verifyAppJwt(null)).toBeNull();
  });
});
