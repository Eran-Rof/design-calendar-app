// Tangerine P9-7 — tests for GET /api/internal/recon/runs.
//
// Covers parseRunsQuery validator + the HTTP handler (auth gate, CORS,
// domain filter, date range filter, limit clamp, response envelope,
// 500 on supabase error).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockState = vi.hoisted(() => ({ admin: null }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => mockState.admin,
}));

const {
  default: handler,
  parseRunsQuery,
  RECON_DOMAINS,
} = await import("../runs.js");

const RUN_ID = "00000000-0000-0000-0000-0000000000aa";

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

function makeReq({ method = "GET", url = "/api/internal/recon/runs", headers = {} } = {}) {
  return {
    method,
    headers: { host: "localhost", ...headers },
    url,
  };
}

function buildAdmin({ runs = [], selectError = null } = {}) {
  return {
    from(table) {
      if (table !== "recon_runs") throw new Error(`unexpected table: ${table}`);
      const state = { filters: [], rangeFrom: 0, rangeTo: 999 };
      const builder = {
        select() { return builder; },
        order() { return builder; },
        range(from, to) { state.rangeFrom = from; state.rangeTo = to; return builder; },
        eq(col, val) { state.filters.push(["eq", col, val]); return builder; },
        gte(col, val) { state.filters.push(["gte", col, val]); return builder; },
        lte(col, val) { state.filters.push(["lte", col, val]); return builder; },
        then(resolve, reject) {
          if (selectError) {
            return Promise.resolve({ data: null, error: selectError }).then(resolve, reject);
          }
          let rows = runs.filter((r) => {
            for (const [op, col, v] of state.filters) {
              if (op === "eq"  && r[col] !== v) return false;
              if (op === "gte" && !(r[col] >= v)) return false;
              if (op === "lte" && !(r[col] <= v)) return false;
            }
            return true;
          });
          const sliced = rows.slice(state.rangeFrom, state.rangeTo + 1);
          return Promise.resolve({ data: sliced, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

// ────────────────────────────────────────────────────────────────────────
// parseRunsQuery (pure)
// ────────────────────────────────────────────────────────────────────────
describe("parseRunsQuery", () => {
  it("returns defaults when no params provided", () => {
    const r = parseRunsQuery({});
    expect(r.data.domain).toBeNull();
    expect(r.data.from).toBeNull();
    expect(r.data.to).toBeNull();
    expect(r.data.limit).toBe(200);
    expect(r.data.offset).toBe(0);
  });

  it("accepts every domain in the canonical allowlist", () => {
    for (const d of RECON_DOMAINS) {
      const r = parseRunsQuery({ domain: d });
      expect(r.data.domain).toBe(d);
    }
  });

  it("rejects an unknown domain", () => {
    const r = parseRunsQuery({ domain: "bogus" });
    expect(r.error).toMatch(/domain/);
  });

  it("lower-cases the domain input", () => {
    const r = parseRunsQuery({ domain: "INVENTORY" });
    expect(r.data.domain).toBe("inventory");
  });

  it("rejects a malformed from date", () => {
    const r = parseRunsQuery({ from: "yesterday" });
    expect(r.error).toMatch(/from/);
  });

  it("rejects a malformed to date", () => {
    const r = parseRunsQuery({ to: "31-05-2026" });
    expect(r.error).toMatch(/to/);
  });

  it("rejects from > to", () => {
    const r = parseRunsQuery({ from: "2026-05-29", to: "2026-05-01" });
    expect(r.error).toMatch(/from must be <= to/);
  });

  it("clamps oversized limit to 1000", () => {
    const r = parseRunsQuery({ limit: "5000" });
    expect(r.data.limit).toBe(1000);
  });

  it("rejects non-positive limit", () => {
    const r = parseRunsQuery({ limit: "0" });
    expect(r.error).toMatch(/limit/);
  });

  it("rejects negative offset", () => {
    const r = parseRunsQuery({ offset: "-1" });
    expect(r.error).toMatch(/offset/);
  });

  it("treats empty-string params as 'not provided'", () => {
    const r = parseRunsQuery({ domain: "", from: "", to: "", limit: "", offset: "" });
    expect(r.error).toBeUndefined();
    expect(r.data.limit).toBe(200);
  });

  it("exposes RECON_DOMAINS as the canonical 5-domain list", () => {
    expect(RECON_DOMAINS).toEqual(["ap", "ar", "cash", "gl", "inventory"]);
  });
});

// ────────────────────────────────────────────────────────────────────────
// HTTP handler
// ────────────────────────────────────────────────────────────────────────
describe("GET /api/internal/recon/runs handler", () => {
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

  it("401 when INTERNAL_API_TOKEN is set + no token presented", async () => {
    process.env.INTERNAL_API_TOKEN = "secret-token";
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(401);
  });

  it("200 when correct Bearer token presented", async () => {
    process.env.INTERNAL_API_TOKEN = "right-token";
    const res = makeRes();
    await handler(makeReq({ headers: { authorization: "Bearer right-token" } }), res);
    expect(res.statusCode).toBe(200);
  });

  it("200 with empty result when no rows", async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.count).toBe(0);
    expect(res.body.runs).toEqual([]);
    expect(res.body.limit).toBe(200);
    expect(res.body.offset).toBe(0);
  });

  it("400 on invalid domain query param", async () => {
    const res = makeRes();
    await handler(makeReq({ url: "/api/internal/recon/runs?domain=bogus" }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/domain/);
  });

  it("400 on malformed from date", async () => {
    const res = makeRes();
    await handler(makeReq({ url: "/api/internal/recon/runs?from=nope" }), res);
    expect(res.statusCode).toBe(400);
  });

  it("filters by domain when provided", async () => {
    mockState.admin = buildAdmin({
      runs: [
        { id: "r1", domain: "inventory", run_date: "2026-05-29", status: "clean", totals_jsonb: {} },
        { id: "r2", domain: "ap",        run_date: "2026-05-29", status: "clean", totals_jsonb: {} },
      ],
    });
    const res = makeRes();
    await handler(makeReq({ url: "/api/internal/recon/runs?domain=inventory" }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.runs[0].domain).toBe("inventory");
  });

  it("filters by date range (from/to inclusive)", async () => {
    mockState.admin = buildAdmin({
      runs: [
        { id: "r1", domain: "ap", run_date: "2026-05-01", status: "clean", totals_jsonb: {} },
        { id: "r2", domain: "ap", run_date: "2026-05-15", status: "clean", totals_jsonb: {} },
        { id: "r3", domain: "ap", run_date: "2026-05-29", status: "clean", totals_jsonb: {} },
      ],
    });
    const res = makeRes();
    await handler(
      makeReq({ url: "/api/internal/recon/runs?from=2026-05-10&to=2026-05-20" }),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.runs[0].run_date).toBe("2026-05-15");
  });

  it("includes the requested limit + offset in the envelope", async () => {
    const res = makeRes();
    await handler(
      makeReq({ url: "/api/internal/recon/runs?limit=50&offset=10" }),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.limit).toBe(50);
    expect(res.body.offset).toBe(10);
  });

  it("clamps limit to 1000 when caller asks for more", async () => {
    const res = makeRes();
    await handler(
      makeReq({ url: "/api/internal/recon/runs?limit=9999" }),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.limit).toBe(1000);
  });

  it("500 on supabase select error", async () => {
    mockState.admin = buildAdmin({ selectError: { message: "kaboom-runs" } });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/kaboom-runs/);
  });

  it("500 when supabase env vars are missing", async () => {
    delete process.env.VITE_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    mockState.admin = null;
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/not configured/);
  });

  it("returns the response envelope shape { count, limit, offset, runs }", async () => {
    mockState.admin = buildAdmin({
      runs: [{ id: RUN_ID, domain: "ap", run_date: "2026-05-29", status: "clean", totals_jsonb: {} }],
    });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty("count");
    expect(res.body).toHaveProperty("limit");
    expect(res.body).toHaveProperty("offset");
    expect(res.body).toHaveProperty("runs");
    expect(Array.isArray(res.body.runs)).toBe(true);
  });
});
