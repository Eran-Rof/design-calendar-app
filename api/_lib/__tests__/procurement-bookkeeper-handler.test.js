// Tests for Tangerine P13-3 — bookkeeper queue handler smoke + carry-over
// guard that the P13-3 stub no longer ships (it was replaced by the real
// P13-4 handler — full coverage lives in
// api/_handlers/internal/procurement/invoices/__tests__/bookkeeper-approve.test.js).

import { describe, it, expect, vi } from "vitest";

import bookkeeperApprove from "../../_handlers/internal/procurement/invoices/bookkeeper-approve.js";

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    setHeader(k, v) { this.headers[k] = v; return this; },
    end() { this.body = null; return this; },
  };
  return res;
}

describe("procurement bookkeeper-approve — P13-4 wire-through guards (carry-over from P13-3 stub)", () => {
  it("rejects missing id with 400", async () => {
    const req = { method: "POST", query: {} };
    const res = mockRes();
    await bookkeeperApprove(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/Invalid invoice id/);
  });

  it("rejects non-uuid id with 400", async () => {
    const req = { method: "POST", query: { id: "not-a-uuid" } };
    const res = mockRes();
    await bookkeeperApprove(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("rejects non-POST methods with 405", async () => {
    const req = { method: "GET", query: { id: "00000000-0000-0000-0000-000000000001" } };
    const res = mockRes();
    await bookkeeperApprove(req, res);
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe("POST");
  });

  it("answers OPTIONS preflight 200 with CORS headers", async () => {
    const req = { method: "OPTIONS", query: {} };
    const res = mockRes();
    await bookkeeperApprove(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.headers["Access-Control-Allow-Methods"]).toMatch(/POST/);
  });

  it("CORS allow-origin is wildcard", async () => {
    const req = { method: "POST", query: { id: "00000000-0000-0000-0000-00000000abcd" } };
    const res = mockRes();
    await bookkeeperApprove(req, res);
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("*");
  });

  it("no longer returns 501 — stub replaced in P13-4", async () => {
    const req = {
      method: "POST",
      query: { id: "00000000-0000-0000-0000-000000000001" },
      body: { action: "approve", reason: "test" },
      headers: {},
    };
    const res = mockRes();
    await bookkeeperApprove(req, res);
    expect(res.statusCode).not.toBe(501);
  });
});

// Smoke test on the queue handler — we can't reach Supabase from unit tests,
// but we can verify the module exports a default function + error path.
describe("procurement bookkeeper-queue smoke", () => {
  it("module exports default handler", async () => {
    const mod = await import("../../_handlers/internal/procurement/bookkeeper-queue/index.js");
    expect(typeof mod.default).toBe("function");
  });

  it("returns 405 on non-GET", async () => {
    const mod = await import("../../_handlers/internal/procurement/bookkeeper-queue/index.js");
    const req = { method: "POST", url: "/api/internal/procurement/bookkeeper-queue", headers: { host: "x" } };
    const res = mockRes();
    await mod.default(req, res);
    expect(res.statusCode).toBe(405);
  });

  it("returns 200 on OPTIONS preflight", async () => {
    const mod = await import("../../_handlers/internal/procurement/bookkeeper-queue/index.js");
    const req = { method: "OPTIONS", url: "/api/internal/procurement/bookkeeper-queue", headers: { host: "x" } };
    const res = mockRes();
    await mod.default(req, res);
    expect(res.statusCode).toBe(200);
  });

  it("returns 500 when env vars unset (CI env)", async () => {
    const savedUrl = process.env.VITE_SUPABASE_URL;
    const savedKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.VITE_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    try {
      const mod = await import("../../_handlers/internal/procurement/bookkeeper-queue/index.js");
      const req = { method: "GET", url: "/api/internal/procurement/bookkeeper-queue?limit=10", headers: { host: "x" } };
      const res = mockRes();
      await mod.default(req, res);
      expect(res.statusCode).toBe(500);
      expect(res.body.error).toMatch(/Server not configured/);
    } finally {
      if (savedUrl) process.env.VITE_SUPABASE_URL = savedUrl;
      if (savedKey) process.env.SUPABASE_SERVICE_ROLE_KEY = savedKey;
    }
  });
});

// Ensure vi import is referenced so test runner doesn't strip-warn.
void vi;
