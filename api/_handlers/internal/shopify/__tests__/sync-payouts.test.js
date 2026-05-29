// Tangerine P11-9 — tests for /api/internal/shopify/sync-payouts.
//
// Validator + HTTP method gates. The end-to-end sync logic is exercised
// in api/_lib/shopify/__tests__/sync-payouts.test.js.

import { describe, it, expect } from "vitest";
import { validateBody } from "../sync-payouts.js";

function makeRes() {
  const headers = {};
  const res = {
    statusCode: 0,
    body: null,
    setHeader(k, v) { headers[k] = v; },
    headers,
    status(code) { res.statusCode = code; return res; },
    json(body) { res.body = body; return res; },
    end() { return res; },
  };
  return res;
}

describe("sync-payouts.validateBody", () => {
  it("accepts an empty body and defaults to all-stores / 30-day lookback", () => {
    const v = validateBody({});
    expect(v.error).toBeUndefined();
    expect(v.data.onlyShopifyStoreId).toBe(null);
    expect(v.data.sinceDaysAgo).toBe(30);
    expect(v.data.sinceOverride).toBe(null);
  });

  it("accepts a uuid shopify_store_id", () => {
    const v = validateBody({ shopify_store_id: "11111111-2222-4333-8444-555555555555" });
    expect(v.error).toBeUndefined();
    expect(v.data.onlyShopifyStoreId).toBe("11111111-2222-4333-8444-555555555555");
  });

  it("rejects a non-uuid shopify_store_id", () => {
    const v = validateBody({ shopify_store_id: "garbage" });
    expect(v.error).toMatch(/uuid/);
  });

  it("accepts since_days_ago as a positive integer", () => {
    const v = validateBody({ since_days_ago: 7 });
    expect(v.error).toBeUndefined();
    expect(v.data.sinceDaysAgo).toBe(7);
  });

  it("rejects since_days_ago when zero / negative / > 365", () => {
    expect(validateBody({ since_days_ago: 0 }).error).toMatch(/since_days_ago/);
    expect(validateBody({ since_days_ago: -1 }).error).toMatch(/since_days_ago/);
    expect(validateBody({ since_days_ago: 400 }).error).toMatch(/since_days_ago/);
  });

  it("accepts since ISO timestamp", () => {
    const v = validateBody({ since: "2026-04-01T00:00:00Z" });
    expect(v.error).toBeUndefined();
    expect(v.data.sinceOverride).toBe("2026-04-01T00:00:00Z");
  });

  it("rejects since when not a string", () => {
    const v = validateBody({ since: 12345 });
    expect(v.error).toMatch(/since/);
  });

  it("rejects non-object body", () => {
    const v = validateBody("garbage");
    expect(v.error).toMatch(/object/);
  });
});

describe("sync-payouts handler HTTP gates", () => {
  it("405s a non-POST request", async () => {
    const mod = await import("../sync-payouts.js");
    const req = { method: "PUT", headers: {}, url: "/" };
    const res = makeRes();
    await mod.default(req, res);
    expect(res.statusCode).toBe(405);
  });

  it("returns 200 for OPTIONS", async () => {
    const mod = await import("../sync-payouts.js");
    const req = { method: "OPTIONS", headers: {}, url: "/" };
    const res = makeRes();
    await mod.default(req, res);
    expect(res.statusCode).toBe(200);
  });

  it("returns 400 on invalid JSON body string", async () => {
    process.env.VITE_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
    const mod = await import("../sync-payouts.js");
    const req = { method: "POST", headers: {}, url: "/", body: "{not json" };
    const res = makeRes();
    await mod.default(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/JSON/i);
  });

  it("returns 400 on invalid validateBody result", async () => {
    process.env.VITE_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
    const mod = await import("../sync-payouts.js");
    const req = { method: "POST", headers: {}, url: "/", body: { shopify_store_id: "garbage" } };
    const res = makeRes();
    await mod.default(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/uuid/);
  });
});
