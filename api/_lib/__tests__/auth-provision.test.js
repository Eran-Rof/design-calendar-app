// Tests for the Tangerine MS OAuth → Supabase Auth bridge.
//
// We exercise:
//   • validateMsTokenViaGraph (the security gate) directly via injected fetch
//   • the full handler with a mock supabase client + a vi.spyOn(globalThis, 'fetch')
//     stub so we can assert the side effects (createUser / entity_users / employee link)
//
// Notes:
//   - The handler imports `createClient` from @supabase/supabase-js; we mock
//     the module to return our buildAdmin() fake.
//   - `process.env.VITE_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` need to
//     be set for `client()` to succeed; we set them in beforeEach.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Hoisted shared state so the @supabase/supabase-js mock can swap admin
// instances per-test via vi.hoisted (Vitest hoists vi.mock above imports).
const mockState = vi.hoisted(() => ({ admin: null }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => mockState.admin,
}));

// Import AFTER vi.mock so the handler picks up the mocked createClient.
const { default: handler, validateMsTokenViaGraph } = await import("../../_handlers/internal/auth/provision.js");

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ROF_ENTITY_ID = "11111111-1111-1111-1111-111111111111";
const EXISTING_AUTH_ID = "22222222-2222-2222-2222-222222222222";
const NEW_AUTH_ID = "33333333-3333-3333-3333-333333333333";
const EMP_ID = "44444444-4444-4444-4444-444444444444";

function buildAdmin({
  entityFound = true,
  existingAuthUser = null,    // {id, email} or null
  listUsersPages = null,      // [[{id,email},...], ...] — multi-page listUsers (P27 pagination)
  createAuthError = null,     // string or null
  entityUsersUpsertError = null, // string or null
  employeeRow = null,         // {id, auth_user_id} or null (EB001)
  employeeUpdateError = null,
} = {}) {
  // Track captured calls for assertions.
  const calls = {
    createUserArgs: null,
    entityUsersUpsert: [],
    employeesUpdate: [],
  };

  return {
    _calls: calls,
    auth: {
      admin: {
        listUsers: async ({ page = 1 } = {}) => {
          if (listUsersPages) {
            return { data: { users: listUsersPages[page - 1] || [] }, error: null };
          }
          if (existingAuthUser) {
            // Single page of results — present only on page 1.
            return { data: { users: page === 1 ? [existingAuthUser] : [] }, error: null };
          }
          return { data: { users: [] }, error: null };
        },
        createUser: async (args) => {
          calls.createUserArgs = args;
          if (createAuthError) {
            return { data: null, error: { message: createAuthError } };
          }
          return {
            data: {
              user: {
                id: NEW_AUTH_ID,
                email: args.email,
                app_metadata: args.app_metadata,
              },
            },
            error: null,
          };
        },
      },
    },
    from(table) {
      if (table === "entities") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: entityFound ? { id: ROF_ENTITY_ID } : null,
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "entity_users") {
        return {
          upsert: async (row, opts) => {
            calls.entityUsersUpsert.push({ row, opts });
            if (entityUsersUpsertError) {
              return { error: { message: entityUsersUpsertError } };
            }
            return { error: null };
          },
        };
      }
      if (table === "employees") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: employeeRow,
                  error: null,
                }),
              }),
            }),
          }),
          update: (patch) => ({
            eq: async () => {
              calls.employeesUpdate.push(patch);
              if (employeeUpdateError) return { error: { message: employeeUpdateError } };
              return { error: null };
            },
          }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
}

function makeReq(body) {
  return {
    method: "POST",
    body,
    headers: { host: "localhost" },
    url: "/api/internal/auth/provision",
  };
}

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

// Stub fetch to return a fixed Graph /me response.
function stubGraphFetch({ ok = true, status = 200, payload = null } = {}) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload || {}),
  });
}

// ─── validateMsTokenViaGraph (unit-level) ─────────────────────────────────────

