// Tests for /api/internal/faire/sync-returns (P12c-4 manual trigger).

import { describe, it, expect, beforeEach } from "vitest";
import { validateBody } from "../sync-returns.js";

function makeRes() {
  const headers = {};
  const res = {
    statusCode: 0, body: null,
    setHeader(k, v) { headers[k] = v; },
    headers,
    status(code) { res.statusCode = code; return res; },
    json(body) { res.body = body; return res; },
    end() { return res; },
  };
  return res;
}

describe("sync-returns.validateBody", () => {
  it("accepts an empty body (full sweep)", () => {
    const v = validateBody({});
    expect(v.error).toBeUndefined();
    expect(v.data.onlyShopId).toBe(null);
    expect(v.data.sinceOverride).toBe(null);
  });

  it("accepts null body", () => {
    const v = validateBody(null);
    expect(v.error).toBeUndefined();
    expect(v.data.onlyShopId).toBe(null);
  });

  it("accepts a uuid faire_shop_id", () => {
    const v = validateBody({ faire_shop_id: "11111111-2222-4333-8444-555555555555" });
    expect(v.error).toBeUndefined();
    expect(v.data.onlyShopId).toBe("11111111-2222-4333-8444-555555555555");
  });

  it("rejects a malformed uuid", () => {
    const v = validateBody({ faire_shop_id: "garbage" });
    expect(v.error).toMatch(/uuid/);
  });

  it("rejects non-string faire_shop_id", () => {
    const v = validateBody({ faire_shop_id: 12345 });
    expect(v.error).toMatch(/uuid/);
  });

  it("accepts a valid since ISO string", () => {
    const v = validateBody({ since: "2026-04-01T00:00:00Z" });
    expect(v.error).toBeUndefined();
    expect(v.data.sinceOverride).toBe("2026-04-01T00:00:00Z");
  });

  it("rejects since when non-string", () => {
    const v = validateBody({ since: 12345 });
    expect(v.error).toMatch(/since/);
  });

  it("rejects since when empty string", () => {
    const v = validateBody({ since: "" });
    expect(v.error).toMatch(/since/);
  });

  it("rejects non-object body", () => {
    const v = validateBody("garbage");
    expect(v.error).toMatch(/object/);
  });
});

describe("sync-returns handler HTTP gates", () => {
  beforeEach(() => {
    delete process.env.VITE_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  it("405s non-POST", async () => {
    const mod = await import("../sync-returns.js");
    const handler = mod.default;
    const req = { method: "PUT", headers: {}, url: "/" };
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it("returns 200 for OPTIONS (CORS preflight)", async () => {
    const mod = await import("../sync-returns.js");
    const handler = mod.default;
    const req = { method: "OPTIONS", headers: {}, url: "/" };
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it("sets CORS headers on response", async () => {
    const mod = await import("../sync-returns.js");
    const handler = mod.default;
    const req = { method: "OPTIONS", headers: {}, url: "/" };
    const res = makeRes();
    await handler(req, res);
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("*");
    expect(res.headers["Access-Control-Allow-Methods"]).toMatch(/POST/);
    expect(res.headers["Access-Control-Allow-Headers"]).toMatch(/X-Entity-ID/);
  });

  it("returns 500 when Supabase env not configured", async () => {
    const mod = await import("../sync-returns.js");
    const handler = mod.default;
    const req = { method: "POST", headers: {}, url: "/", body: {} };
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/configured/i);
  });

  it("returns 400 on invalid JSON string body", async () => {
    process.env.VITE_SUPABASE_URL = "https://x.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "k";
    const mod = await import("../sync-returns.js");
    const handler = mod.default;
    const req = { method: "POST", headers: {}, url: "/", body: "{not-json" };
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/json/i);
  });

  it("returns 400 on malformed faire_shop_id in body", async () => {
    process.env.VITE_SUPABASE_URL = "https://x.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "k";
    const mod = await import("../sync-returns.js");
    const handler = mod.default;
    const req = { method: "POST", headers: {}, url: "/", body: { faire_shop_id: "bad" } };
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("declares maxDuration of 300", async () => {
    const mod = await import("../sync-returns.js");
    expect(mod.config).toEqual({ maxDuration: 300 });
  });
});

describe("routes.js wiring (P12c-4)", () => {
  it("registers POST /api/internal/faire/sync-returns + GET /api/cron/faire-returns-weekly", async () => {
    const mod = await import("../../../routes.js");
    const paths = mod.ROUTES.map((r) => r.pattern);
    expect(paths).toContain("/api/internal/faire/sync-returns");
    expect(paths).toContain("/api/cron/faire-returns-weekly");
  });
});
