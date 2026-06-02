// Tests for Tangerine P10-2b — PUT /api/internal/users/me/entity-default.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockState = vi.hoisted(() => ({ admin: null }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => mockState.admin,
}));

const { default: handler, validateDefaultBody } = await import("../entity-default.js");

const ROF_ID     = "11111111-1111-1111-1111-111111111111";
const SANDBOX_ID = "33333333-3333-3333-3333-333333333333";
const TEST_AUTH  = "22222222-2222-2222-2222-222222222222";

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; },
  };
}

function makeReq({ method = "PUT", body = undefined, authHeader = null } = {}) {
  return {
    method,
    body,
    url: "/api/internal/users/me/entity-default",
    headers: {
      host: "localhost",
      ...(authHeader ? { authorization: authHeader } : {}),
    },
  };
}

// Stub admin client with mutable entity_users rows + UPDATE support.
// Each UPDATE is recorded and applied in-memory so the test can assert
// the post-state of the is_default flags.
function buildAdmin({
  validAuthId = TEST_AUTH,
  rows = [],
} = {}) {
  // Mutable working copy — supports the two sequential UPDATEs.
  const state = { rows: rows.map((r) => ({ ...r })), updates: [] };

  function table() {
    const q = { filters: [], updateValues: null, returning: false };
    const builder = {
      select() { q.returning = true; return builder; },
      eq(col, val) { q.filters.push([col, val]); return builder; },
      maybeSingle() {
        const row = state.rows.find((r) =>
          q.filters.every(([c, v]) => r[c] === v));
        return Promise.resolve({ data: row ? { ...row } : null, error: null });
      },
      single() {
        // Used after .update(...).select() — return the matched row
        // after the update was applied.
        const row = state.rows.find((r) =>
          q.filters.every(([c, v]) => r[c] === v));
        return Promise.resolve({ data: row ? { ...row } : null, error: null });
      },
      update(values) {
        q.updateValues = values;
        // Defer the actual write until the chain finishes. We return a
        // chain that still supports .eq()/.select()/.single() so the
        // handler's chain works without changes.
        const writeChain = {
          eq(col, val) { q.filters.push([col, val]); return writeChain; },
          select() { q.returning = true; return writeChain; },
          single() {
            applyUpdate();
            const row = state.rows.find((r) =>
              q.filters.every(([c, v]) => r[c] === v));
            return Promise.resolve({ data: row ? { ...row } : null, error: null });
          },
          then(resolve, reject) {
            applyUpdate();
            return Promise.resolve({ data: null, error: null }).then(resolve, reject);
          },
        };
        return writeChain;
      },
    };
    function applyUpdate() {
      const matches = state.rows.filter((r) =>
        q.filters.every(([c, v]) => r[c] === v));
      for (const r of matches) Object.assign(r, q.updateValues);
      state.updates.push({ filters: [...q.filters], values: { ...q.updateValues } });
    }
    return builder;
  }

  return {
    _state: state,
    auth: {
      async getUser(jwt) {
        if (!jwt || jwt === "bad-token") {
          return { data: { user: null }, error: { message: "invalid" } };
        }
        return { data: { user: { id: validAuthId } }, error: null };
      },
    },
    from(t) {
      if (t !== "entity_users") throw new Error(`unexpected table: ${t}`);
      return table();
    },
  };
}

describe("validateDefaultBody (pure)", () => {
  it("rejects non-object body", () => {
    expect(validateDefaultBody(null).error).toMatch(/object/);
  });

  it("rejects missing entity_id", () => {
    expect(validateDefaultBody({}).error).toMatch(/entity_id/);
  });

  it("rejects non-uuid entity_id", () => {
    expect(validateDefaultBody({ entity_id: "not-uuid" }).error).toMatch(/uuid/);
  });

  it("accepts a valid uuid", () => {
    expect(validateDefaultBody({ entity_id: ROF_ID }).error).toBeUndefined();
  });
});

