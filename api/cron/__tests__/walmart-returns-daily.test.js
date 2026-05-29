// Tangerine P12b-5 — tests for the Walmart returns daily cron handler.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockState = vi.hoisted(() => ({ admin: null }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => mockState.admin,
}));

vi.mock("../../_lib/marketplaces/walmart/sync-returns.js", () => ({
  runWalmartReturnsSync: vi.fn(async () => ({
    started_at: "2026-05-29T05:00:00.000Z",
    finished_at: "2026-05-29T05:00:01.000Z",
    accounts: [
      {
        walmart_seller_account_id: "11111111-1111-1111-1111-111111111111",
        returns_upserted: 2,
        credit_memos_posted: 2,
        credit_memos_already_posted: 0,
        restocks_posted: 1,
        return_errors: [],
        error: null,
      },
    ],
    total_returns_upserted: 2,
    total_credit_memos_posted: 2,
    total_credit_memos_already_posted: 0,
    total_restocks_posted: 1,
    total_return_errors: 0,
    total_errors: 0,
  })),
}));

const { default: handler } = await import("../walmart-returns-daily.js");
const { runWalmartReturnsSync } = await import(
  "../../_lib/marketplaces/walmart/sync-returns.js"
);

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    end() {
      return this;
    },
  };
}

function makeReq({ method = "GET" } = {}) {
  return {
    method,
    url: "/api/cron/walmart-returns-daily",
    headers: { host: "localhost" },
  };
}

beforeEach(() => {
  process.env.VITE_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  mockState.admin = {};
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET/POST /api/cron/walmart-returns-daily", () => {
  it("405 when method is DELETE", async () => {
    const res = makeRes();
    await handler(makeReq({ method: "DELETE" }), res);
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe("GET, POST");
  });

  it("405 when method is PUT", async () => {
    const res = makeRes();
    await handler(makeReq({ method: "PUT" }), res);
    expect(res.statusCode).toBe(405);
  });

  it("500 when server is not configured (missing SB_URL)", async () => {
    delete process.env.VITE_SUPABASE_URL;
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/configured/);
  });

  it("500 when server is not configured (missing SERVICE_KEY)", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(500);
  });

  it("200 on GET happy path", async () => {
    const res = makeRes();
    await handler(makeReq({ method: "GET" }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.total_returns_upserted).toBe(2);
  });

  it("200 on POST happy path", async () => {
    const res = makeRes();
    await handler(makeReq({ method: "POST" }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("delegates to runWalmartReturnsSync without account_id (full-fleet run)", async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect(runWalmartReturnsSync).toHaveBeenCalledTimes(1);
    // Cron does NOT pass opts.account_id — it runs across all accounts.
    expect(runWalmartReturnsSync.mock.calls[0][1]).toBeUndefined();
  });

  it("500 with error message when sync throws", async () => {
    runWalmartReturnsSync.mockRejectedValueOnce(new Error("boom"));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe("boom");
  });

  it("propagates summary fields from sync result", async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.body.total_credit_memos_posted).toBe(2);
    expect(res.body.total_restocks_posted).toBe(1);
    expect(res.body.accounts.length).toBe(1);
  });
});
