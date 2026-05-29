// Tangerine P11-4 — tests for /api/cron/shopify-backfill handler.
//
// Coverage:
//   - auth: x-vercel-cron header passes
//   - auth: Authorization Bearer CRON_SECRET passes
//   - auth: wrong/missing token → 401 when CRON_SECRET set
//   - auth: soft-open (no CRON_SECRET) → 200
//   - 405 on unsupported methods
//   - happy path: returns the orchestrator summary
//   - no-store empty path: stores_processed=0
//   - 500 when SB env unset
//   - since_hours_ago query override is honored

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../_lib/shopify/backfill-orders.js", () => ({
  backfillShopifyOrders: vi.fn(),
}));

import handler from "../shopify-backfill.js";
import { backfillShopifyOrders } from "../../_lib/shopify/backfill-orders.js";

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

function makeReq({ method = "GET", headers = {}, url = "/api/cron/shopify-backfill" } = {}) {
  return { method, headers, url };
}

const ENV_KEYS = ["VITE_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "CRON_SECRET"];
const saved = {};

describe("/api/cron/shopify-backfill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.VITE_SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
    delete process.env.CRON_SECRET;
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("returns 200 + orchestrator summary on happy path", async () => {
    backfillShopifyOrders.mockResolvedValue({
      since: "2026-05-28T05:00:00.000Z",
      stores_processed: 2,
      orders_upserted: 5,
      jes_posted: 3,
      jes_already_posted: 2,
      errors: [],
      per_store: [],
    });
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.stores_processed).toBe(2);
    expect(res.body.orders_upserted).toBe(5);
    expect(res.body.jes_posted).toBe(3);
    expect(backfillShopifyOrders).toHaveBeenCalledWith(
      expect.objectContaining({ sinceHoursAgo: 7 }),
    );
  });

  it("returns 200 with zeroed summary when no stores", async () => {
    backfillShopifyOrders.mockResolvedValue({
      since: "2026-05-28T05:00:00.000Z",
      stores_processed: 0,
      orders_upserted: 0,
      jes_posted: 0,
      jes_already_posted: 0,
      errors: [],
      per_store: [],
    });
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.stores_processed).toBe(0);
    expect(res.body.per_store).toEqual([]);
  });

  it("auth: allows when x-vercel-cron header present (CRON_SECRET set)", async () => {
    process.env.CRON_SECRET = "secret-xyz";
    backfillShopifyOrders.mockResolvedValue({ stores_processed: 0, orders_upserted: 0, jes_posted: 0, jes_already_posted: 0, errors: [], per_store: [] });
    const req = makeReq({ headers: { "x-vercel-cron": "1" } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it("auth: allows correct Bearer CRON_SECRET", async () => {
    process.env.CRON_SECRET = "secret-xyz";
    backfillShopifyOrders.mockResolvedValue({ stores_processed: 0, orders_upserted: 0, jes_posted: 0, jes_already_posted: 0, errors: [], per_store: [] });
    const req = makeReq({ headers: { authorization: "Bearer secret-xyz" } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it("auth: rejects wrong token with 401", async () => {
    process.env.CRON_SECRET = "secret-xyz";
    const req = makeReq({ headers: { authorization: "Bearer wrong" } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(backfillShopifyOrders).not.toHaveBeenCalled();
  });

  it("auth: soft-open (no CRON_SECRET) → no 401", async () => {
    backfillShopifyOrders.mockResolvedValue({ stores_processed: 0, orders_upserted: 0, jes_posted: 0, jes_already_posted: 0, errors: [], per_store: [] });
    const req = makeReq({ headers: {} });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it("returns 405 on PUT/DELETE", async () => {
    const req = makeReq({ method: "PUT" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
    expect(res.headers["Allow"]).toMatch(/GET, POST/);
  });

  it("returns 200 on OPTIONS preflight", async () => {
    const req = makeReq({ method: "OPTIONS" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it("returns 500 when SB env not configured", async () => {
    delete process.env.VITE_SUPABASE_URL;
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/configured/i);
  });

  it("returns 500 + error message when orchestrator throws", async () => {
    backfillShopifyOrders.mockRejectedValue(new Error("boom"));
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe("boom");
  });

  it("honors ?since_hours_ago= override", async () => {
    backfillShopifyOrders.mockResolvedValue({ stores_processed: 0, orders_upserted: 0, jes_posted: 0, jes_already_posted: 0, errors: [], per_store: [] });
    const req = makeReq({ url: "/api/cron/shopify-backfill?since_hours_ago=24" });
    const res = makeRes();
    await handler(req, res);
    expect(backfillShopifyOrders).toHaveBeenCalledWith(
      expect.objectContaining({ sinceHoursAgo: 24 }),
    );
  });

  it("ignores invalid since_hours_ago query param and uses default", async () => {
    backfillShopifyOrders.mockResolvedValue({ stores_processed: 0, orders_upserted: 0, jes_posted: 0, jes_already_posted: 0, errors: [], per_store: [] });
    const req = makeReq({ url: "/api/cron/shopify-backfill?since_hours_ago=abc" });
    const res = makeRes();
    await handler(req, res);
    expect(backfillShopifyOrders).toHaveBeenCalledWith(
      expect.objectContaining({ sinceHoursAgo: 7 }),
    );
  });
});