describe("entity-default PUT handler", () => {
  beforeEach(() => {
    process.env.VITE_SUPABASE_URL = "https://fake.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
  });
  afterEach(() => { mockState.admin = null; });

  it("401 when no Authorization header", async () => {
    mockState.admin = buildAdmin();
    const req = makeReq({ body: { entity_id: ROF_ID } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it("401 when JWT is invalid", async () => {
    mockState.admin = buildAdmin();
    const req = makeReq({ body: { entity_id: ROF_ID }, authHeader: "Bearer bad-token" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it("405 on non-PUT", async () => {
    mockState.admin = buildAdmin();
    const req = makeReq({ method: "GET", authHeader: "Bearer good" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it("400 when entity_id is missing", async () => {
    mockState.admin = buildAdmin();
    const req = makeReq({ body: {}, authHeader: "Bearer good" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("400 when entity_id is not a uuid", async () => {
    mockState.admin = buildAdmin();
    const req = makeReq({ body: { entity_id: "nope" }, authHeader: "Bearer good" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("403 when caller is not a member of the entity", async () => {
    mockState.admin = buildAdmin({
      rows: [
        { auth_id: TEST_AUTH, entity_id: ROF_ID, role: "admin", is_default: true },
      ],
    });
    const req = makeReq({ body: { entity_id: SANDBOX_ID }, authHeader: "Bearer good" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it("200 happy path — clears prior default + sets new default", async () => {
    const admin = buildAdmin({
      rows: [
        { auth_id: TEST_AUTH, entity_id: ROF_ID,     role: "admin",  is_default: true },
        { auth_id: TEST_AUTH, entity_id: SANDBOX_ID, role: "viewer", is_default: false },
      ],
    });
    mockState.admin = admin;
    const req = makeReq({ body: { entity_id: SANDBOX_ID }, authHeader: "Bearer good" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      entity_id: SANDBOX_ID,
      role: "viewer",
      is_default: true,
    });
    // Post-state: exactly one is_default=true row, and it's the SANDBOX one.
    const defaults = admin._state.rows.filter((r) => r.is_default === true);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].entity_id).toBe(SANDBOX_ID);
    // And the previously-default ROF row is now false.
    const rofRow = admin._state.rows.find((r) => r.entity_id === ROF_ID);
    expect(rofRow.is_default).toBe(false);
  });

  it("200 when the requested entity is already the default — still toggles cleanly", async () => {
    const admin = buildAdmin({
      rows: [
        { auth_id: TEST_AUTH, entity_id: ROF_ID,     role: "admin",  is_default: true },
        { auth_id: TEST_AUTH, entity_id: SANDBOX_ID, role: "viewer", is_default: false },
      ],
    });
    mockState.admin = admin;
    const req = makeReq({ body: { entity_id: ROF_ID }, authHeader: "Bearer good" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const defaults = admin._state.rows.filter((r) => r.is_default === true);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].entity_id).toBe(ROF_ID);
  });

  it("200 happy path when no previous default existed", async () => {
    const admin = buildAdmin({
      rows: [
        { auth_id: TEST_AUTH, entity_id: ROF_ID,     role: "admin",  is_default: false },
        { auth_id: TEST_AUTH, entity_id: SANDBOX_ID, role: "viewer", is_default: false },
      ],
    });
    mockState.admin = admin;
    const req = makeReq({ body: { entity_id: ROF_ID }, authHeader: "Bearer good" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const defaults = admin._state.rows.filter((r) => r.is_default === true);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].entity_id).toBe(ROF_ID);
  });

  it("invariant: at most one is_default=true row for the caller after success", async () => {
    const admin = buildAdmin({
      rows: [
        { auth_id: TEST_AUTH, entity_id: ROF_ID,     role: "admin",  is_default: true },
        { auth_id: TEST_AUTH, entity_id: SANDBOX_ID, role: "viewer", is_default: false },
        // Another user's row should be left untouched.
        { auth_id: "other-user", entity_id: SANDBOX_ID, role: "admin", is_default: true },
      ],
    });
    mockState.admin = admin;
    const req = makeReq({ body: { entity_id: SANDBOX_ID }, authHeader: "Bearer good" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    const callerDefaults = admin._state.rows.filter(
      (r) => r.auth_id === TEST_AUTH && r.is_default === true);
    expect(callerDefaults).toHaveLength(1);
    // The other user's default is preserved.
    const otherDefault = admin._state.rows.find(
      (r) => r.auth_id === "other-user");
    expect(otherDefault.is_default).toBe(true);
  });
});
