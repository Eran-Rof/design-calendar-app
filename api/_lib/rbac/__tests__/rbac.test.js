// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Configurable fakes for the auth chain + supabase client.
let effRows = [];
let authResult = { ok: true, status: 200, error: null, authId: "user-1" };
let entityResult = { entity_id: "ent-1", source: "default", header_value: null, row_count: 1 };

vi.mock("../../auth.js", () => ({ authenticateCaller: vi.fn(async () => authResult) }));
vi.mock("../../auth/resolve-entity.js", () => ({ resolveCallerEntity: vi.fn(async () => entityResult) }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      then: (res, rej) => Promise.resolve({ data: effRows, error: null }).then(res, rej),
    };
    return { from: () => chain, auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) } };
  },
}));

import { rbacMode, isAllowed, loadEffectivePermissions, rbacObserve, rbacEnforce } from "../index.js";

function fakeRes() {
  const r = { statusCode: null, body: null, headersSent: false };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; r.headersSent = true; return r; };
  return r;
}

describe("rbac core", () => {
  beforeEach(() => {
    effRows = [];
    authResult = { ok: true, status: 200, error: null, authId: "user-1" };
    entityResult = { entity_id: "ent-1", source: "default", header_value: null, row_count: 1 };
    process.env.SUPABASE_URL = "https://x.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
    delete process.env.RBAC_MODE;
    vi.restoreAllMocks();
  });
  afterEach(() => { delete process.env.RBAC_MODE; });

  it("rbacMode defaults off; accepts log/enforce/strict", () => {
    expect(rbacMode()).toBe("off");
    process.env.RBAC_MODE = "log"; expect(rbacMode()).toBe("log");
    process.env.RBAC_MODE = "enforce"; expect(rbacMode()).toBe("enforce");
    process.env.RBAC_MODE = "strict"; expect(rbacMode()).toBe("strict");
    process.env.RBAC_MODE = "garbage"; expect(rbacMode()).toBe("off");
  });

  it("isAllowed checks membership", () => {
    const p = new Set(["coa:read", "coa:write"]);
    expect(isAllowed(p, "coa", "read")).toBe(true);
    expect(isAllowed(p, "coa", "post")).toBe(false);
    expect(isAllowed(null, "coa", "read")).toBe(false);
  });

  it("loadEffectivePermissions returns a Set of module:action; empty on bad args", async () => {
    effRows = [{ module_key: "coa", action: "read" }, { module_key: "je_post", action: "post" }];
    const sb = (await import("@supabase/supabase-js")).createClient();
    const set = await loadEffectivePermissions(sb, "user-1", "ent-1");
    expect(set.has("coa:read")).toBe(true);
    expect(set.has("je_post:post")).toBe(true);
    expect((await loadEffectivePermissions(sb, null, "ent-1")).size).toBe(0);
    expect((await loadEffectivePermissions(null, "user-1", "ent-1")).size).toBe(0);
  });

  it("rbacObserve is a no-op when RBAC_MODE is off", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await rbacObserve({ headers: {} }, "/api/internal/coa", "POST");
    expect(warn).not.toHaveBeenCalled();
  });

  it("rbacObserve logs a would-deny when the caller lacks the permission (log mode)", async () => {
    process.env.RBAC_MODE = "log";
    effRows = [{ module_key: "coa", action: "read" }]; // has read, NOT write
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await rbacObserve({ headers: { authorization: "Bearer jwt" } }, "/api/internal/coa", "POST"); // needs coa:write
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/would-deny POST \/api\/internal\/coa.*needs coa:write/);
  });

  it("rbacObserve stays silent when the caller IS allowed", async () => {
    process.env.RBAC_MODE = "log";
    effRows = [{ module_key: "coa", action: "write" }, { module_key: "coa", action: "read" }];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await rbacObserve({ headers: { authorization: "Bearer jwt" } }, "/api/internal/coa", "POST");
    expect(warn).not.toHaveBeenCalled();
  });

  it("rbacObserve never logs for unmapped/unauthenticated requests, never throws", async () => {
    process.env.RBAC_MODE = "log";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await rbacObserve({ headers: { authorization: "Bearer jwt" } }, "/api/cron/x", "GET"); // unmapped
    authResult = { ok: false, status: 401, error: "no jwt", authId: null };
    await rbacObserve({ headers: {} }, "/api/internal/coa", "POST"); // unauthenticated
    expect(warn).not.toHaveBeenCalled();
    // throwing deps must be swallowed
    authResult = null;
    await expect(rbacObserve({ headers: {} }, "/api/internal/coa", "POST")).resolves.toBeUndefined();
  });
});

