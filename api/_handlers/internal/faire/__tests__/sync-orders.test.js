// Tests for /api/internal/faire/sync-orders (P12c-2).
//
// The handler just unwraps the body, parses + validates faire_shop_id /
// since, and delegates to runFaireOrdersIngest. We exercise the validator
// directly and the HTTP method gate via a mocked res object.

import { describe, it, expect } from "vitest";
import { validateBody } from "../sync-orders.js";

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

describe("sync-orders.validateBody", () => {
  it("accepts an empty body", () => {
    const v = validateBody({});
    expect(v.error).toBeUndefined();
    expect(v.data.onlyShopId).toBe(null);
    expect(v.data.sinceOverride).toBe(null);
  });

  it("accepts a valid uuid faire_shop_id", () => {
    const v = validateBody({ faire_shop_id: "00000000-0000-4000-8000-000000000001" });
    expect(v.error).toBeUndefined();
    expect(v.data.onlyShopId).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("rejects a non-uuid faire_shop_id", () => {
    const v = validateBody({ faire_shop_id: "not-a-uuid" });
    expect(v.error).toMatch(/uuid/);
  });

  it("accepts a valid since string", () => {
    const v = validateBody({ since: "2026-05-01T00:00:00Z" });
    expect(v.error).toBeUndefined();
    expect(v.data.sinceOverride).toBe("2026-05-01T00:00:00Z");
  });

  it("rejects an empty since string", () => {
    const v = validateBody({ since: "" });
    expect(v.error).toMatch(/since/);
  });

  it("rejects non-object body", () => {
    const v = validateBody("not an object");
    expect(v.error).toMatch(/object/);
  });
});

describe("sync-orders handler HTTP gates", () => {
  it("405s non-POST", async () => {
    const mod = await import("../sync-orders.js");
    const handler = mod.default;
    const req = { method: "GET", headers: {}, url: "/" };
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it("returns 200 for OPTIONS (CORS preflight)", async () => {
    const mod = await import("../sync-orders.js");
    const handler = mod.default;
    const req = { method: "OPTIONS", headers: {}, url: "/" };
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.headers["Access-Control-Allow-Methods"]).toMatch(/POST/);
  });
});
