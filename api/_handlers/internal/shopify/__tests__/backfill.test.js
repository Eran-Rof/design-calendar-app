// Tangerine P11-4 — tests for /api/internal/shopify/backfill handler.
//
// Coverage:
//   - 401 when INTERNAL_API_TOKEN set + caller presents no token
//   - 405 on non-POST methods
//   - 400 when body.since_hours_ago is non-positive / non-numeric
//   - 200 happy path returns orchestrator summary
//   - default since_hours_ago=7 when body missing
//   - 500 when orchestrator throws

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../../_lib/shopify/backfill-orders.js", () => ({
  backfillShopifyOrders: vi.fn(),
}));

import handler from "../backfill.js";
import { backfillShopifyOrders } from "../../../../_lib/shopify/backfill-orders.js";

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end() { this.body = ""; return this; },
  };
}

function makeReq({ method = "POST", headers = {}, body = {} } = {}) {
  return { method, headers, body };
}

const ENV_KEYS = ["VITE_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "INTERNAL_API_TOKEN"];
const saved = {};

describe("/api/internal/shopify/backfill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.VITE_SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
    delete process.env.INTERNAL_API_TOKEN;
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("returns 200 with summary on happy path (default since=7)", async () => {
    backfillShopifyOrders.mockResolvedValue({
      since: "2026-05-28T05:00:00.000Z",
      stores_processed: 1,
      orders_upserted: 4,
      jes_posted: 4,
      jes_already_posted: 0,
      errors: [],
      per_store: [],
    });
    const req = makeReq({ body: {} });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.orders_upserted).toBe(4);
    expect(backfillShopifyOrders).toHaveBeenCalledWith(
      expect.objectContaining({ sinceHoursAgo: 7 }),
    );
  });

  it("honors body.since_hours_ago override", async () => {
    backfillShopifyOrders.mockResolvedValue({ stores_processed: 0, orders_upserted: 0, jes_posted: 0, jes_already_posted: 0, errors: [], per_store: [] });
    const req = makeReq({ body: { since_hours_ago: 24 } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(backfillShopifyOrders).toHaveBeenCalledWith(
      expect.objectContaining({ sinceHoursAgo: 24 }),
    );
  });

  it("returns 400 on non-positive since_hours_ago", async () => {
    const req = makeReq({ body: { since_hours_ago: 0 } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/positive/);
    expect(backfillShopifyOrders).not.toHaveBeenCalled();
  });

  it("returns 400 on non-numeric since_hours_ago", async () => {
    const req = makeReq({ body: { since_hours_ago: "abc" } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("returns 401 when INTERNAL_API_TOKEN set and no token presented", async () => {
    process.env.INTERNAL_API_TOKEN = "secret-shh";
    const req = makeReq({ body: {} });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(backfillShopifyOrders).not.toHaveBeenCalled();
  });

  it("accepts correct Bearer token + proceeds", async () => {
    process.env.INTERNAL_API_TOKEN = "good-token";
    backfillShopifyOrders.mockResolvedValue({ stores_processed: 1, orders_upserted: 0, jes_posted: 0, jes_already_posted: 0, errors: [], per_store: [] });
    const req = makeReq({
      headers: { authorization: "Bearer good-token" },
      body: {},
    });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it("returns 405 on GET", async () => {
    const req = makeReq({ method: "GET" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
    expect(res.headers["Allow"]).toBe("POST");
  });

  it("returns 200 on OPTIONS preflight", async () => {
    const req = makeReq({ method: "OPTIONS" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it("returns 500 when orchestrator throws", async () => {
    backfillShopifyOrders.mockRejectedValue(new Error("upstream down"));
    const req = makeReq({ body: {} });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe("upstream down");
  });
});
