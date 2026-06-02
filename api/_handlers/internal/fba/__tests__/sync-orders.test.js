// Tests for POST /api/internal/fba/sync-orders (P12a-2).

import { describe, it, expect } from "vitest";
import { validateBody } from "../sync-orders.js";

describe("validateBody", () => {
  it("rejects non-object body", () => {
    expect(validateBody(null).error).toMatch(/object/);
    expect(validateBody("x").error).toMatch(/object/);
  });

  it("requires fba_seller_account_id (uuid)", () => {
    expect(validateBody({}).error).toMatch(/fba_seller_account_id/);
    expect(validateBody({ fba_seller_account_id: "not-a-uuid" }).error).toMatch(/uuid/);
  });

  it("accepts a valid uuid with no since", () => {
    const r = validateBody({ fba_seller_account_id: "11111111-1111-1111-1111-111111111111" });
    expect(r.error).toBeUndefined();
    expect(r.data.fba_seller_account_id).toBe("11111111-1111-1111-1111-111111111111");
    expect(r.data.since).toBeNull();
  });

  it("accepts a valid since ISO timestamp", () => {
    const r = validateBody({
      fba_seller_account_id: "11111111-1111-1111-1111-111111111111",
      since: "2026-05-01T00:00:00Z",
    });
    expect(r.error).toBeUndefined();
    expect(r.data.since).toBe("2026-05-01T00:00:00Z");
  });

  it("rejects an invalid since string", () => {
    const r = validateBody({
      fba_seller_account_id: "11111111-1111-1111-1111-111111111111",
      since: "yesterday",
    });
    expect(r.error).toMatch(/ISO/);
  });
});

describe("handler — wired e2e shape", () => {
  // We test the handler by importing it and invoking with a tiny req/res
  // pair. This is the same pattern the other internal/* tests use.
  async function callHandler(body, method = "POST") {
    process.env.VITE_SUPABASE_URL = "http://localhost:54321";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key";
    const mod = await import("../sync-orders.js");
    const handler = mod.default;
    let status = 0;
    let json = null;
    const res = {
      _hdrs: {},
      setHeader(k, v) { this._hdrs[k] = v; },
      status(s) { status = s; return this; },
      json(j) { json = j; return this; },
      end() { return this; },
    };
    const req = { method, body };
    await handler(req, res);
    return { status, json };
  }

  it("returns 405 on non-POST", async () => {
    const { status } = await callHandler(null, "GET");
    expect(status).toBe(405);
  });

  it("returns 400 on missing body", async () => {
    const { status, json } = await callHandler({});
    expect(status).toBe(400);
    expect(json.error).toMatch(/fba_seller_account_id/);
  });

  it("returns 400 on invalid since", async () => {
    const { status } = await callHandler({
      fba_seller_account_id: "11111111-1111-1111-1111-111111111111",
      since: "garbage",
    });
    expect(status).toBe(400);
  });

  it("returns 200 OK on OPTIONS", async () => {
    const { status } = await callHandler(null, "OPTIONS");
    expect(status).toBe(200);
  });
});
