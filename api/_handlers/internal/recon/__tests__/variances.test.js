// Tangerine P9-7 — tests for GET /api/internal/recon/variances.
//
// Covers parseVariancesQuery validator + the HTTP handler (auth, required
// recon_run_id, status filter, source_tag presence in response shape,
// 500 on supabase error).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockState = vi.hoisted(() => ({ admin: null }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => mockState.admin,
}));

const {
  default: handler,
  parseVariancesQuery,
  VARIANCE_STATUSES,
} = await import("../variances.js");

const RUN_ID = "11111111-1111-1111-1111-111111111111";

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

function makeReq({ method = "GET", url = `/api/internal/recon/variances?recon_run_id=${RUN_ID}`, headers = {} } = {}) {
  return {
    method,
    headers: { host: "localhost", ...headers },
    url,
  };
}

function buildAdmin({ variances = [], selectError = null } = {}) {
  return {
    from(table) {
      if (table !== "recon_variances") throw new Error(`unexpected table: ${table}`);
      const state = { filters: [], rangeFrom: 0, rangeTo: 999 };
      const builder = {
        select() { return builder; },
        order() { return builder; },
        range(from, to) { state.rangeFrom = from; state.rangeTo = to; return builder; },
        eq(col, val) { state.filters.push(["eq", col, val]); return builder; },
        then(resolve, reject) {
          if (selectError) {
            return Promise.resolve({ data: null, error: selectError }).then(resolve, reject);
          }
          const rows = variances.filter((r) => {
            for (const [op, col, v] of state.filters) {
              if (op === "eq" && r[col] !== v) return false;
            }
            return true;
          });
          return Promise.resolve({
            data: rows.slice(state.rangeFrom, state.rangeTo + 1),
            error: null,
          }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

// ────────────────────────────────────────────────────────────────────────
// parseVariancesQuery (pure)
// ────────────────────────────────────────────────────────────────────────
describe("parseVariancesQuery", () => {
  it("requires recon_run_id", () => {
    const r = parseVariancesQuery({});
    expect(r.error).toMatch(/recon_run_id is required/);
  });

  it("rejects non-uuid recon_run_id", () => {
    const r = parseVariancesQuery({ recon_run_id: "abc" });
    expect(r.error).toMatch(/recon_run_id must be a uuid/);
  });

  it("accepts a valid uuid recon_run_id", () => {
    const r = parseVariancesQuery({ recon_run_id: RUN_ID });
    expect(r.data.recon_run_id).toBe(RUN_ID);
    expect(r.data.limit).toBe(500);
    expect(r.data.offset).toBe(0);
  });

  it("accepts every status in the canonical list", () => {
    for (const s of VARIANCE_STATUSES) {
      const r = parseVariancesQuery({ recon_run_id: RUN_ID, status: s });
      expect(r.data.status).toBe(s);
    }
  });

  it("rejects an invalid status", () => {
    const r = parseVariancesQuery({ recon_run_id: RUN_ID, status: "weird" });
    expect(r.error).toMatch(/status/);
  });

  it("accepts a free-form source_tag", () => {
    const r = parseVariancesQuery({ recon_run_id: RUN_ID, source_tag: "xoro_mirror" });
    expect(r.data.source_tag).toBe("xoro_mirror");
  });

  it("clamps limit at 2000", () => {
    const r = parseVariancesQuery({ recon_run_id: RUN_ID, limit: "9999" });
    expect(r.data.limit).toBe(2000);
  });

  it("rejects negative offset", () => {
    const r = parseVariancesQuery({ recon_run_id: RUN_ID, offset: "-5" });
    expect(r.error).toMatch(/offset/);
  });

  it("exposes the canonical 4-status list", () => {
    expect(VARIANCE_STATUSES).toEqual(["within", "over", "cleared", "suppressed"]);
  });
});

// ────────────────────────────────────────────────────────────────────────
// HTTP handler
// ────────────────────────────────────────────────────────────────────────
describe("GET /api/internal/recon/variances handler", () => {
  const origToken = process.env.INTERNAL_API_TOKEN;
  beforeEach(() => {
    process.env.VITE_SUPABASE_URL = "https://fake.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-key";
    delete process.env.INTERNAL_API_TOKEN;
    mockState.admin = buildAdmin();
  });
  afterEach(() => {
    mockState.admin = null;
    if (origToken === undefined) delete process.env.INTERNAL_API_TOKEN;
    else process.env.INTERNAL_API_TOKEN = origToken;
  });

  it("405 on non-GET", async () => {
    const res = makeRes();
    await handler(makeReq({ method: "POST" }), res);
    expect(res.statusCode).toBe(405);
  });

  it("200 on OPTIONS preflight", async () => {
    const res = makeRes();
    await handler(makeReq({ method: "OPTIONS" }), res);
    expect(res.statusCode).toBe(200);
  });

  it("401 when INTERNAL_API_TOKEN set + no token", async () => {
    process.env.INTERNAL_API_TOKEN = "secret-token";
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(401);
  });

  it("200 when correct Bearer token presented", async () => {
    process.env.INTERNAL_API_TOKEN = "right-token";
    const res = makeRes();
    await handler(
      makeReq({ headers: { authorization: "Bearer right-token" } }),
      res,
    );
    expect(res.statusCode).toBe(200);
  });

  it("400 when recon_run_id missing", async () => {
    const res = makeRes();
    await handler(
      makeReq({ url: "/api/internal/recon/variances" }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/recon_run_id is required/);
  });

  it("400 when recon_run_id is not a uuid", async () => {
    const res = makeRes();
    await handler(
      makeReq({ url: "/api/internal/recon/variances?recon_run_id=not-uuid" }),
      res,
    );
    expect(res.statusCode).toBe(400);
  });

  it("400 on invalid status query param", async () => {
    const res = makeRes();
    await handler(
      makeReq({ url: `/api/internal/recon/variances?recon_run_id=${RUN_ID}&status=weird` }),
      res,
    );
    expect(res.statusCode).toBe(400);
  });

  it("200 with the scoped variance list when run has rows", async () => {
    mockState.admin = buildAdmin({
      variances: [
        { id: "v1", recon_run_id: RUN_ID, source_table: "ar_invoices", source_id: "i1",
          source_tag: "shopify", tangerine_amount_cents: 100, xoro_amount_cents: 80,
          variance_amount_cents: 20, status: "over", notes: null, created_at: "2026-05-29T00:00:00Z" },
        { id: "v2", recon_run_id: "other-run", source_table: "ar_invoices", source_id: "i2",
          source_tag: "fba", tangerine_amount_cents: 0, xoro_amount_cents: 0,
          variance_amount_cents: 0, status: "within", notes: null, created_at: "2026-05-29T00:00:00Z" },
      ],
    });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.variances[0].id).toBe("v1");
  });

  it("filters by status when provided", async () => {
    mockState.admin = buildAdmin({
      variances: [
        { id: "v1", recon_run_id: RUN_ID, status: "over",    source_tag: "shopify" },
        { id: "v2", recon_run_id: RUN_ID, status: "within",  source_tag: "shopify" },
        { id: "v3", recon_run_id: RUN_ID, status: "cleared", source_tag: "fba" },
      ],
    });
    const res = makeRes();
    await handler(
      makeReq({ url: `/api/internal/recon/variances?recon_run_id=${RUN_ID}&status=cleared` }),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.variances[0].status).toBe("cleared");
  });

  it("response rows include source_tag (T10 surface)", async () => {
    mockState.admin = buildAdmin({
      variances: [
        { id: "v1", recon_run_id: RUN_ID, status: "over", source_tag: "xoro_mirror" },
      ],
    });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.variances[0]).toHaveProperty("source_tag");
    expect(res.body.variances[0].source_tag).toBe("xoro_mirror");
  });

  it("filters by source_tag when provided", async () => {
    mockState.admin = buildAdmin({
      variances: [
        { id: "v1", recon_run_id: RUN_ID, status: "over", source_tag: "shopify" },
        { id: "v2", recon_run_id: RUN_ID, status: "over", source_tag: "fba" },
      ],
    });
    const res = makeRes();
    await handler(
      makeReq({ url: `/api/internal/recon/variances?recon_run_id=${RUN_ID}&source_tag=fba` }),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.variances[0].source_tag).toBe("fba");
  });

  it("500 on supabase select error", async () => {
    mockState.admin = buildAdmin({ selectError: { message: "kaboom-var" } });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/kaboom-var/);
  });

  it("500 when supabase env vars missing", async () => {
    delete process.env.VITE_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    mockState.admin = null;
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(500);
  });

  it("response envelope shape is { count, limit, offset, variances }", async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.body).toHaveProperty("count");
    expect(res.body).toHaveProperty("limit");
    expect(res.body).toHaveProperty("offset");
    expect(res.body).toHaveProperty("variances");
    expect(Array.isArray(res.body.variances)).toBe(true);
  });
});
