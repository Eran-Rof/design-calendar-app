// Tangerine P12a-6 — tests for the FBA returns sync cron.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({})),
}));

vi.mock("../../_lib/marketplaces/fba/sync-returns.js", () => ({
  syncAllAccountsReturns: vi.fn(),
}));

import handler from "../fba-returns-daily.js";
import { syncAllAccountsReturns } from "../../_lib/marketplaces/fba/sync-returns.js";

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end() { return this; },
  };
}

describe("cron/fba-returns-daily", () => {
  const oldUrl = process.env.VITE_SUPABASE_URL;
  const oldKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.VITE_SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
  });
  afterEach(() => {
    process.env.VITE_SUPABASE_URL = oldUrl;
    process.env.SUPABASE_SERVICE_ROLE_KEY = oldKey;
  });

  it("returns 405 on non-GET/POST", async () => {
    const res = makeRes();
    await handler({ method: "DELETE" }, res);
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toMatch(/GET, POST/);
  });

  it("returns 500 when env missing", async () => {
    delete process.env.VITE_SUPABASE_URL;
    const res = makeRes();
    await handler({ method: "GET" }, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/configured/);
  });

  it("returns 200 with summary on GET happy path", async () => {
    syncAllAccountsReturns.mockResolvedValue({
      started_at: "2026-05-29T00:00:00Z",
      finished_at: "2026-05-29T00:01:00Z",
      accounts: [
        { ok: true, fba_seller_account_id: "a", returns_upserted: 3, je_posted: 2, credit_memos_posted: 1 },
        { ok: true, fba_seller_account_id: "b", returns_upserted: 0, je_posted: 0, credit_memos_posted: 0 },
      ],
    });
    const res = makeRes();
    await handler({ method: "GET" }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.ok_count).toBe(2);
    expect(res.body.error_count).toBe(0);
    expect(res.body.accounts).toHaveLength(2);
  });

  it("returns 200 on POST too", async () => {
    syncAllAccountsReturns.mockResolvedValue({
      started_at: "x", finished_at: "y", accounts: [],
    });
    const res = makeRes();
    await handler({ method: "POST" }, res);
    expect(res.statusCode).toBe(200);
  });

  it("counts ok vs error per account", async () => {
    syncAllAccountsReturns.mockResolvedValue({
      started_at: "x", finished_at: "y",
      accounts: [
        { ok: true,  fba_seller_account_id: "a" },
        { ok: false, fba_seller_account_id: "b", error: "boom" },
        { ok: true,  fba_seller_account_id: "c" },
      ],
    });
    const res = makeRes();
    await handler({ method: "GET" }, res);
    expect(res.body.ok_count).toBe(2);
    expect(res.body.error_count).toBe(1);
  });

  it("returns 500 when sync throws unexpectedly", async () => {
    syncAllAccountsReturns.mockRejectedValue(new Error("network died"));
    const res = makeRes();
    await handler({ method: "GET" }, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/network died/);
  });

  it("stringifies non-Error throws", async () => {
    syncAllAccountsReturns.mockRejectedValue("oops");
    const res = makeRes();
    await handler({ method: "GET" }, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe("oops");
  });

  it("handles empty accounts result gracefully", async () => {
    syncAllAccountsReturns.mockResolvedValue({
      started_at: "x", finished_at: "y", accounts: [],
    });
    const res = makeRes();
    await handler({ method: "GET" }, res);
    expect(res.body.ok_count).toBe(0);
    expect(res.body.error_count).toBe(0);
    expect(res.body.accounts).toEqual([]);
  });

  it("exports config.maxDuration", async () => {
    const mod = await import("../fba-returns-daily.js");
    expect(mod.config.maxDuration).toBe(300);
  });
});
