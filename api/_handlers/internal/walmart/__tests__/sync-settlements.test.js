// Tangerine P12b-4 — tests for POST /api/internal/walmart/sync-settlements
// (the manual-trigger handler).

import { describe, it, expect, afterEach } from "vitest";
import { validateBody } from "../sync-settlements.js";

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

const VALID_UUID = "11111111-1111-1111-1111-111111111111";

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("validateBody", () => {
  it("accepts an empty body (defaults)", () => {
    const v = validateBody({});
    expect(v.error).toBeUndefined();
    expect(v.data.onlyAccountId).toBe(null);
    expect(v.data.sinceDaysAgo).toBe(30);
    expect(v.data.sinceOverride).toBe(null);
  });

  it("rejects a non-object body", () => {
    const v = validateBody("hello");
    expect(v.error).toMatch(/object/);
  });

  it("rejects non-uuid walmart_seller_account_id", () => {
    const v = validateBody({ walmart_seller_account_id: "not-a-uuid" });
    expect(v.error).toMatch(/uuid/);
  });

  it("accepts a valid uuid", () => {
    const v = validateBody({ walmart_seller_account_id: VALID_UUID });
    expect(v.error).toBeUndefined();
    expect(v.data.onlyAccountId).toBe(VALID_UUID);
  });

  it("rejects a negative since_days_ago", () => {
    const v = validateBody({ since_days_ago: -1 });
    expect(v.error).toMatch(/positive/);
  });

  it("rejects a non-integer since_days_ago", () => {
    const v = validateBody({ since_days_ago: 1.5 });
    expect(v.error).toMatch(/positive/);
  });

  it("rejects since_days_ago > 365", () => {
    const v = validateBody({ since_days_ago: 400 });
    expect(v.error).toMatch(/365/);
  });

  it("accepts a valid integer since_days_ago", () => {
    const v = validateBody({ since_days_ago: 90 });
    expect(v.data.sinceDaysAgo).toBe(90);
  });

  it("rejects empty since string", () => {
    const v = validateBody({ since: "" });
    expect(v.error).toMatch(/ISO/);
  });

  it("accepts a since string", () => {
    const v = validateBody({ since: "2026-05-01T00:00:00Z" });
    expect(v.data.sinceOverride).toBe("2026-05-01T00:00:00Z");
  });
});

describe("POST /api/internal/walmart/sync-settlements HTTP gates", () => {
  it("405s a GET request", async () => {
    const mod = await import("../sync-settlements.js");
    const req = { method: "GET", headers: {}, url: "/api/internal/walmart/sync-settlements" };
    const res = makeRes();
    await mod.default(req, res);
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toMatch(/POST/);
  });

  it("200 + ends on OPTIONS preflight", async () => {
    const mod = await import("../sync-settlements.js");
    const req = { method: "OPTIONS", headers: {}, url: "/api/internal/walmart/sync-settlements" };
    const res = makeRes();
    await mod.default(req, res);
    expect(res.statusCode).toBe(200);
  });

  it("500 when Supabase env missing", async () => {
    delete process.env.VITE_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const mod = await import("../sync-settlements.js");
    const req = { method: "POST", headers: {}, url: "/api/internal/walmart/sync-settlements", body: {} };
    const res = makeRes();
    await mod.default(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/configured/);
  });

  it("400 on invalid uuid in body", async () => {
    process.env.VITE_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
    const mod = await import("../sync-settlements.js");
    const req = {
      method: "POST", headers: {}, url: "/api/internal/walmart/sync-settlements",
      body: { walmart_seller_account_id: "not-a-uuid" },
    };
    const res = makeRes();
    await mod.default(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("400 on malformed JSON body string", async () => {
    process.env.VITE_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
    const mod = await import("../sync-settlements.js");
    const req = {
      method: "POST", headers: {}, url: "/api/internal/walmart/sync-settlements",
      body: "{ not valid json",
    };
    const res = makeRes();
    await mod.default(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/JSON/);
  });

  it("sets CORS headers", async () => {
    const mod = await import("../sync-settlements.js");
    const req = { method: "OPTIONS", headers: {}, url: "/api/internal/walmart/sync-settlements" };
    const res = makeRes();
    await mod.default(req, res);
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("*");
    expect(res.headers["Access-Control-Allow-Methods"]).toMatch(/POST/);
  });
});
