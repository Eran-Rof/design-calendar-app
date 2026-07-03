// Tests for Cross-cutter T11-3 — GET /api/internal/audit/row-history.
//
// Covers the parse helper, the pickDisplayName resolver, and the HTTP
// envelope (401 / 400 / 405 / 200 / 500). We mock @supabase/supabase-js
// via the same vi.hoisted pattern the other audit handler tests use.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockState = vi.hoisted(() => ({ admin: null }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => mockState.admin,
}));

const {
  default: handler,
  parseRowHistoryQuery,
  pickDisplayName,
  T11_ALLOWED_SOURCE_TABLES,
} = await import("../row-history.js");

const TEST_AUTH = "22222222-2222-2222-2222-222222222222";
const INV_ID = "11111111-1111-1111-1111-111111111111";

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
    url:
      url ||
      `/api/internal/audit/row-history?source_table=ar_invoices&source_id=${INV_ID}`,
  };
}

function buildAdmin({
  changes = [],
  employees = [],
  selectError = null,
  authOk = true,
} = {}) {
  return {
    auth: {
      async getUser(jwt) {
        if (!jwt || jwt === "bad-token" || !authOk) {
          return { data: { user: null }, error: { message: "invalid" } };
        }
        return { data: { user: { id: TEST_AUTH } }, error: null };
      },
    },
    from(table) {
      if (table === "row_changes") {
        const state = { filters: [] };
        const builder = {
          select() { return builder; },
          eq(col, val) { state.filters.push([col, val]); return builder; },
          order() { return builder; },
          range() { return builder; },
          then(resolve, reject) {
            if (selectError) {
              return Promise.resolve({ data: null, error: selectError }).then(resolve, reject);
            }
            const filtered = changes.filter((r) =>
              state.filters.every(([c, v]) => r[c] === v),
            );
            return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
          },
        };
        return builder;
      }
      if (table === "employees") {
        const state = { filters: [], inValues: null };
        const builder = {
          select() { return builder; },
          in(col, vals) { state.inValues = { col, vals }; return builder; },
          then(resolve, reject) {
            const filtered =
              state.inValues
                ? employees.filter((e) => state.inValues.vals.includes(e.id))
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
// parseRowHistoryQuery (pure)
// ─────────────────────────────────────────────────────────────────────────────
describe("parseRowHistoryQuery", () => {
  it("rejects missing source_table", () => {
    const r = parseRowHistoryQuery({ source_id: INV_ID });
    expect(r.error).toMatch(/source_table/);
  });

  it("rejects a non-allowlisted source_table", () => {
    const r = parseRowHistoryQuery({ source_table: "secrets", source_id: INV_ID });
    expect(r.error).toMatch(/not in the T11 audit coverage/);
  });

  it("rejects missing source_id", () => {
    const r = parseRowHistoryQuery({ source_table: "ar_invoices" });
    expect(r.error).toMatch(/source_id/);
  });

  it("rejects non-uuid source_id", () => {
    const r = parseRowHistoryQuery({ source_table: "ar_invoices", source_id: "not-a-uuid" });
    expect(r.error).toMatch(/source_id must be a uuid/);
  });

  it("accepts every table in the allowlist", () => {
    for (const t of T11_ALLOWED_SOURCE_TABLES) {
      const r = parseRowHistoryQuery({ source_table: t, source_id: INV_ID });
      expect(r.data.source_table).toBe(t);
    }
  });

  it("defaults limit=50, offset=0", () => {
    const r = parseRowHistoryQuery({ source_table: "ar_invoices", source_id: INV_ID });
    expect(r.data.limit).toBe(50);
    expect(r.data.offset).toBe(0);
  });

  it("caps limit at 200", () => {
    const r = parseRowHistoryQuery({ source_table: "ar_invoices", source_id: INV_ID, limit: "9999" });
    expect(r.data.limit).toBe(200);
  });

  it("rejects non-positive limit", () => {
    const r = parseRowHistoryQuery({ source_table: "ar_invoices", source_id: INV_ID, limit: "0" });
    expect(r.error).toMatch(/limit/);
  });

  it("rejects negative offset", () => {
    const r = parseRowHistoryQuery({ source_table: "ar_invoices", source_id: INV_ID, offset: "-1" });
    expect(r.error).toMatch(/offset/);
  });

  it("rejects non-numeric limit", () => {
    const r = parseRowHistoryQuery({ source_table: "ar_invoices", source_id: INV_ID, limit: "many" });
    expect(r.error).toMatch(/limit/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// pickDisplayName (pure)
// ─────────────────────────────────────────────────────────────────────────────
describe("pickDisplayName", () => {
  it("returns the cached actor_display_name when present", () => {
    const name = pickDisplayName({ actor_display_name: "Eve Op" }, {});
    expect(name).toBe("Eve Op");
  });

  it("resolves full_name from employees map when display_name is empty", () => {
    const row = { actor_display_name: null, actor_employee_id: "e1" };
    const employees = { e1: { full_name: "Alice A" } };
    expect(pickDisplayName(row, employees)).toBe("Alice A");
  });

  it("falls back to first+last when full_name is missing", () => {
    const row = { actor_display_name: null, actor_employee_id: "e1" };
    const employees = { e1: { first_name: "Bob", last_name: "B", full_name: null } };
    expect(pickDisplayName(row, employees)).toBe("Bob B");
  });

  it("falls back to email when no name is available", () => {
    const row = { actor_display_name: null, actor_employee_id: "e1" };
    const employees = { e1: { email: "x@y.com" } };
    expect(pickDisplayName(row, employees)).toBe("x@y.com");
  });

  it("returns null when no actor info is available", () => {
    expect(pickDisplayName({}, {})).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP handler
// ─────────────────────────────────────────────────────────────────────────────
describe("row-history GET handler", () => {
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

  it("200 when the matching internal token is presented", async () => {
    process.env.INTERNAL_API_TOKEN = "test-secret";
    mockState.admin = buildAdmin({ changes: [] });
    const req = makeReq({ auth: "Bearer test-secret" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
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

  it("400 when source_table is not allowlisted", async () => {
    const req = makeReq({
      url: `/api/internal/audit/row-history?source_table=hackers&source_id=${INV_ID}`,
    });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/allowlist/);
  });

  it("400 when source_id is not a uuid", async () => {
    const req = makeReq({
      url: `/api/internal/audit/row-history?source_table=ar_invoices&source_id=abc`,
    });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("200 returns count + changes shape on empty result", async () => {
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.source_table).toBe("ar_invoices");
    expect(res.body.source_id).toBe(INV_ID);
    expect(res.body.count).toBe(0);
    expect(res.body.changes).toEqual([]);
  });

  it("200 includes the cached display_name on rows that carry it", async () => {
    mockState.admin = buildAdmin({
      changes: [
        {
          id: "c1",
          source_table: "ar_invoices",
          source_id: INV_ID,
          operation: "UPDATE",
          actor_display_name: "Eve Op",
          changed_columns: ["amount_cents"],
          changed_at: "2026-05-29T01:00:00Z",
        },
      ],
    });
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.changes[0].actor_display_name).toBe("Eve Op");
  });

  it("enriches missing display_name from the employees table", async () => {
    mockState.admin = buildAdmin({
      changes: [
        {
          id: "c1",
          source_table: "ar_invoices",
          source_id: INV_ID,
          operation: "INSERT",
          actor_employee_id: "e1",
          actor_display_name: null,
          changed_columns: [],
          changed_at: "2026-05-29T01:00:00Z",
        },
      ],
      employees: [{ id: "e1", full_name: "Resolved Name", email: null }],
    });
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.body.changes[0].actor_display_name).toBe("Resolved Name");
  });

  it("500 on supabase error", async () => {
    mockState.admin = buildAdmin({ selectError: { message: "boom" } });
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/boom/);
  });

  it("preserves changed_columns array verbatim", async () => {
    mockState.admin = buildAdmin({
      changes: [
        {
          id: "c1",
          source_table: "ar_invoices",
          source_id: INV_ID,
          operation: "UPDATE",
          changed_columns: ["amount_cents", "due_date", "memo"],
          changed_at: "2026-05-29T01:00:00Z",
        },
      ],
    });
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.body.changes[0].changed_columns).toEqual([
      "amount_cents",
      "due_date",
      "memo",
    ]);
  });

  it("returns an empty array when changed_columns is null on the row", async () => {
    mockState.admin = buildAdmin({
      changes: [
        {
          id: "c1",
          source_table: "ar_invoices",
          source_id: INV_ID,
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
    expect(res.body.error).toMatch(/not configured/);
  });
});
