// Tangerine P12b-5 — tests for POST /api/internal/walmart/sync-returns.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockState = vi.hoisted(() => ({ admin: null }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => mockState.admin,
}));

vi.mock("../../../../_lib/marketplaces/walmart/sync-returns.js", () => ({
  runWalmartReturnsSync: vi.fn(async (_admin, opts) => ({
    started_at: "2026-05-29T05:00:00.000Z",
    finished_at: "2026-05-29T05:00:01.000Z",
    accounts: [
      {
        walmart_seller_account_id: opts?.account_id,
        returns_upserted: 1,
        credit_memos_posted: 1,
        credit_memos_already_posted: 0,
        restocks_posted: 0,
        return_errors: [],
        error: null,
      },
    ],
    total_returns_upserted: 1,
    total_credit_memos_posted: 1,
    total_return_errors: 0,
    total_errors: 0,
  })),
}));

const { default: handler } = await import("../sync-returns.js");
const { runWalmartReturnsSync } = await import(
  "../../../../_lib/marketplaces/walmart/sync-returns.js"
);

const VALID_UUID = "11111111-1111-1111-1111-111111111111";

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

function makeReq({ method = "POST", body } = {}) {
  return {
    method,
    body,
    url: "/api/internal/walmart/sync-returns",
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

describe("POST /api/internal/walmart/sync-returns", () => {
  it("405 when not POST/OPTIONS", async () => {
    const res = makeRes();
    await handler(makeReq({ method: "GET" }), res);
    expect(res.statusCode).toBe(405);
  });

  it("200 on OPTIONS preflight", async () => {
    const res = makeRes();
    await handler(makeReq({ method: "OPTIONS" }), res);
    expect(res.statusCode).toBe(200);
  });

  it("400 when walmart_seller_account_id missing", async () => {
    const res = makeRes();
    await handler(makeReq({ body: {} }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/walmart_seller_account_id/);
  });

  it("400 when walmart_seller_account_id is not a uuid", async () => {
    const res = makeRes();
    await handler(
      makeReq({ body: { walmart_seller_account_id: "not-a-uuid" } }),
      res,
    );
    expect(res.statusCode).toBe(400);
  });

  it("400 when since is not an ISO timestamp", async () => {
    const res = makeRes();
    await handler(
      makeReq({
        body: { walmart_seller_account_id: VALID_UUID, since: "yesterday" },
      }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/ISO/);
  });

  it("delegates to runWalmartReturnsSync with account_id + since", async () => {
    const res = makeRes();
    await handler(
      makeReq({
        body: {
          walmart_seller_account_id: VALID_UUID,
          since: "2026-05-01T00:00:00Z",
        },
      }),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(runWalmartReturnsSync).toHaveBeenCalledWith(expect.anything(), {
      account_id: VALID_UUID,
      since: "2026-05-01T00:00:00Z",
    });
  });

  it("accepts JSON-string body", async () => {
    const res = makeRes();
    await handler(
      makeReq({
        body: JSON.stringify({ walmart_seller_account_id: VALID_UUID }),
      }),
      res,
    );
    expect(res.statusCode).toBe(200);
  });

  it("500 when sync throws + error message bubbles up", async () => {
    runWalmartReturnsSync.mockRejectedValueOnce(new Error("downstream-boom"));
    const res = makeRes();
    await handler(
      makeReq({ body: { walmart_seller_account_id: VALID_UUID } }),
      res,
    );
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe("downstream-boom");
  });
});
