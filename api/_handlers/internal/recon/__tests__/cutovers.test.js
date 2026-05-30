// Tangerine P9-7 — tests for GET /api/internal/recon/cutovers (D8 sign-offs).
//
// Covers parseCutoversQuery validator + the HTTP handler (auth, domain
// filter, response envelope shape, 500 on supabase error).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockState = vi.hoisted(() => ({ admin: null }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => mockState.admin,
}));

const {
  default: handler,
  parseCutoversQuery,
} = await import("../cutovers.js");

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

function makeReq({ method = "GET", url = "/api/internal/recon/cutovers", headers = {} } = {}) {
  return {
    method,
    headers: { host: "localhost", ...headers },
    url,
  };
}

function buildAdmin({ cutovers = [], selectError = null } = {}) {
  return {
    from(table) {
      if (table !== "recon_cutover_signoffs") throw new Error(`unexpected table: ${table}`);
      const state = { filters: [], rangeFrom: 0, rangeTo: 999 };
      const builder = {
        select() { return builder; },
        order() { return builder; },
        range(from, to) { state.rangeFrom = from; state.rangeTo = to; return builder; },
        eq(col, val) { state.filters.push([col, val]); return builder; },
        then(resolve, reject) {
          if (selectError) {
            return Promise.resolve({ data: null, error: selectError }).then(resolve, reject);
          }
          const rows = cutovers.filter((r) => {
            for (const [col, v] of state.filters) {
              if (r[col] !== v) return false;
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
// parseCutoversQuery (pure)
// ────────────────────────────────────────────────────────────────────────
describe("parseCutoversQuery", () => {
  it("returns defaults when no params provided", () => {
    const r = parseCutoversQuery({});
    expect(r.data.domain).toBeNull();
    expect(r.data.source_tag).toBeNull();
    expect(r.data.limit).toBe(200);
    expect(r.data.offset).toBe(0);
  });

  it("accepts a valid domain", () => {
    expect(parseCutoversQuery({ domain: "ap" }).data.domain).toBe("ap");
    expect(parseCutoversQuery({ domain: "inventory" }).data.domain).toBe("inventory");
  });

  it("rejects an invalid domain", () => {
    expect(parseCutoversQuery({ domain: "weird" }).error).toMatch(/domain/);
  });

  it("clamps oversized limit to 1000", () => {
    expect(parseCutoversQuery({ limit: "5000" }).data.limit).toBe(1000);
  });

  it("rejects negative offset", () => {
    expect(parseCutoversQuery({ offset: "-1" }).error).toMatch(/offset/);
  });

  it("accepts a free-form source_tag", () => {
    expect(parseCutoversQuery({ source_tag: "xoro_mirror" }).data.source_tag).toBe("xoro_mirror");
  });
});

// ────────────────────────────────────────────────────────────────────────
// HTTP handler
// ────────────────────────────────────────────────────────────────────────
describe("GET /api/internal/recon/cutovers handler", () => {
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

  it("400 on invalid domain query param", async () => {
    const res = makeRes();
    await handler(
      makeReq({ url: "/api/internal/recon/cutovers?domain=weird" }),
      res,
    );
    expect(res.statusCode).toBe(400);
  });

  it("200 with empty result when no rows", async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.count).toBe(0);
    expect(res.body.cutovers).toEqual([]);
    expect(res.body.limit).toBe(200);
    expect(res.body.offset).toBe(0);
  });

  it("filters by domain when provided", async () => {
    mockState.admin = buildAdmin({
      cutovers: [
        { id: "c1", domain: "ap", source_tag: null, clean_window_start: "2026-01-01",
          clean_window_end: "2026-04-30", total_recons: 120, signoff_at: "2026-05-01T00:00:00Z" },
        { id: "c2", domain: "ar", source_tag: null, clean_window_start: "2026-01-01",
          clean_window_end: "2026-04-30", total_recons: 100, signoff_at: "2026-05-01T00:00:00Z" },
      ],
    });
    const res = makeRes();
    await handler(
      makeReq({ url: "/api/internal/recon/cutovers?domain=ap" }),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.cutovers[0].domain).toBe("ap");
  });

  it("500 on supabase select error", async () => {
    mockState.admin = buildAdmin({ selectError: { message: "kaboom-cutover" } });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/kaboom-cutover/);
  });

  it("response envelope shape is { count, limit, offset, cutovers }", async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.body).toHaveProperty("count");
    expect(res.body).toHaveProperty("limit");
    expect(res.body).toHaveProperty("offset");
    expect(res.body).toHaveProperty("cutovers");
    expect(Array.isArray(res.body.cutovers)).toBe(true);
  });
});