describe("rbacEnforce (chunk 3 reject path)", () => {
  beforeEach(() => {
    effRows = [];
    authResult = { ok: true, status: 200, error: null, authId: "user-1" };
    entityResult = { entity_id: "ent-1", source: "default", header_value: null, row_count: 1 };
    process.env.SUPABASE_URL = "https://x.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
    process.env.RBAC_MODE = "enforce";
    vi.restoreAllMocks();
  });
  afterEach(() => { delete process.env.RBAC_MODE; });

  // Signature: rbacEnforce(req, res, pathname, method)
  const REQ = { headers: { authorization: "Bearer j" } };

  it("returns false (allows) when RBAC_MODE is not enforce", async () => {
    process.env.RBAC_MODE = "log";
    const res = fakeRes();
    expect(await rbacEnforce(REQ, res, "/api/internal/coa", "POST")).toBe(false);
    expect(res.statusCode).toBeNull();
  });

  it("rejects with 403 permission_denied when an authenticated caller lacks the permission", async () => {
    effRows = [{ module_key: "coa", action: "read" }]; // no write
    const res = fakeRes();
    const rejected = await rbacEnforce(REQ, res, "/api/internal/coa", "POST");
    expect(rejected).toBe(true);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: "permission_denied", module: "coa", action: "write" });
  });

  it("allows (false) when the caller HAS the permission", async () => {
    effRows = [{ module_key: "coa", action: "write" }];
    const res = fakeRes();
    expect(await rbacEnforce(REQ, res, "/api/internal/coa", "POST")).toBe(false);
    expect(res.statusCode).toBeNull();
  });

  it("does NOT block the anon-key surface (no bearer → pass)", async () => {
    authResult = { ok: false, status: 401, error: "no jwt", authId: null };
    const res = fakeRes();
    expect(await rbacEnforce({ headers: {} }, res, "/api/internal/coa", "POST")).toBe(false);
    expect(res.statusCode).toBeNull();
  });

  it("does not gate unmapped routes (vendor/cron/public)", async () => {
    const res = fakeRes();
    expect(await rbacEnforce(REQ, res, "/api/cron/x", "GET")).toBe(false);
  });

  it("passes (never blocks) on degenerate auth — the try/catch also fails open", async () => {
    authResult = null; // authenticateCaller returns a falsy result
    const res = fakeRes();
    expect(await rbacEnforce({ headers: {} }, res, "/api/internal/coa", "POST")).toBe(false);
    expect(res.statusCode).toBeNull();
  });
});

describe("rbacEnforce — strict mode", () => {
  beforeEach(() => {
    effRows = [];
    authResult = { ok: true, status: 200, error: null, authId: "user-1" };
    entityResult = { entity_id: "ent-1", source: "default", header_value: null, row_count: 1 };
    process.env.SUPABASE_URL = "https://x.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
    process.env.RBAC_MODE = "strict";
    vi.restoreAllMocks();
  });
  afterEach(() => { delete process.env.RBAC_MODE; });

  const REQ = { headers: { authorization: "Bearer j" } };

  it("rejects unauthenticated requests on mapped routes with 401 authentication_required", async () => {
    authResult = { ok: false, status: 401, error: "no jwt", authId: null };
    const res = fakeRes();
    const rejected = await rbacEnforce({ headers: {} }, res, "/api/internal/coa", "POST");
    expect(rejected).toBe(true);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "authentication_required", module: "coa", action: "write" });
  });

  it("does NOT 401 on unmapped routes even when unauthenticated (cron/public surface unaffected)", async () => {
    authResult = { ok: false, status: 401, error: "no jwt", authId: null };
    const res = fakeRes();
    expect(await rbacEnforce({ headers: {} }, res, "/api/cron/x", "GET")).toBe(false);
    expect(res.statusCode).toBeNull();
  });

  it("still rejects authenticated-but-missing-permission with 403 permission_denied", async () => {
    effRows = [{ module_key: "coa", action: "read" }]; // no write
    const res = fakeRes();
    const rejected = await rbacEnforce(REQ, res, "/api/internal/coa", "POST");
    expect(rejected).toBe(true);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: "permission_denied", module: "coa", action: "write" });
  });

  it("allows authenticated callers with the permission (no 401, no 403)", async () => {
    effRows = [{ module_key: "coa", action: "write" }];
    const res = fakeRes();
    expect(await rbacEnforce(REQ, res, "/api/internal/coa", "POST")).toBe(false);
    expect(res.statusCode).toBeNull();
  });
});