describe("validateMsTokenViaGraph", () => {
  it("rejects missing token", async () => {
    const result = await validateMsTokenViaGraph("", () => { throw new Error("should not be called"); });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/required/);
  });

  it("rejects whitespace-only token", async () => {
    const result = await validateMsTokenViaGraph("   ", () => { throw new Error("should not be called"); });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
  });

  it("rejects when Graph returns 401", async () => {
    const fakeFetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
    const result = await validateMsTokenViaGraph("bogus", fakeFetch);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toMatch(/HTTP 401/);
  });

  it("rejects when Graph response is missing both mail and userPrincipalName", async () => {
    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: "abc", displayName: "no email" }),
    });
    const result = await validateMsTokenViaGraph("tok", fakeFetch);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/email/);
  });

  it("returns normalized email lowercased on success", async () => {
    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: "graph-oid-xyz", mail: "Eran@RingOfFire.com", displayName: "Eran B" }),
    });
    const result = await validateMsTokenViaGraph("tok", fakeFetch);
    expect(result.ok).toBe(true);
    expect(result.profile.email).toBe("eran@ringoffire.com");
    expect(result.profile.ms_oid).toBe("graph-oid-xyz");
    expect(result.profile.display_name).toBe("Eran B");
  });

  it("falls back to userPrincipalName when mail is empty", async () => {
    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: "x", mail: "", userPrincipalName: "user@tenant.onmicrosoft.com" }),
    });
    const result = await validateMsTokenViaGraph("tok", fakeFetch);
    expect(result.ok).toBe(true);
    expect(result.profile.email).toBe("user@tenant.onmicrosoft.com");
  });
});

// ─── handler — full integration with mocks ───────────────────────────────────

