// Tangerine P11-6 — tests for /api/cron/shopify-refunds-backfill handler.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../_lib/shopify/backfill-refunds.js", () => ({
  backfillShopifyRefunds: vi.fn(),
}));

import handler from "../shopify-refunds-backfill.js";
import { backfillShopifyRefunds } from "../../_lib/shopify/backfill-refunds.js";

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

function makeReq({ method = "GET", headers = {}, url = "/api/cron/shopify-refunds-backfill" } = {}) {
  return { method, headers, url };
}

const ENV_KEYS = ["VITE_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "CRON_SECRET"];
const saved = {};

describe("/api/cron/shopify-refunds-backfill", () => {
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
    backfillShopifyRefunds.mockResolvedValue({
      since: "2026-04-29T06:30:00.000Z",
      stores_processed: 2,
      refunds_upserted: 4,
      refunds_processed: 3,
      refunds_already_processed: 1,
      errors: [],
      per_store: [],
    });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.refunds_processed).toBe(3);
    expect(backfillShopifyRefunds).toHaveBeenCalledWith(
      expect.objectContaining({ sinceHoursAgo: 720 }),
    );
  });

  it("auth: x-vercel-cron header allowed", async () => {
    process.env.CRON_SECRET = "secret-xyz";
    backfillShopifyRefunds.mockResolvedValue({ stores_processed: 0, refunds_upserted: 0, refunds_processed: 0, refunds_already_processed: 0, errors: [], per_store: [] });
    const res = makeRes();
    await handler(makeReq({ headers: { "x-vercel-cron": "1" } }), res);
    expect(res.statusCode).toBe(200);
  });

  it("auth: Bearer CRON_SECRET allowed", async () => {
    process.env.CRON_SECRET = "secret-xyz";
    backfillShopifyRefunds.mockResolvedValue({ stores_processed: 0, refunds_upserted: 0, refunds_processed: 0, refunds_already_processed: 0, errors: [], per_store: [] });
    const res = makeRes();
    await handler(makeReq({ headers: { authorization: "Bearer secret-xyz" } }), res);
    expect(res.statusCode).toBe(200);
  });

  it("auth: rejects wrong token", async () => {
    process.env.CRON_SECRET = "secret-xyz";
    const res = makeRes();
    await handler(makeReq({ headers: { authorization: "Bearer wrong" } }), res);
    expect(res.statusCode).toBe(401);
    expect(backfillShopifyRefunds).not.toHaveBeenCalled();
  });

  it("returns 405 on PUT", async () => {
    const res = makeRes();
    await handler(makeReq({ method: "PUT" }), res);
    expect(res.statusCode).toBe(405);
  });

  it("returns 200 on OPTIONS preflight", async () => {
    const res = makeRes();
    await handler(makeReq({ method: "OPTIONS" }), res);
    expect(res.statusCode).toBe(200);
  });

  it("returns 500 when SB env unset", async () => {
    delete process.env.VITE_SUPABASE_URL;
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(500);
  });

  it("returns 500 + error when orchestrator throws", async () => {
    backfillShopifyRefunds.mockRejectedValue(new Error("rate limited"));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe("rate limited");
  });

  it("honors ?since_hours_ago override", async () => {
    backfillShopifyRefunds.mockResolvedValue({ stores_processed: 0, refunds_upserted: 0, refunds_processed: 0, refunds_already_processed: 0, errors: [], per_store: [] });
    const res = makeRes();
    await handler(makeReq({ url: "/api/cron/shopify-refunds-backfill?since_hours_ago=48" }), res);
    expect(backfillShopifyRefunds).toHaveBeenCalledWith(
      expect.objectContaining({ sinceHoursAgo: 48 }),
    );
  });
});
