// Tests for /api/cron/fba-inventory-daily (P12a-5).
//
// Smoke-level: confirm the route enforces method + env, and that the
// success/failure paths return the shapes the operator's dashboard
// expects. The heavy lifting is exercised in mirror-inventory.test.js.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ /* opaque admin client */ })),
}));

const mirrorMock = vi.fn();
vi.mock("../../_lib/marketplaces/fba/mirror-inventory.js", () => ({
  mirrorFbaInventory: (...args) => mirrorMock(...args),
}));

async function callHandler(method = "GET") {
  process.env.VITE_SUPABASE_URL = "http://localhost:54321";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key";
  const mod = await import("../fba-inventory-daily.js");
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
  const req = { method };
  await handler(req, res);
  return { status, json, res };
}

describe("/api/cron/fba-inventory-daily", () => {
  beforeEach(() => {
    mirrorMock.mockReset();
  });

  it("exports maxDuration 300 (5min Vercel cron budget)", async () => {
    const mod = await import("../fba-inventory-daily.js");
    expect(mod.config).toEqual({ maxDuration: 300 });
  });

  it("returns 405 on PUT (unsupported)", async () => {
    const { status, res } = await callHandler("PUT");
    expect(status).toBe(405);
    expect(res._hdrs.Allow).toBe("GET, POST");
  });

  it("returns 500 when env is not configured", async () => {
    delete process.env.VITE_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const mod = await import("../fba-inventory-daily.js");
    let status = 0;
    let json = null;
    const res = {
      setHeader() {},
      status(s) { status = s; return this; },
      json(j) { json = j; return this; },
    };
    await mod.default({ method: "GET" }, res);
    expect(status).toBe(500);
    expect(json.error).toMatch(/configured/);
  });

  it("accepts GET (Vercel cron uses GET)", async () => {
    mirrorMock.mockResolvedValue({
      started_at: "2026-05-29T04:00:00Z",
      finished_at: "2026-05-29T04:00:01Z",
      accounts: [{ ok: true, fba_seller_account_id: "a", snapshots_upserted: 1, layers_inserted: 1, layers_deleted: 0, pages: 1, error: null }],
    });
    const { status, json } = await callHandler("GET");
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.ok_count).toBe(1);
    expect(json.error_count).toBe(0);
  });

  it("accepts POST too (manual cron poke)", async () => {
    mirrorMock.mockResolvedValue({ started_at: "x", finished_at: "y", accounts: [] });
    const { status } = await callHandler("POST");
    expect(status).toBe(200);
  });

  it("counts ok and error accounts correctly", async () => {
    mirrorMock.mockResolvedValue({
      started_at: "x", finished_at: "y",
      accounts: [
        { ok: true,  fba_seller_account_id: "a" },
        { ok: false, fba_seller_account_id: "b", error: "boom" },
        { ok: true,  fba_seller_account_id: "c" },
      ],
    });
    const { status, json } = await callHandler("GET");
    expect(status).toBe(200);
    expect(json.ok_count).toBe(2);
    expect(json.error_count).toBe(1);
  });

  it("returns 500 with the mirror error on throw", async () => {
    mirrorMock.mockRejectedValue(new Error("fba_seller_accounts read failed: rls"));
    const { status, json } = await callHandler("GET");
    expect(status).toBe(500);
    expect(json.error).toMatch(/rls/);
  });

  it("passes adminClient to mirrorFbaInventory", async () => {
    mirrorMock.mockResolvedValue({ started_at: "x", finished_at: "y", accounts: [] });
    await callHandler("GET");
    expect(mirrorMock).toHaveBeenCalledTimes(1);
    const callArg = mirrorMock.mock.calls[0][0];
    expect(callArg).toHaveProperty("adminClient");
  });

  it("returns started_at / finished_at in response body", async () => {
    mirrorMock.mockResolvedValue({
      started_at: "2026-05-29T04:00:00Z",
      finished_at: "2026-05-29T04:00:05Z",
      accounts: [],
    });
    const { json } = await callHandler("GET");
    expect(json.started_at).toBe("2026-05-29T04:00:00Z");
    expect(json.finished_at).toBe("2026-05-29T04:00:05Z");
  });
});
