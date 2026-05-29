// Tests for Tangerine P10-2b — GET /api/internal/users/me/entities.
//
// Same vi.hoisted + vi.mock("@supabase/supabase-js") pattern used by the
// T4-2 personalization-api test (api/_lib/__tests__/t4-chunk2-...).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockState = vi.hoisted(() => ({ admin: null }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => mockState.admin,
}));

const { default: handler, shapeEntitiesPayload } = await import("../entities/index.js");

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

function makeReq({ method = "GET", authHeader = null } = {}) {
  return {
    method,
    headers: {
      host: "localhost",
      ...(authHeader ? { authorization: authHeader } : {}),
    },
    url: "/api/internal/users/me/entities",
  };
}

// Stub admin client. entity_users rows are returned in shape that mirrors
// the PostgREST embedded-resource response.
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
        then(resolve, reject) {
          if (selectError) {
            return Promise.resolve({ data: null, error: selectError }).then(resolve, reject);
          }
          const filtered = rows.filter((r) =>
            state.filters.every(([c, v]) => r[c] === v));
          return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

describe("shapeEntitiesPayload (pure)", () => {
  it("returns empty list + null current when no rows", () => {
    const out = shapeEntitiesPayload([]);
    expect(out.entities).toEqual([]);
    expect(out.current_entity_id).toBeNull();
  });

  it("picks current = the is_default=true row", () => {
    const out = shapeEntitiesPayload([
      { entity_id: ROF_ID,     role: "admin",  is_default: false, entities: { id: ROF_ID,     code: "ROF",     name: "Ring Of Fire" } },
      { entity_id: SANDBOX_ID, role: "viewer", is_default: true,  entities: { id: SANDBOX_ID, code: "SANDBOX", name: "Sandbox" } },
    ]);
    expect(out.current_entity_id).toBe(SANDBOX_ID);
    expect(out.entities).toHaveLength(2);
    expect(out.entities.find((e) => e.id === SANDBOX_ID).is_default).toBe(true);
  });

  it("falls back to first row when no default is set", () => {
    const out = shapeEntitiesPayload([
      { entity_id: ROF_ID,     role: "admin",  is_default: false, entities: { id: ROF_ID,     code: "ROF",     name: "Ring Of Fire" } },
      { entity_id: SANDBOX_ID, role: "viewer", is_default: false, entities: { id: SANDBOX_ID, code: "SANDBOX", name: "Sandbox" } },
    ]);
    expect(out.current_entity_id).toBe(ROF_ID);
  });

  it("tolerates missing nested entities object", () => {
    const out = shapeEntitiesPayload([
      { entity_id: ROF_ID, role: "admin", is_default: true },
    ]);
    expect(out.entities[0].id).toBe(ROF_ID);
    expect(out.entities[0].code).toBeNull();
    expect(out.current_entity_id).toBe(ROF_ID);
  });
});

describe("entities GET handler", () => {
  beforeEach(() => {
    process.env.VITE_SUPABASE_URL = "https://fake.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
  });
  afterEach(() => { mockState.admin = null; });

  it("401 when no Authorization header", async () => {
    mockState.admin = buildAdmin();
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toMatch(/[Mm]issing/);
  });

  it("401 when JWT is invalid", async () => {
    mockState.admin = buildAdmin();
    const req = makeReq({ authHeader: "Bearer bad-token" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it("405 on non-GET", async () => {
    mockState.admin = buildAdmin();
    const req = makeReq({ method: "POST", authHeader: "Bearer good" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it("200 returns the user's entities and current_entity_id = default", async () => {
    mockState.admin = buildAdmin({
      rows: [
        { auth_id: TEST_AUTH, entity_id: ROF_ID,     role: "admin",  is_default: false, entities: { id: ROF_ID,     code: "ROF",     name: "Ring Of Fire" } },
        { auth_id: TEST_AUTH, entity_id: SANDBOX_ID, role: "viewer", is_default: true,  entities: { id: SANDBOX_ID, code: "SANDBOX", name: "Sandbox" } },
      ],
    });
    const req = makeReq({ authHeader: "Bearer good" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.entities).toHaveLength(2);
    expect(res.body.current_entity_id).toBe(SANDBOX_ID);
    const def = res.body.entities.find((e) => e.is_default);
    expect(def.id).toBe(SANDBOX_ID);
    expect(def.role).toBe("viewer");
  });

  it("200 with empty list when the user has no entity_users rows", async () => {
    mockState.admin = buildAdmin({ rows: [] });
    const req = makeReq({ authHeader: "Bearer good" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.entities).toEqual([]);
    expect(res.body.current_entity_id).toBeNull();
  });

  it("filters rows to the caller's auth_id only", async () => {
    // Plant a row for another user — the eq("auth_id", caller) filter
    // in the stub should drop it.
    mockState.admin = buildAdmin({
      rows: [
        { auth_id: TEST_AUTH, entity_id: ROF_ID, role: "admin", is_default: true,  entities: { id: ROF_ID, code: "ROF", name: "Ring Of Fire" } },
        { auth_id: "other",   entity_id: SANDBOX_ID, role: "admin", is_default: true, entities: { id: SANDBOX_ID, code: "SANDBOX", name: "Sandbox" } },
      ],
    });
    const req = makeReq({ authHeader: "Bearer good" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.entities).toHaveLength(1);
    expect(res.body.entities[0].id).toBe(ROF_ID);
  });

  it("500 when the supabase query errors", async () => {
    mockState.admin = buildAdmin({ selectError: { message: "boom" } });
    const req = makeReq({ authHeader: "Bearer good" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/boom/);
  });
});
