// Tests for Cross-cutter T11-3 — GET /api/internal/audit/log.
//
// Covers the parse helper (filter validation + date bounds), the boundary
// helpers, and the HTTP envelope (401 / 400 / 405 / 200 / 500).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockState = vi.hoisted(() => ({ admin: null }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => mockState.admin,
}));

const {
  default: handler,
  parseAuditLogQuery,
  endOfDayBoundary,
  startOfDayBoundary,
  AUDIT_OPERATIONS,
} = await import("../log.js");

const TEST_AUTH = "22222222-2222-2222-2222-222222222222";
const ENTITY_ID = "11111111-1111-1111-1111-111111111111";
const ACTOR_ID = "33333333-3333-3333-3333-333333333333";

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

function makeReq({ method = "GET", auth = "Bearer good", url } = {}) {
  return {
    method,
    headers: {
      host: "localhost",
      ...(auth ? { authorization: auth } : {}),
    },
    url: url || "/api/internal/audit/log",
  };
}

function buildAdmin({
  changes = [],
  employees = [],
  selectError = null,
} = {}) {
  return {
    auth: {
      async getUser(jwt) {
        if (!jwt || jwt === "bad-token") {
          return { data: { user: null }, error: { message: "invalid" } };
        }
        return { data: { user: { id: TEST_AUTH } }, error: null };
      },
    },
    from(table) {
      if (table === "row_changes") {
        const state = { filters: [], in: null };
        const builder = {
          select() { return builder; },
          eq(col, val) { state.filters.push([col, val]); return builder; },
          in(col, vals) { state.in = { col, vals }; return builder; },
          gte(col, val) { state.filters.push([`>=${col}`, val]); return builder; },
          lt(col, val) { state.filters.push([`<${col}`, val]); return builder; },
          order() { return builder; },
          range() { return builder; },
          then(resolve, reject) {
            if (selectError) {
              return Promise.resolve({ data: null, error: selectError }).then(resolve, reject);
            }
            let filtered = changes.filter((r) => {
              for (const [c, v] of state.filters) {
                if (c.startsWith(">=")) {
                  if (!(r[c.slice(2)] >= v)) return false;
                } else if (c.startsWith("<")) {
                  if (!(r[c.slice(1)] < v)) return false;
                } else {
                  if (r[c] !== v) return false;
                }
              }
              if (state.in) {
                if (!state.in.vals.includes(r[state.in.col])) return false;
              }
              return true;
            });
            return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
          },
        };
        return builder;
      }
      if (table === "employees") {
        const state = { in: null };
        const builder = {
          select() { return builder; },
          in(col, vals) { state.in = { col, vals }; return builder; },
          then(resolve, reject) {
            const filtered = state.in
              ? employees.filter((e) => state.in.vals.includes(e.id))
              : employees;
            return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
          },
        };
        return builder;
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// parseAuditLogQuery (pure)
// ─────────────────────────────────────────────────────────────────────────────
describe("parseAuditLogQuery", () => {
  it("returns defaults when no filters provided", () => {
    const r = parseAuditLogQuery({});
    expect(r.data.entity_id).toBeNull();
    expect(r.data.source_table).toBeNull();
    expect(r.data.actor).toBeNull();
    expect(r.data.operations).toBeNull();
    expect(r.data.from).toBeNull();
    expect(r.data.to).toBeNull();
    expect(r.data.limit).toBe(100);
    expect(r.data.offset).toBe(0);
  });

  it("rejects bad entity_id uuid", () => {
    const r = parseAuditLogQuery({ entity_id: "not-uuid" });
    expect(r.error).toMatch(/entity_id/);
  });

  it("accepts a valid entity_id uuid", () => {
    const r = parseAuditLogQuery({ entity_id: ENTITY_ID });
    expect(r.data.entity_id).toBe(ENTITY_ID);
  });

  it("rejects source_table not in the allowlist", () => {
    const r = parseAuditLogQuery({ source_table: "passwords" });
    expect(r.error).toMatch(/allowlist/);
  });

  it("rejects bad actor uuid", () => {
    const r = parseAuditLogQuery({ actor: "abc" });
    expect(r.error).toMatch(/actor/);
  });

  it("parses comma-separated operation filter", () => {
    const r = parseAuditLogQuery({ operation: "INSERT,VOID" });
    expect(r.data.operations).toEqual(["INSERT", "VOID"]);
  });

  it("upper-cases operations to match the schema enum", () => {
    const r = parseAuditLogQuery({ operation: "insert,Post" });
    expect(r.data.operations).toEqual(["INSERT", "POST"]);
  });

  it("rejects an unknown operation", () => {
    const r = parseAuditLogQuery({ operation: "FOO" });
    expect(r.error).toMatch(/operation/);
  });

  it("rejects non-YYYY-MM-DD from date", () => {
    const r = parseAuditLogQuery({ from: "yesterday" });
    expect(r.error).toMatch(/from/);
  });

  it("rejects from > to", () => {
    const r = parseAuditLogQuery({ from: "2026-05-29", to: "2026-05-28" });
    expect(r.error).toMatch(/from must be <= to/);
  });

  it("caps limit at 500", () => {
    const r = parseAuditLogQuery({ limit: "10000" });
    expect(r.data.limit).toBe(500);
  });

  it("rejects negative offset", () => {
    const r = parseAuditLogQuery({ offset: "-5" });
    expect(r.error).toMatch(/offset/);
  });

  it("exposes the canonical AUDIT_OPERATIONS list", () => {
    expect(AUDIT_OPERATIONS).toEqual([
      "INSERT", "UPDATE", "DELETE", "VOID", "POST", "REVERSE",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Boundary helpers
// ─────────────────────────────────────────────────────────────────────────────
describe("boundary helpers", () => {
  it("startOfDayBoundary returns ISO string at 00:00 UTC", () => {
    expect(startOfDayBoundary("2026-05-29")).toBe("2026-05-29T00:00:00.000Z");
  });
  it("endOfDayBoundary advances by one day (exclusive upper bound)", () => {
    expect(endOfDayBoundary("2026-05-29")).toBe("2026-05-30T00:00:00.000Z");
  });
  it("returns null on bad date strings", () => {
    expect(startOfDayBoundary("nope")).toBeNull();
    expect(endOfDayBoundary("nope")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP handler
// ─────────────────────────────────────────────────────────────────────────────
describe("audit-log GET handler", () => {
  beforeEach(() => {
    process.env.VITE_SUPABASE_URL = "https://fake.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "fake";
    mockState.admin = buildAdmin();
  });
  afterEach(() => { mockState.admin = null; delete process.env.INTERNAL_API_TOKEN; });

  // Auth is now the standard internal-token gate (authenticateInternalCaller),
  // not the per-user authenticateCaller — accepts the static deploy token via
  // Bearer OR X-Internal-Token, and fail-opens when INTERNAL_API_TOKEN is unset.
  it("401 when the internal token is required but missing", async () => {
    process.env.INTERNAL_API_TOKEN = "test-secret";
    const req = makeReq({ auth: null });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it("401 when the presented internal token is wrong", async () => {
    process.env.INTERNAL_API_TOKEN = "test-secret";
    const req = makeReq({ auth: "Bearer wrong-token" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it("405 on non-GET", async () => {
    const req = makeReq({ method: "POST" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it("200 on OPTIONS preflight", async () => {
    const req = makeReq({ method: "OPTIONS" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it("400 on bad source_table query param", async () => {
    const req = makeReq({
      url: "/api/internal/audit/log?source_table=nope",
    });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("400 on bad operation param", async () => {
    const req = makeReq({
      url: "/api/internal/audit/log?operation=BOGUS",
    });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("200 with empty result when no rows", async () => {
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.count).toBe(0);
    expect(res.body.changes).toEqual([]);
    expect(res.body.limit).toBe(100);
    expect(res.body.offset).toBe(0);
  });

  it("filters by source_table when provided", async () => {
    mockState.admin = buildAdmin({
      changes: [
        {
          id: "c1",
          entity_id: ENTITY_ID,
          source_table: "ar_invoices",
          source_id: "r1",
          operation: "INSERT",
          changed_at: "2026-05-29T01:00:00Z",
        },
        {
          id: "c2",
          entity_id: ENTITY_ID,
          source_table: "vendors",
          source_id: "r2",
          operation: "UPDATE",
          changed_at: "2026-05-29T02:00:00Z",
        },
      ],
    });
    const req = makeReq({
      url: "/api/internal/audit/log?source_table=ar_invoices",
    });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.changes[0].source_table).toBe("ar_invoices");
  });

  it("filters by operation set", async () => {
    mockState.admin = buildAdmin({
      changes: [
        { id: "c1", source_table: "ar_invoices", source_id: "r1", operation: "INSERT", changed_at: "2026-05-29T01:00:00Z" },
        { id: "c2", source_table: "ar_invoices", source_id: "r1", operation: "VOID", changed_at: "2026-05-29T02:00:00Z" },
        { id: "c3", source_table: "ar_invoices", source_id: "r1", operation: "UPDATE", changed_at: "2026-05-29T03:00:00Z" },
      ],
    });
    const req = makeReq({
      url: "/api/internal/audit/log?operation=VOID,INSERT",
    });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.count).toBe(2);
    const ops = res.body.changes.map((c) => c.operation).sort();
    expect(ops).toEqual(["INSERT", "VOID"]);
  });

  it("filters by actor (employee_id)", async () => {
    mockState.admin = buildAdmin({
      changes: [
        { id: "c1", source_table: "ar_invoices", source_id: "r1", operation: "UPDATE", actor_employee_id: ACTOR_ID, changed_at: "2026-05-29T01:00:00Z" },
        { id: "c2", source_table: "ar_invoices", source_id: "r1", operation: "UPDATE", actor_employee_id: "other", changed_at: "2026-05-29T02:00:00Z" },
      ],
    });
    const req = makeReq({
      url: `/api/internal/audit/log?actor=${ACTOR_ID}`,
    });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.changes[0].actor_employee_id).toBe(ACTOR_ID);
  });

  it("500 on supabase error", async () => {
    mockState.admin = buildAdmin({ selectError: { message: "kaboom" } });
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/kaboom/);
  });

  it("includes cached actor_display_name verbatim", async () => {
    mockState.admin = buildAdmin({
      changes: [
        {
          id: "c1",
          source_table: "vendors",
          source_id: "v1",
          operation: "UPDATE",
          actor_display_name: "Cached Op",
          changed_at: "2026-05-29T01:00:00Z",
        },
      ],
    });
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.body.changes[0].actor_display_name).toBe("Cached Op");
  });

  it("normalizes changed_columns null → empty array", async () => {
    mockState.admin = buildAdmin({
      changes: [
        {
          id: "c1",
          source_table: "vendors",
          source_id: "v1",
          operation: "INSERT",
          changed_columns: null,
          changed_at: "2026-05-29T01:00:00Z",
        },
      ],
    });
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.body.changes[0].changed_columns).toEqual([]);
  });

  it("500 when supabase env vars are missing", async () => {
    delete process.env.VITE_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
  });

  it("returns the requested limit + offset in the envelope", async () => {
    const req = makeReq({
      url: "/api/internal/audit/log?limit=25&offset=50",
    });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.limit).toBe(25);
    expect(res.body.offset).toBe(50);
  });
});
