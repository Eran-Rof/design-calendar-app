// Tangerine P12b-4 — tests for the /api/cron/walmart-settlements-weekly
// handler.
//
// Pure HTTP-gate + env-gate coverage. The end-to-end sync logic is
// covered in api/_lib/marketplaces/walmart/__tests__/sync-settlements.test.js;
// here we only verify the cron wrapper:
//   - 405 on non-GET/POST
//   - 500 when Supabase env is missing
//   - 200 + skipped when WALMART_TOKEN_ENC_KEY is missing
//   - accepts GET and POST
//   - parses ?walmart_seller_account_id, ?since, ?since_days_ago

import { describe, it, expect, afterEach } from "vitest";

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

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("walmart-settlements-weekly HTTP gates", () => {
  it("405s a non-GET/POST request", async () => {
    const mod = await import("../walmart-settlements-weekly.js");
    const req = { method: "PUT", headers: {}, url: "/api/cron/walmart-settlements-weekly" };
    const res = makeRes();
    await mod.default(req, res);
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toMatch(/GET/);
  });

  it("405s DELETE", async () => {
    const mod = await import("../walmart-settlements-weekly.js");
    const req = { method: "DELETE", headers: {}, url: "/api/cron/walmart-settlements-weekly" };
    const res = makeRes();
    await mod.default(req, res);
    expect(res.statusCode).toBe(405);
  });

  it("accepts GET", async () => {
    // No env wired → 500.
    delete process.env.VITE_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const mod = await import("../walmart-settlements-weekly.js");
    const req = { method: "GET", headers: {}, url: "/api/cron/walmart-settlements-weekly" };
    const res = makeRes();
    await mod.default(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/configured/);
  });

  it("accepts POST", async () => {
    delete process.env.VITE_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const mod = await import("../walmart-settlements-weekly.js");
    const req = { method: "POST", headers: {}, url: "/api/cron/walmart-settlements-weekly" };
    const res = makeRes();
    await mod.default(req, res);
    expect(res.statusCode).toBe(500);
  });

  it("returns 500 when Supabase env is missing", async () => {
    delete process.env.VITE_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const mod = await import("../walmart-settlements-weekly.js");
    const req = { method: "GET", headers: {}, url: "/api/cron/walmart-settlements-weekly" };
    const res = makeRes();
    await mod.default(req, res);
    expect(res.statusCode).toBe(500);
  });

  it("returns 200 + skipped when WALMART_TOKEN_ENC_KEY is missing", async () => {
    process.env.VITE_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
    delete process.env.WALMART_TOKEN_ENC_KEY;
    const mod = await import("../walmart-settlements-weekly.js");
    const req = { method: "GET", headers: {}, url: "/api/cron/walmart-settlements-weekly" };
    const res = makeRes();
    await mod.default(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.skipped).toMatch(/WALMART_TOKEN_ENC_KEY/);
  });

  it("returns 200 + skipped on POST when WALMART_TOKEN_ENC_KEY missing", async () => {
    process.env.VITE_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
    delete process.env.WALMART_TOKEN_ENC_KEY;
    const mod = await import("../walmart-settlements-weekly.js");
    const req = { method: "POST", headers: {}, url: "/api/cron/walmart-settlements-weekly" };
    const res = makeRes();
    await mod.default(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("parses ?walmart_seller_account_id from query string without throwing", async () => {
    delete process.env.VITE_SUPABASE_URL;
    const mod = await import("../walmart-settlements-weekly.js");
    const req = {
      method: "GET",
      headers: { host: "localhost" },
      url: "/api/cron/walmart-settlements-weekly?walmart_seller_account_id=11111111-2222-4333-8444-555555555555",
    };
    const res = makeRes();
    await mod.default(req, res);
    expect(res.statusCode).toBe(500);
  });

  it("parses ?since_days_ago and ?since query strings without throwing", async () => {
    delete process.env.VITE_SUPABASE_URL;
    const mod = await import("../walmart-settlements-weekly.js");
    const req = {
      method: "GET",
      headers: { host: "localhost" },
      url: "/api/cron/walmart-settlements-weekly?since_days_ago=60&since=2026-01-01T00:00:00Z",
    };
    const res = makeRes();
    await mod.default(req, res);
    expect(res.statusCode).toBe(500);  // env gate trips first
  });

  it("survives a malformed url (parsing fallback)", async () => {
    delete process.env.VITE_SUPABASE_URL;
    const mod = await import("../walmart-settlements-weekly.js");
    // Construct a URL that would throw new URL(...) without a base host.
    const req = { method: "GET", headers: {}, url: ":::garbage:::" };
    const res = makeRes();
    await mod.default(req, res);
    // Whatever happens, the env gate should still respond — no throw.
    expect([200, 500]).toContain(res.statusCode);
  });
});
