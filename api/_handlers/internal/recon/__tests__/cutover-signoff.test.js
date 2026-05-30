// Tangerine P9-9 — tests for POST /api/internal/recon/cutover-signoff.
//
// Covers:
//   - validateSignoffBody (pure body validator)
//   - mergeParallelRunStatus (jsonb merge — preserves siblings)
//   - HTTP gates: 405 non-POST, 200 OPTIONS, 400 bad body
//   - 401 missing / bad bearer
//   - 403 non-admin / non-accountant
//   - 409 ineligible (insufficient clean runs)
//   - 409 duplicate (unique_violation 23505)
//   - 200 happy path → insert + entities.parallel_run_status flip,
//     other domains preserved
//   - source_tag channel-level signoff appends source_tags_solo

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockState = vi.hoisted(() => ({ admin: null }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => mockState.admin,
}));

const {
  default: handler,
  validateSignoffBody,
  mergeParallelRunStatus,
  resolveActorContext,
} = await import("../cutover-signoff.js");

const ENTITY = "00000000-0000-0000-0000-0000000000aa";
const AUTH_ID = "00000000-0000-0000-0000-000000000aaa";
const EMP_ID = "00000000-0000-0000-0000-000000000bbb";

function makeRes() {
  const headers = {};
  return {
    statusCode: 0,
    body: null,
    headers,
    setHeader(k, v) { headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

function makeReq({
  method = "POST",
  body = { domain: "ap", notes: "Signing off AP — Plaid + receiving stable." },
  headers = { authorization: "Bearer goodjwt" },
} = {}) {
  return {
    method,
    headers: { host: "localhost", "content-type": "application/json", ...headers },
    url: "/api/internal/recon/cutover-signoff",
    body,
    query: {},
  };
}

// ────────────────────────────────────────────────────────────────────────
// In-memory supabase double.
// Pass a fixture describing the state of each table the handler touches.
// ────────────────────────────────────────────────────────────────────────
function buildAdmin({
  // auth
  authUser = { id: AUTH_ID },
  authError = null,
  // employees
  employeeRow = { id: EMP_ID, full_name: "Eran", first_name: "Eran", last_name: "B", email: "e@x.com" },
  employeeError = null,
  // entity_users
  entityUsers = [{ entity_id: ENTITY, role: "admin" }],
  entityUsersError = null,
  // entities
  entityRow = { id: ENTITY, code: "ROF", parallel_run_status: {} },
  entityError = null,
  entityUpdateError = null,
  // recon_runs (for eligibility)
  reconRuns = [],
  reconRunsError = null,
  // recon_cutover_signoffs
  signoffInsertResult = null,
  signoffInsertError = null,
} = {}) {
  const inserts = { recon_cutover_signoffs: [] };
  const updates = { entities: [] };

  return {
    _inserts: inserts,
    _updates: updates,
    auth: {
      getUser(jwt) {
        if (authError) return Promise.resolve({ data: { user: null }, error: authError });
        if (!jwt || jwt === "badjwt") return Promise.resolve({ data: { user: null }, error: null });
        return Promise.resolve({ data: { user: authUser }, error: null });
      },
    },
    from(table) {
      if (table === "employees") {
        const builder = {
          select() { return builder; },
          eq() { return builder; },
          maybeSingle() {
            if (employeeError) return Promise.resolve({ data: null, error: employeeError });
            return Promise.resolve({ data: employeeRow, error: null });
          },
        };
        return builder;
      }
      if (table === "entity_users") {
        const builder = {
          select() { return builder; },
          eq() { return builder; },
          then(resolve) {
            if (entityUsersError) return resolve({ data: null, error: entityUsersError });
            return resolve({ data: entityUsers, error: null });
          },
        };
        return builder;
      }
      if (table === "entities") {
        const state = { mode: "select", payload: null };
        const builder = {
          select() { state.mode = state.mode === "update" ? state.mode : "select"; return builder; },
          eq() { return builder; },
          maybeSingle() {
            if (state.mode === "update") {
              if (entityUpdateError) return Promise.resolve({ data: null, error: entityUpdateError });
              return Promise.resolve({ data: null, error: null });
            }
            if (entityError) return Promise.resolve({ data: null, error: entityError });
            return Promise.resolve({ data: entityRow, error: null });
          },
          update(payload) {
            state.mode = "update";
            state.payload = payload;
            updates.entities.push(payload);
            // .update() is awaited directly in the handler (no maybeSingle)
            // make this thenable for that path.
            return {
              eq() {
                if (entityUpdateError) return Promise.resolve({ error: entityUpdateError });
                return Promise.resolve({ error: null });
              },
            };
          },
        };
        return builder;
      }
      if (table === "recon_runs") {
        const filters = [];
        const chain = {
          select() { return chain; },
          eq(c, v) { filters.push(["eq", c, v]); return chain; },
          gte(c, v) { filters.push(["gte", c, v]); return chain; },
          lte(c, v) { filters.push(["lte", c, v]); return chain; },
          order() { return chain; },
          then(resolve) {
            if (reconRunsError) return resolve({ data: null, error: reconRunsError });
            // honor filters so per-domain eligibility checks return
            // only matching rows. Skip entity_id since test fixtures
            // don't stamp it (every row is assumed to belong to the
            // test entity).
            let out = reconRuns;
            for (const [op, col, val] of filters) {
              if (col === "entity_id") continue;
              out = out.filter((r) => {
                if (op === "eq") return r[col] === val;
                if (op === "gte") return r[col] >= val;
                if (op === "lte") return r[col] <= val;
                return true;
              });
            }
            return resolve({ data: out, error: null });
          },
        };
        return chain;
      }
      if (table === "recon_cutover_signoffs") {
        const state = { payload: null };
        const builder = {
          insert(payload) { state.payload = payload; return builder; },
          select() { return builder; },
          maybeSingle() {
            if (signoffInsertError) return Promise.resolve({ data: null, error: signoffInsertError });
            inserts.recon_cutover_signoffs.push(state.payload);
            const row = signoffInsertResult || {
              id: "sg-" + Math.random().toString(36).slice(2, 8),
              ...state.payload,
              signoff_at: new Date().toISOString(),
            };
            return Promise.resolve({ data: row, error: null });
          },
        };
        return builder;
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
}

// Build N clean recon_runs ending today, in ASCENDING run_date order
// so the eligibility code's oldest=runs[0] / latest=runs[last] math
// matches the .order('run_date', { ascending: true }) the chain
// would normally apply.
function makeCleanRunsFor(domain, n = 8) {
  const now = new Date();
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 7 * 86400000);
    out.push({
      id: `r-${domain}-${i}`,
      domain,
      status: "clean",
      run_date: d.toISOString().slice(0, 10),
      period_start: d.toISOString().slice(0, 10),
      period_end: d.toISOString().slice(0, 10),
      completed_at: d.toISOString(),
    });
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────
// validateSignoffBody (pure)
// ────────────────────────────────────────────────────────────────────────
describe("validateSignoffBody", () => {
  it("rejects non-object body", () => {
    expect(validateSignoffBody(null).error).toMatch(/must be an object/);
    expect(validateSignoffBody("hello").error).toMatch(/must be an object/);
  });

  it("requires domain", () => {
    expect(validateSignoffBody({}).error).toMatch(/domain is required/);
  });

  it("validates domain enum", () => {
    expect(validateSignoffBody({ domain: "bogus" }).error).toMatch(/domain must be one of/);
  });

  it("accepts each valid domain (case-insensitive)", () => {
    for (const d of ["ap", "ar", "cash", "gl", "inventory"]) {
      expect(validateSignoffBody({ domain: d.toUpperCase() }).data.domain).toBe(d);
    }
  });

  it("validates source_tag length", () => {
    const tooLong = "x".repeat(65);
    expect(validateSignoffBody({ domain: "ar", source_tag: tooLong }).error).toMatch(/source_tag/);
  });

  it("rejects non-string source_tag", () => {
    expect(validateSignoffBody({ domain: "ar", source_tag: 42 }).error).toMatch(/source_tag/);
  });

  it("treats whitespace source_tag as null (whole-domain)", () => {
    const v = validateSignoffBody({ domain: "ar", source_tag: "   " });
    expect(v.data.source_tag).toBeNull();
  });

  it("validates notes length", () => {
    const tooLong = "x".repeat(501);
    expect(validateSignoffBody({ domain: "ap", notes: tooLong }).error).toMatch(/notes/);
  });

  it("rejects non-string notes", () => {
    expect(validateSignoffBody({ domain: "ap", notes: {} }).error).toMatch(/notes/);
  });

  it("happy path returns trimmed + normalized values", () => {
    const v = validateSignoffBody({
      domain: "AR ", source_tag: "  shopify  ", notes: "  ok  ",
    });
    expect(v.data).toEqual({ domain: "ar", source_tag: "shopify", notes: "ok" });
  });
});

// ────────────────────────────────────────────────────────────────────────
// mergeParallelRunStatus (pure jsonb merge)
// ────────────────────────────────────────────────────────────────────────
describe("mergeParallelRunStatus", () => {
  const ISO = "2026-05-29T12:00:00Z";

  it("starts from empty current", () => {
    const out = mergeParallelRunStatus({}, { domain: "ap", source_tag: null, cutover_at: ISO });
    expect(out.ap.status).toBe("solo");
    expect(out.ap.cutover_at).toBe(ISO);
  });

  it("treats null current as empty", () => {
    const out = mergeParallelRunStatus(null, { domain: "cash", source_tag: null, cutover_at: ISO });
    expect(out.cash.status).toBe("solo");
  });

  it("preserves siblings when flipping one domain", () => {
    const current = {
      ap: { status: "parallel", last_recon: "r1" },
      ar: { status: "parallel" },
      gl: { status: "parallel" },
    };
    const out = mergeParallelRunStatus(current, { domain: "cash", source_tag: null, cutover_at: ISO });
    expect(out.ap).toEqual(current.ap);
    expect(out.ar).toEqual(current.ar);
    expect(out.gl).toEqual(current.gl);
    expect(out.cash.status).toBe("solo");
    expect(out.cash.cutover_at).toBe(ISO);
  });

  it("preserves existing keys on the same domain (last_recon stays)", () => {
    const current = {
      ap: { status: "parallel", last_recon: "r1", last_status: "clean" },
    };
    const out = mergeParallelRunStatus(current, { domain: "ap", source_tag: null, cutover_at: ISO });
    expect(out.ap.last_recon).toBe("r1");
    expect(out.ap.last_status).toBe("clean");
    expect(out.ap.status).toBe("solo");
  });

  it("appends source_tag to source_tags_solo (dedup)", () => {
    const current = {
      ar: { status: "parallel", source_tags_solo: ["shopify"] },
    };
    const out = mergeParallelRunStatus(current, {
      domain: "ar", source_tag: "shopify", cutover_at: ISO,
    });
    expect(out.ar.source_tags_solo).toEqual(["shopify"]);
    expect(out.ar.status).toBe("solo");

    const out2 = mergeParallelRunStatus(out, {
      domain: "ar", source_tag: "fba", cutover_at: ISO,
    });
    expect(out2.ar.source_tags_solo.sort()).toEqual(["fba", "shopify"]);
  });

  it("source_tag null does not touch source_tags_solo", () => {
    const out = mergeParallelRunStatus(
      { ar: { status: "parallel", source_tags_solo: ["shopify"] } },
      { domain: "ar", source_tag: null, cutover_at: ISO },
    );
    expect(out.ar.source_tags_solo).toEqual(["shopify"]);
  });

  it("handles broken existing entry types", () => {
    const out = mergeParallelRunStatus(
      { ap: "wrong-type-string" },
      { domain: "ap", source_tag: null, cutover_at: ISO },
    );
    expect(out.ap.status).toBe("solo");
  });
});

// ────────────────────────────────────────────────────────────────────────
// resolveActorContext (auth → employee + role)
// ────────────────────────────────────────────────────────────────────────
describe("resolveActorContext", () => {
  it("returns 403 when no admin/accountant role exists", async () => {
    const admin = buildAdmin({ entityUsers: [{ entity_id: ENTITY, role: "staff" }] });
    const ctx = await resolveActorContext(admin, AUTH_ID);
    expect(ctx.ok).toBe(false);
    expect(ctx.status).toBe(403);
  });

  it("returns ok with role when admin", async () => {
    const admin = buildAdmin();
    const ctx = await resolveActorContext(admin, AUTH_ID);
    expect(ctx.ok).toBe(true);
    expect(ctx.role).toBe("admin");
    expect(ctx.employee_id).toBe(EMP_ID);
  });

  it("returns ok with role when accountant", async () => {
    const admin = buildAdmin({ entityUsers: [{ entity_id: ENTITY, role: "accountant" }] });
    const ctx = await resolveActorContext(admin, AUTH_ID);
    expect(ctx.ok).toBe(true);
    expect(ctx.role).toBe("accountant");
  });

  it("500 when employees lookup errors", async () => {
    const admin = buildAdmin({ employeeError: { message: "boom" } });
    const ctx = await resolveActorContext(admin, AUTH_ID);
    expect(ctx.ok).toBe(false);
    expect(ctx.status).toBe(500);
  });

  it("500 when entity_users lookup errors", async () => {
    const admin = buildAdmin({ entityUsersError: { message: "boom" } });
    const ctx = await resolveActorContext(admin, AUTH_ID);
    expect(ctx.ok).toBe(false);
    expect(ctx.status).toBe(500);
  });

  it("allows missing employee row (system actor)", async () => {
    const admin = buildAdmin({ employeeRow: null });
    const ctx = await resolveActorContext(admin, AUTH_ID);
    expect(ctx.ok).toBe(true);
    expect(ctx.employee_id).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────
// HTTP handler
// ────────────────────────────────────────────────────────────────────────
describe("POST /api/internal/recon/cutover-signoff handler", () => {
  beforeEach(() => {
    process.env.VITE_SUPABASE_URL = "https://x.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
    mockState.admin = buildAdmin({ reconRuns: makeCleanRunsFor("ap", 8) });
  });
  afterEach(() => {
    mockState.admin = null;
  });

  it("200 on OPTIONS preflight", async () => {
    const res = makeRes();
    await handler(makeReq({ method: "OPTIONS" }), res);
    expect(res.statusCode).toBe(200);
  });

  it("405 on non-POST", async () => {
    const res = makeRes();
    await handler(makeReq({ method: "GET" }), res);
    expect(res.statusCode).toBe(405);
  });

  it("401 missing bearer", async () => {
    const res = makeRes();
    await handler(makeReq({ headers: {} }), res);
    expect(res.statusCode).toBe(401);
  });

  it("401 bad bearer", async () => {
    const res = makeRes();
    await handler(makeReq({ headers: { authorization: "Bearer badjwt" } }), res);
    expect(res.statusCode).toBe(401);
  });

  it("400 bad body", async () => {
    const res = makeRes();
    await handler(makeReq({ body: { domain: "bogus" } }), res);
    expect(res.statusCode).toBe(400);
  });

  it("400 unparseable JSON string body", async () => {
    const res = makeRes();
    await handler(makeReq({ body: "{nope" }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/Invalid JSON/);
  });

  it("403 when role is not admin / accountant", async () => {
    mockState.admin = buildAdmin({
      reconRuns: makeCleanRunsFor("ap", 8),
      entityUsers: [{ entity_id: ENTITY, role: "staff" }],
    });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(403);
  });

  it("409 ineligible (only 3 clean runs)", async () => {
    mockState.admin = buildAdmin({ reconRuns: makeCleanRunsFor("ap", 3) });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/not eligible/);
    expect(res.body.verdict).toBeTruthy();
  });

  it("409 ineligible when a variance run is in the window", async () => {
    const rows = makeCleanRunsFor("ar", 8);
    rows[3].status = "variance";
    mockState.admin = buildAdmin({
      reconRuns: rows,
      entityUsers: [{ entity_id: ENTITY, role: "accountant" }],
    });
    const res = makeRes();
    await handler(makeReq({ body: { domain: "ar" } }), res);
    expect(res.statusCode).toBe(409);
  });

  it("409 unique_violation (already signed off)", async () => {
    mockState.admin = buildAdmin({
      reconRuns: makeCleanRunsFor("ap", 8),
      signoffInsertError: { code: "23505", message: 'duplicate key value violates unique constraint "recon_cutover_signoffs_unique"' },
    });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/already signed off/);
  });

  it("200 happy path — inserts signoff + flips parallel_run_status", async () => {
    const admin = buildAdmin({
      reconRuns: makeCleanRunsFor("ap", 8),
      entityRow: { id: ENTITY, code: "ROF", parallel_run_status: { ar: { status: "parallel" } } },
    });
    mockState.admin = admin;
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.signoff).toBeTruthy();
    expect(res.body.signoff.domain).toBe("ap");
    // verify the insert payload carried the eligibility window + employee_id
    expect(admin._inserts.recon_cutover_signoffs).toHaveLength(1);
    const inserted = admin._inserts.recon_cutover_signoffs[0];
    expect(inserted.entity_id).toBe(ENTITY);
    expect(inserted.domain).toBe("ap");
    expect(inserted.signoff_employee_id).toBe(EMP_ID);
    expect(inserted.total_recons).toBeGreaterThanOrEqual(8);
    // verify the entities update preserved the AR domain
    expect(admin._updates.entities).toHaveLength(1);
    const blob = admin._updates.entities[0].parallel_run_status;
    expect(blob.ap.status).toBe("solo");
    expect(blob.ar.status).toBe("parallel");
    expect(res.body.parallel_run_status.ap.status).toBe("solo");
    expect(res.body.parallel_run_status.ar.status).toBe("parallel");
  });

  it("200 channel-level — appends source_tags_solo on AR", async () => {
    const admin = buildAdmin({
      reconRuns: makeCleanRunsFor("ar", 8),
      entityRow: { id: ENTITY, code: "ROF", parallel_run_status: {} },
    });
    mockState.admin = admin;
    const res = makeRes();
    await handler(makeReq({ body: { domain: "ar", source_tag: "shopify" } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.signoff.source_tag).toBe("shopify");
    const blob = admin._updates.entities[0].parallel_run_status;
    expect(blob.ar.status).toBe("solo");
    expect(blob.ar.source_tags_solo).toEqual(["shopify"]);
  });

  it("response includes actor context", async () => {
    mockState.admin = buildAdmin({ reconRuns: makeCleanRunsFor("ap", 8) });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.actor.auth_id).toBe(AUTH_ID);
    expect(res.body.actor.employee_id).toBe(EMP_ID);
    expect(res.body.actor.role).toBe("admin");
  });

  it("parallel_run_status update failure surfaces in response but signoff still 200", async () => {
    mockState.admin = buildAdmin({
      reconRuns: makeCleanRunsFor("ap", 8),
      entityUpdateError: { message: "update-boom" },
    });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.parallel_run_status_error).toMatch(/update-boom/);
  });

  it("500 when entity lookup fails", async () => {
    mockState.admin = buildAdmin({
      reconRuns: makeCleanRunsFor("ap", 8),
      entityError: { message: "ents-boom" },
    });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(500);
  });

  it("500 when env vars missing", async () => {
    delete process.env.VITE_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    mockState.admin = null;
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(500);
  });

  it("500 when signoff insert errors with non-unique error", async () => {
    mockState.admin = buildAdmin({
      reconRuns: makeCleanRunsFor("ap", 8),
      signoffInsertError: { code: "XX000", message: "insert-fail" },
    });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/insert-fail/);
  });
});
