// Tests for Tangerine P12b-2 — POST /api/internal/walmart/sync-orders.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockState = vi.hoisted(() => ({ admin: null }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => mockState.admin,
}));

vi.mock("../../../../cron/walmart-orders-nightly.js", () => ({
  runWalmartOrdersNightly: vi.fn(async (_admin, opts) => ({
    started_at: "2026-05-28T00:00:00.000Z",
    finished_at: "2026-05-28T00:00:01.000Z",
    accounts: [{ walmart_seller_account_id: opts?.account_id, orders_upserted: 1, items_upserted: 1, error: null }],
    total_orders_upserted: 1,
    total_items_upserted: 1,
    total_errors: 0,
  })),
}));

const { default: handler } = await import("../sync-orders.js");
const { runWalmartOrdersNightly } = await import("../../../../cron/walmart-orders-nightly.js");

const VALID_UUID = "11111111-1111-1111-1111-111111111111";

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

function makeReq({ method = "POST", body } = {}) {
  return { method, body, url: "/api/internal/walmart/sync-orders", headers: { host: "localhost" } };
}

beforeEach(() => {
  process.env.VITE_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
  mockState.admin = {};
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/internal/walmart/sync-orders", () => {
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
    await handler(makeReq({ body: { walmart_seller_account_id: "not-a-uuid" } }), res);
    expect(res.statusCode).toBe(400);
  });

  it("400 when since is not an ISO timestamp", async () => {
    const res = makeRes();
    await handler(makeReq({
      body: { walmart_seller_account_id: VALID_UUID, since: "yesterday" },
    }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/ISO/);
  });

  it("500 when server is not configured", async () => {
    delete process.env.VITE_SUPABASE_URL;
    const res = makeRes();
    await handler(makeReq({ body: { walmart_seller_account_id: VALID_UUID } }), res);
    expect(res.statusCode).toBe(500);
  });

  it("delegates to runWalmartOrdersNightly with account_id + since", async () => {
    const res = makeRes();
    await handler(makeReq({
      body: { walmart_seller_account_id: VALID_UUID, since: "2026-05-01T00:00:00Z" },
    }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(runWalmartOrdersNightly).toHaveBeenCalledWith(
      expect.anything(),
      { account_id: VALID_UUID, since: "2026-05-01T00:00:00Z" },
    );
  });

  it("accepts JSON-string body", async () => {
    const res = makeRes();
    await handler(makeReq({
      body: JSON.stringify({ walmart_seller_account_id: VALID_UUID }),
    }), res);
    expect(res.statusCode).toBe(200);
  });

  it("400 on invalid JSON string body", async () => {
    const res = makeRes();
    await handler(makeReq({ body: "{not json" }), res);
    expect(res.statusCode).toBe(400);
  });

  it("500 when the orchestrator throws", async () => {
    runWalmartOrdersNightly.mockRejectedValueOnce(new Error("boom"));
    const res = makeRes();
    await handler(makeReq({ body: { walmart_seller_account_id: VALID_UUID } }), res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/boom/);
  });
});
