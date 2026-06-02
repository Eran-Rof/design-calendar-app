// Tests for /api/internal/faire/sync-payouts (P12c-2).
//
// Same shape as sync-orders — validator + HTTP method gates.

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
  it("accepts an empty body (full-sweep)", () => {
    const v = validateBody({});
    expect(v.error).toBeUndefined();
    expect(v.data.onlyShopId).toBe(null);
    expect(v.data.sinceOverride).toBe(null);
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

  it("accepts a valid since ISO string", () => {
    const v = validateBody({ since: "2026-04-01T00:00:00Z" });
    expect(v.error).toBeUndefined();
    expect(v.data.sinceOverride).toBe("2026-04-01T00:00:00Z");
  });

  it("rejects since when non-string", () => {
    const v = validateBody({ since: 12345 });
    expect(v.error).toMatch(/since/);
  });
});

describe("sync-payouts handler HTTP gates", () => {
  it("405s non-POST", async () => {
    const mod = await import("../sync-payouts.js");
    const handler = mod.default;
    const req = { method: "PUT", headers: {}, url: "/" };
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it("returns 200 for OPTIONS", async () => {
    const mod = await import("../sync-payouts.js");
    const handler = mod.default;
    const req = { method: "OPTIONS", headers: {}, url: "/" };
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });
});
