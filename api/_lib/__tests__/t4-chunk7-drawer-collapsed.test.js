// Tests for Cross-cutter T4-7 — favorites-drawer redesign.
//
// Covers the new PUT /api/internal/users/me/preferences/drawer-collapsed
// handler that persists the favorites strip open/closed state:
//   • validateDrawerCollapsedBody — accepts {collapsed:true|false},
//     rejects missing/wrong-type fields and non-object bodies.
//   • 401 when no Authorization header.
//   • 405 when called with anything other than PUT.
//   • 200 happy path — upsert hits user_preferences with key
//     "drawer_collapsed" and value {collapsed:..., v:1}, and the
//     handler echoes the stored row back.
//
// Same vi.hoisted + vi.mock("@supabase/supabase-js") pattern used by
// t4-chunk2-personalization-api.test.js so the integration shape stays
// consistent.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockState = vi.hoisted(() => ({ admin: null }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => mockState.admin,
}));

const { default: drawerHandler, validateDrawerCollapsedBody } =
  await import("../../_handlers/internal/users/me/preferences/drawer-collapsed.js");

const ROF_ENTITY_ID = "11111111-1111-1111-1111-111111111111";
const TEST_AUTH_ID  = "22222222-2222-2222-2222-222222222222";

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
    headers: authHeader ? { authorization: authHeader } : {},
    query: {},
    url: "/api/internal/users/me/preferences/drawer-collapsed",
  };
}

function buildAdmin() {
  // Mimics the subset of the supabase client surface this handler uses:
  //   admin.from("entities").select("id").eq("code","ROF").maybeSingle()
  //   admin.from("user_preferences").upsert(row, {onConflict})
  //     .select("key, value").single()
  // Each call records its inputs so the assertions can verify shape.
  const captured = { upserted: null, conflictTarget: null };

  const fromHandlers = {
    entities: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { id: ROF_ENTITY_ID }, error: null }),
        }),
      }),
    }),
    user_preferences: () => ({
      upsert: (row, opts) => {
        captured.upserted = row;
        captured.conflictTarget = opts?.onConflict ?? null;
        return {
          select: () => ({
            single: async () => ({
              data: { key: row.key, value: row.value },
              error: null,
            }),
          }),
        };
      },
      // Stub for the getUser path inside authenticateCaller — unused here
      // because we monkey-patch admin.auth.getUser below.
    }),
  };

  return {
    captured,
    from(table) {
      const fn = fromHandlers[table];
      if (!fn) throw new Error("unexpected table: " + table);
      return fn();
    },
    auth: {
      getUser: async (token) => {
        if (token === "valid-token") {
          return { data: { user: { id: TEST_AUTH_ID } }, error: null };
        }
        return { data: { user: null }, error: { message: "bad token" } };
      },
    },
  };
}

describe("validateDrawerCollapsedBody", () => {
  it("accepts {collapsed:true}", () => {
    expect(validateDrawerCollapsedBody({ collapsed: true })).toEqual({ data: { collapsed: true } });
  });
  it("accepts {collapsed:false}", () => {
    expect(validateDrawerCollapsedBody({ collapsed: false })).toEqual({ data: { collapsed: false } });
  });
  it("rejects when collapsed is missing", () => {
    expect(validateDrawerCollapsedBody({}).error).toMatch(/collapsed must be a boolean/i);
  });
  it("rejects when collapsed is non-boolean", () => {
    expect(validateDrawerCollapsedBody({ collapsed: "true" }).error).toMatch(/collapsed must be a boolean/i);
    expect(validateDrawerCollapsedBody({ collapsed: 1 }).error).toMatch(/collapsed must be a boolean/i);
  });
  it("rejects non-object bodies", () => {
    expect(validateDrawerCollapsedBody(null).error).toMatch(/JSON object/i);
    expect(validateDrawerCollapsedBody("hi").error).toMatch(/JSON object/i);
  });
});

describe("PUT /preferences/drawer-collapsed handler", () => {
  beforeEach(() => {
    mockState.admin = buildAdmin();
    // Make the supabase env vars look configured so the handler
    // proceeds past its bail-out.
    process.env.VITE_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
  });

  it("405s on GET", async () => {
    const req = makeReq({ method: "GET", authHeader: "Bearer valid-token" });
    const res = makeRes();
    await drawerHandler(req, res);
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe("PUT");
  });

  it("401s when missing Authorization header", async () => {
    const req = makeReq({ method: "PUT", body: { collapsed: true } });
    const res = makeRes();
    await drawerHandler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it("400s on invalid body", async () => {
    const req = makeReq({ method: "PUT", body: { collapsed: "nope" }, authHeader: "Bearer valid-token" });
    const res = makeRes();
    await drawerHandler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/collapsed must be a boolean/i);
  });

  it("happy path — upserts and echoes the stored row", async () => {
    const req = makeReq({ method: "PUT", body: { collapsed: true }, authHeader: "Bearer valid-token" });
    const res = makeRes();
    await drawerHandler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ key: "drawer_collapsed", value: { collapsed: true, v: 1 } });
    const cap = mockState.admin.captured;
    expect(cap.conflictTarget).toBe("user_id,entity_id,key");
    expect(cap.upserted.user_id).toBe(TEST_AUTH_ID);
    expect(cap.upserted.entity_id).toBe(ROF_ENTITY_ID);
    expect(cap.upserted.key).toBe("drawer_collapsed");
    expect(cap.upserted.value).toEqual({ collapsed: true, v: 1 });
    expect(typeof cap.upserted.updated_at).toBe("string");
  });

  it("happy path — collapsed:false also persists", async () => {
    const req = makeReq({ method: "PUT", body: { collapsed: false }, authHeader: "Bearer valid-token" });
    const res = makeRes();
    await drawerHandler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.value).toEqual({ collapsed: false, v: 1 });
  });
});