describe("provision handler", () => {
  let fetchSpy;

  beforeEach(() => {
    process.env.VITE_SUPABASE_URL = "https://fake.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-key";
  });

  afterEach(() => {
    if (fetchSpy) { fetchSpy.mockRestore(); fetchSpy = null; }
    mockState.admin = null;
  });

  it("rejects when ms_access_token missing (400)", async () => {
    mockState.admin = buildAdmin();
    const req = makeReq({});
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/required/);
  });

  it("rejects when Graph returns 401 (invalid token)", async () => {
    fetchSpy = stubGraphFetch({ ok: false, status: 401, payload: { error: "invalid_token" } });
    mockState.admin = buildAdmin();
    const req = makeReq({ ms_access_token: "bogus" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toMatch(/Graph rejected/);
  });

  it("rejects when Graph returns no email (400)", async () => {
    fetchSpy = stubGraphFetch({ ok: true, status: 200, payload: { id: "abc", displayName: "No Email" } });
    mockState.admin = buildAdmin();
    const req = makeReq({ ms_access_token: "tok" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/email/);
  });

  it("rejects when ROF entity is missing (500)", async () => {
    fetchSpy = stubGraphFetch({
      ok: true, status: 200,
      payload: { id: "ms-oid", mail: "eran@rof.com" },
    });
    mockState.admin = buildAdmin({ entityFound: false });
    const req = makeReq({ ms_access_token: "tok" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/ROF/);
  });

  it("happy path: NEW user creates auth.users + entity_users + links EB001", async () => {
    fetchSpy = stubGraphFetch({
      ok: true, status: 200,
      payload: { id: "ms-oid-1", mail: "eran@rof.com", displayName: "Eran B" },
    });
    const admin = buildAdmin({
      existingAuthUser: null,
      employeeRow: { id: EMP_ID, auth_user_id: null },
    });
    mockState.admin = admin;
    const req = makeReq({ ms_access_token: "good-token" });
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.is_new_user).toBe(true);
    expect(res.body.auth_user_id).toBe(NEW_AUTH_ID);
    expect(res.body.email).toBe("eran@rof.com");
    expect(res.body.entity_id).toBe(ROF_ENTITY_ID);
    expect(res.body.role).toBe("admin");

    // createUser called with email_confirm + app_metadata.ms_oid
    expect(admin._calls.createUserArgs).toMatchObject({
      email: "eran@rof.com",
      email_confirm: true,
      app_metadata: { ms_oid: "ms-oid-1", provider: "microsoft" },
    });
    // entity_users upsert called with ignoreDuplicates on (auth_id, entity_id)
    expect(admin._calls.entityUsersUpsert).toHaveLength(1);
    expect(admin._calls.entityUsersUpsert[0].row).toMatchObject({
      auth_id: NEW_AUTH_ID, entity_id: ROF_ENTITY_ID, role: "admin",
    });
    expect(admin._calls.entityUsersUpsert[0].opts).toMatchObject({
      onConflict: "auth_id,entity_id", ignoreDuplicates: true,
    });
    // employees row updated with the new auth_user_id
    expect(admin._calls.employeesUpdate).toHaveLength(1);
    expect(admin._calls.employeesUpdate[0]).toEqual({ auth_user_id: NEW_AUTH_ID });
  });

  it("happy path: EXISTING auth user is reused, NOT created again", async () => {
    fetchSpy = stubGraphFetch({
      ok: true, status: 200,
      payload: { id: "ms-oid-2", mail: "eran@rof.com" },
    });
    const admin = buildAdmin({
      existingAuthUser: { id: EXISTING_AUTH_ID, email: "eran@rof.com" },
      employeeRow: { id: EMP_ID, auth_user_id: EXISTING_AUTH_ID }, // already linked
    });
    mockState.admin = admin;
    const req = makeReq({ ms_access_token: "tok" });
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.is_new_user).toBe(false);
    expect(res.body.auth_user_id).toBe(EXISTING_AUTH_ID);
    expect(admin._calls.createUserArgs).toBeNull(); // createUser NOT called
    // entity_users still upserted (idempotent — ON CONFLICT DO NOTHING)
    expect(admin._calls.entityUsersUpsert).toHaveLength(1);
    // employee row already linked → no UPDATE issued
    expect(admin._calls.employeesUpdate).toHaveLength(0);
  });

  it("P27: finds an existing user on a LATER page — no duplicate identity created", async () => {
    fetchSpy = stubGraphFetch({
      ok: true, status: 200,
      payload: { id: "ms-deep", mail: "deep@rof.com" },
    });
    // Page 1 is a full page of 200 OTHER users; the real match is on page 2.
    const fullPage = Array.from({ length: 200 }, (_, i) => ({ id: `filler-${i}`, email: `filler${i}@rof.com` }));
    const target = { id: EXISTING_AUTH_ID, email: "deep@rof.com" };
    const admin = buildAdmin({ listUsersPages: [fullPage, [target]] });
    mockState.admin = admin;
    const req = makeReq({ ms_access_token: "tok" });
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.is_new_user).toBe(false);
    expect(res.body.auth_user_id).toBe(EXISTING_AUTH_ID);
    // Critical: the user already existed (page 2) → createUser must NOT run.
    expect(admin._calls.createUserArgs).toBeNull();
  });

  it("matches existing user case-insensitively on email", async () => {
    fetchSpy = stubGraphFetch({
      ok: true, status: 200,
      payload: { id: "x", mail: "Eran@RingOfFire.com" },
    });
    const admin = buildAdmin({
      existingAuthUser: { id: EXISTING_AUTH_ID, email: "eran@ringoffire.com" },
    });
    mockState.admin = admin;
    const req = makeReq({ ms_access_token: "tok" });
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.is_new_user).toBe(false);
    expect(res.body.auth_user_id).toBe(EXISTING_AUTH_ID);
    expect(admin._calls.createUserArgs).toBeNull();
  });

  it("no employee row found: still succeeds, no employee update issued", async () => {
    fetchSpy = stubGraphFetch({
      ok: true, status: 200,
      payload: { id: "x", mail: "newhire@rof.com" },
    });
    const admin = buildAdmin({
      existingAuthUser: null,
      employeeRow: null, // no EB001 row at all
    });
    mockState.admin = admin;
    const req = makeReq({ ms_access_token: "tok" });
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.is_new_user).toBe(true);
    expect(admin._calls.employeesUpdate).toHaveLength(0);
  });

  it("returns 500 when entity_users upsert fails", async () => {
    fetchSpy = stubGraphFetch({
      ok: true, status: 200,
      payload: { id: "x", mail: "eran@rof.com" },
    });
    mockState.admin = buildAdmin({
      existingAuthUser: { id: EXISTING_AUTH_ID, email: "eran@rof.com" },
      entityUsersUpsertError: "fk violation",
    });
    const req = makeReq({ ms_access_token: "tok" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/entity_users/);
  });

  it("returns 500 when createUser returns an error", async () => {
    fetchSpy = stubGraphFetch({
      ok: true, status: 200,
      payload: { id: "x", mail: "newuser@rof.com" },
    });
    mockState.admin = buildAdmin({
      existingAuthUser: null,
      createAuthError: "weak-password-policy",
    });
    const req = makeReq({ ms_access_token: "tok" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/createUser/);
  });

  it("rejects non-POST methods (405)", async () => {
    mockState.admin = buildAdmin();
    const req = { method: "GET", headers: {}, url: "/api/internal/auth/provision" };
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it("OPTIONS returns 200 (CORS preflight)", async () => {
    mockState.admin = buildAdmin();
    const req = { method: "OPTIONS", headers: {}, url: "/api/internal/auth/provision" };
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it("parses string body (Vercel sometimes hands us a raw string)", async () => {
    fetchSpy = stubGraphFetch({
      ok: true, status: 200,
      payload: { id: "x", mail: "eran@rof.com" },
    });
    mockState.admin = buildAdmin({
      existingAuthUser: { id: EXISTING_AUTH_ID, email: "eran@rof.com" },
    });
    const req = {
      method: "POST",
      body: JSON.stringify({ ms_access_token: "tok" }),
      headers: { host: "localhost" },
      url: "/api/internal/auth/provision",
    };
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.auth_user_id).toBe(EXISTING_AUTH_ID);
  });
});
