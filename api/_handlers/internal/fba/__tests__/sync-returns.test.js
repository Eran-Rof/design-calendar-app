// Tangerine P12a-6 — tests for POST /api/internal/fba/sync-returns handler.

import { describe, it, expect } from "vitest";
import { validateBody } from "../sync-returns.js";

describe("validateBody", () => {
  it("rejects non-object body", () => {
    expect(validateBody(null).error).toMatch(/object/);
    expect(validateBody("x").error).toMatch(/object/);
  });

  it("requires fba_seller_account_id uuid", () => {
    expect(validateBody({}).error).toMatch(/fba_seller_account_id/);
    expect(validateBody({ fba_seller_account_id: "not-a-uuid" }).error).toMatch(/uuid/);
  });

  it("accepts valid uuid without since", () => {
    const r = validateBody({ fba_seller_account_id: "11111111-1111-1111-1111-111111111111" });
    expect(r.error).toBeUndefined();
    expect(r.data.fba_seller_account_id).toBe("11111111-1111-1111-1111-111111111111");
    expect(r.data.since).toBeNull();
  });

  it("accepts valid since ISO timestamp", () => {
    const r = validateBody({
      fba_seller_account_id: "11111111-1111-1111-1111-111111111111",
      since: "2026-04-30T00:00:00Z",
    });
    expect(r.error).toBeUndefined();
    expect(r.data.since).toBe("2026-04-30T00:00:00Z");
  });

  it("rejects malformed since", () => {
    const r = validateBody({
      fba_seller_account_id: "11111111-1111-1111-1111-111111111111",
      since: "yesterday",
    });
    expect(r.error).toMatch(/ISO/);
  });
});

describe("handler — wired e2e shape", () => {
  async function callHandler(body, method = "POST") {
    process.env.VITE_SUPABASE_URL = "http://localhost:54321";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key";
    const mod = await import("../sync-returns.js");
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

  it("returns 200 OK on OPTIONS", async () => {
    const { status } = await callHandler(null, "OPTIONS");
    expect(status).toBe(200);
  });

  it("returns 400 on missing fba_seller_account_id", async () => {
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

  it("parses string JSON body", async () => {
    const { status, json } = await callHandler('{"not_id":"x"}');
    expect(status).toBe(400);
    expect(json.error).toMatch(/fba_seller_account_id/);
  });

  it("rejects malformed JSON body", async () => {
    const { status, json } = await callHandler("{not json}");
    expect(status).toBe(400);
    expect(json.error).toMatch(/Invalid JSON/);
  });
});
