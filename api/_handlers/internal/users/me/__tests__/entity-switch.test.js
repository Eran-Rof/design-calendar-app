// Tests for Tangerine P10-2b — PUT /api/internal/users/me/entity-switch.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockState = vi.hoisted(() => ({ admin: null }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => mockState.admin,
}));

const { default: handler, validateSwitchBody } = await import("../entity-switch.js");

const ROF_ID     = "11111111-1111-1111-1111-111111111111";
const SANDBOX_ID = "33333333-3333-3333-3333-333333333333";
const STRANGER   = "44444444-4444-4444-4444-444444444444";
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
    url: "/api/internal/users/me/entity-switch",
    headers: {
      host: "localhost",
      ...(authHeader ? { authorization: authHeader } : {}),
    },
  };
}

function buildAdmin({
  validAuthId = TEST_AUTH,
  rows = [],
  selectError = null,
} = {}) {
  return {
    auth: {
      async getUser(jwt) {
        if (!jwt || jwt === "bad-token") {
          return { data: { user: null }, error: { message: "invalid" } };
        }
        return { data: { user: { id: validAuthId } }, error: null };
      },
    },
    from(table) {
      if (table !== "entity_users") throw new Error(`unexpected table: ${table}`);
      const state = { filters: [] };
      const builder = {
        select() { return builder; },
        eq(col, val) { state.filters.push([col, val]); return builder; },
        maybeSingle() {
          if (selectError) return Promise.resolve({ data: null, error: selectError });
          const row = rows.find((r) =>
            state.filters.every(([c, v]) => r[c] === v));
          return Promise.resolve({ data: row ?? null, error: null });
        },
      };
      return builder;
    },
  };
}

describe("validateSwitchBody (pure)", () => {
  it("rejects null body", () => {
    expect(validateSwitchBody(null).error).toMatch(/object/);
  });

  it("rejects non-object body", () => {
    expect(validateSwitchBody(42).error).toMatch(/object/);
  });

  it("rejects missing entity_id", () => {
    expect(validateSwitchBody({}).error).toMatch(/entity_id/);
  });

  it("rejects non-string entity_id", () => {
    expect(validateSwitchBody({ entity_id: 42 }).error).toMatch(/entity_id/);
  });

  it("rejects non-uuid entity_id", () => {
    expect(validateSwitchBody({ entity_id: "not-a-uuid" }).error).toMatch(/uuid/);
  });

  it("accepts a valid uuid", () => {
    expect(validateSwitchBody({ entity_id: ROF_ID }).error).toBeUndefined();
    expect(validateSwitchBody({ entity_id: ROF_ID }).data.entity_id).toBe(ROF_ID);
  });
});

describe("entity-switch PUT handler", () => {
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
    expect(res.body.error).toMatch(/entity_id/);
  });

  it("400 when entity_id is not a uuid", async () => {
    mockState.admin = buildAdmin();
    const req = makeReq({ body: { entity_id: "nope" }, authHeader: "Bearer good" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/uuid/);
  });

  it("400 on invalid JSON string body", async () => {
    mockState.admin = buildAdmin();
    const req = makeReq({ body: "{not-json", authHeader: "Bearer good" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("403 when caller is not a member of the entity", async () => {
    mockState.admin = buildAdmin({
      rows: [
        // Caller has access to ROF but not SANDBOX.
        { auth_id: TEST_AUTH, entity_id: ROF_ID, role: "admin", entities: { code: "ROF", name: "Ring Of Fire" } },
      ],
    });
    const req = makeReq({ body: { entity_id: SANDBOX_ID }, authHeader: "Bearer good" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/not a member/i);
  });

  it("403 when entity_id is well-formed uuid but unknown", async () => {
    mockState.admin = buildAdmin({ rows: [] });
    const req = makeReq({ body: { entity_id: STRANGER }, authHeader: "Bearer good" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(403);
  });

  it("200 when caller IS a member — returns {entity_id, code, name, role}", async () => {
    mockState.admin = buildAdmin({
      rows: [
        { auth_id: TEST_AUTH, entity_id: ROF_ID,     role: "admin",  entities: { code: "ROF",     name: "Ring Of Fire" } },
        { auth_id: TEST_AUTH, entity_id: SANDBOX_ID, role: "viewer", entities: { code: "SANDBOX", name: "Sandbox" } },
      ],
    });
    const req = makeReq({ body: { entity_id: SANDBOX_ID }, authHeader: "Bearer good" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      entity_id: SANDBOX_ID,
      code: "SANDBOX",
      name: "Sandbox",
      role: "viewer",
    });
  });

  it("accepts string-typed JSON body (raw Vercel passthrough)", async () => {
    mockState.admin = buildAdmin({
      rows: [
        { auth_id: TEST_AUTH, entity_id: ROF_ID, role: "admin", entities: { code: "ROF", name: "Ring Of Fire" } },
      ],
    });
    const req = makeReq({
      body: JSON.stringify({ entity_id: ROF_ID }),
      authHeader: "Bearer good",
    });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });
});
