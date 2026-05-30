// Tests for POST /api/internal/fba/mirror-inventory (P12a-5).

import { describe, it, expect } from "vitest";
import { validateBody } from "../mirror-inventory.js";

describe("validateBody", () => {
  it("accepts empty body (= all accounts mode)", () => {
    const r = validateBody({});
    expect(r.error).toBeUndefined();
    expect(r.data.fba_seller_account_id).toBeNull();
  });

  it("accepts null body (= all accounts mode)", () => {
    const r = validateBody(null);
    expect(r.error).toBeUndefined();
    expect(r.data.fba_seller_account_id).toBeNull();
  });

  it("rejects non-object body", () => {
    expect(validateBody("x").error).toMatch(/object/);
  });

  it("accepts a valid uuid", () => {
    const r = validateBody({ fba_seller_account_id: "11111111-1111-1111-1111-111111111111" });
    expect(r.error).toBeUndefined();
    expect(r.data.fba_seller_account_id).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("rejects a non-uuid fba_seller_account_id", () => {
    const r = validateBody({ fba_seller_account_id: "not-a-uuid" });
    expect(r.error).toMatch(/uuid/);
  });
});

describe("handler — wired e2e shape", () => {
  async function callHandler(body, method = "POST") {
    process.env.VITE_SUPABASE_URL = "http://localhost:54321";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key";
    const mod = await import("../mirror-inventory.js");
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

  it("returns 200 on OPTIONS preflight", async () => {
    const { status } = await callHandler(null, "OPTIONS");
    expect(status).toBe(200);
  });

  it("returns 405 on GET", async () => {
    const { status } = await callHandler(null, "GET");
    expect(status).toBe(405);
  });

  it("returns 400 on invalid uuid", async () => {
    const { status, json } = await callHandler({ fba_seller_account_id: "garbage" });
    expect(status).toBe(400);
    expect(json.error).toMatch(/uuid/);
  });

  it("returns 400 on invalid JSON string body", async () => {
    const { status, json } = await callHandler("{not valid json");
    expect(status).toBe(400);
    expect(json.error).toMatch(/JSON/);
  });
});
