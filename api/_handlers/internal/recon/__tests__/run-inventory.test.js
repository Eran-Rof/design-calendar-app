// Tangerine P9-6 — tests for /api/internal/recon/run-inventory handler.
//
// Architecture: docs/tangerine/P9-parallel-run-architecture.md §3.5 + §4.4.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(() => Promise.resolve({ data: { id: "ent-rof" }, error: null })),
        })),
      })),
    })),
  })),
}));

vi.mock("../../../../_lib/recon/inventory-engine.js", () => ({
  runInventoryReconciliation: vi.fn(),
}));

import handler, { validateBody } from "../run-inventory.js";
import { runInventoryReconciliation } from "../../../../_lib/recon/inventory-engine.js";

const VALID_BODY = {
  period_start: "2026-05-01",
  period_end: "2026-05-31",
};
const REPLAY_OF = "00000000-0000-0000-0000-000000000123";

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end() { this.body = ""; return this; },
  };
}

function makeReq({ method = "POST", body = VALID_BODY, headers = {} } = {}) {
  return { method, headers, body };
}

// ──────────────────────────────────────────────────────────────────────────
// validateBody pure tests
// ──────────────────────────────────────────────────────────────────────────

describe("validateBody (run-inventory)", () => {
  it("accepts minimal valid body, defaults cadence to 'manual'", () => {
    const v = validateBody(VALID_BODY);
    expect(v.error).toBeUndefined();
    expect(v.data.cadence).toBe("manual");
    expect(v.data.replay_of_id).toBeNull();
  });

  it("rejects missing period_start", () => {
    expect(validateBody({ period_end: "2026-05-31" }).error).toMatch(/period_start/);
  });

  it("rejects bad period_end format", () => {
    expect(validateBody({ period_start: "2026-05-01", period_end: "20260531" }).error).toMatch(/period_end/);
  });

  it("rejects period_end < period_start", () => {
    expect(validateBody({ period_start: "2026-05-31", period_end: "2026-05-01" }).error).toMatch(/period_end must be >=/);
  });

  it("rejects bad cadence value", () => {
    expect(validateBody({ ...VALID_BODY, cadence: "daily" }).error).toMatch(/cadence/);
  });

  it("forces cadence='replay' when replay_of_id is set", () => {
    const v = validateBody({ ...VALID_BODY, replay_of_id: REPLAY_OF });
    expect(v.data.cadence).toBe("replay");
    expect(v.data.replay_of_id).toBe(REPLAY_OF);
  });

  it("rejects non-uuid replay_of_id", () => {
    expect(validateBody({ ...VALID_BODY, replay_of_id: "not-a-uuid" }).error).toMatch(/replay_of_id/);
  });

  it("accepts cadence='weekly' explicitly", () => {
    expect(validateBody({ ...VALID_BODY, cadence: "weekly" }).data.cadence).toBe("weekly");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Handler tests
// ──────────────────────────────────────────────────────────────────────────

describe("POST /api/internal/recon/run-inventory", () => {
  const originalEnv = process.env.INTERNAL_API_TOKEN;
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.VITE_SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
    delete process.env.INTERNAL_API_TOKEN;
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.INTERNAL_API_TOKEN;
    else process.env.INTERNAL_API_TOKEN = originalEnv;
  });

  it("200 with engine summary on happy path", async () => {
    runInventoryReconciliation.mockResolvedValue({
      recon_run_id: "rrr-1",
      status: "clean",
      rows_compared: 5,
      variances_found: 0,
      total_variance_cents: 0,
      totals_jsonb: {},
      errors: [],
    });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      domain: "inventory",
      entity_id: "ent-rof",
      recon_run_id: "rrr-1",
      status: "clean",
    });
    expect(runInventoryReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_id: "ent-rof",
        period_start: "2026-05-01",
        period_end: "2026-05-31",
        cadence: "manual",
        replay_of_id: null,
      }),
    );
  });

  it("405 on GET", async () => {
    const res = makeRes();
    await handler(makeReq({ method: "GET" }), res);
    expect(res.statusCode).toBe(405);
  });

  it("OPTIONS short-circuit (CORS preflight) → 200 no body", async () => {
    const res = makeRes();
    await handler(makeReq({ method: "OPTIONS" }), res);
    expect(res.statusCode).toBe(200);
    expect(runInventoryReconciliation).not.toHaveBeenCalled();
  });

  it("400 on missing period_start", async () => {
    const res = makeRes();
    await handler(makeReq({ body: { period_end: "2026-05-31" } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/period_start/);
    expect(runInventoryReconciliation).not.toHaveBeenCalled();
  });

  it("400 on bad period range (end < start)", async () => {
    const res = makeRes();
    await handler(makeReq({ body: { period_start: "2026-05-31", period_end: "2026-05-01" } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/period_end must be >=/);
  });

  it("400 on invalid JSON string body", async () => {
    const res = makeRes();
    await handler(makeReq({ body: "not json" }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/Invalid JSON/);
  });

  it("401 when INTERNAL_API_TOKEN set + no token presented", async () => {
    process.env.INTERNAL_API_TOKEN = "secret-token";
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(401);
    expect(runInventoryReconciliation).not.toHaveBeenCalled();
  });

  it("200 when correct Bearer token presented", async () => {
    process.env.INTERNAL_API_TOKEN = "right-token";
    runInventoryReconciliation.mockResolvedValue({
      recon_run_id: "rrr-1",
      status: "clean",
      rows_compared: 0,
      variances_found: 0,
      total_variance_cents: 0,
      totals_jsonb: {},
      errors: [],
    });
    const res = makeRes();
    await handler(
      makeReq({ headers: { authorization: "Bearer right-token" } }),
      res,
    );
    expect(res.statusCode).toBe(200);
  });

  it("500 when engine throws", async () => {
    runInventoryReconciliation.mockRejectedValue(new Error("engine boom"));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/runInventoryReconciliation threw.*engine boom/);
  });

  it("forwards replay_of_id and forces cadence='replay'", async () => {
    runInventoryReconciliation.mockResolvedValue({
      recon_run_id: "replay-1",
      status: "clean",
      rows_compared: 0,
      variances_found: 0,
      total_variance_cents: 0,
      totals_jsonb: {},
      errors: [],
    });
    const res = makeRes();
    await handler(
      makeReq({ body: { ...VALID_BODY, replay_of_id: REPLAY_OF } }),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(runInventoryReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({
        cadence: "replay",
        replay_of_id: REPLAY_OF,
      }),
    );
  });

  it("propagates engine 'variance' status to response with per_location totals", async () => {
    runInventoryReconciliation.mockResolvedValue({
      recon_run_id: "rrr-2",
      status: "variance",
      rows_compared: 42,
      variances_found: 7,
      total_variance_cents: 80000,
      totals_jsonb: {
        rows_compared: 42,
        variances_found: 7,
        skipped_count: 12,
        per_location: { "loc-main": { rows: 30, over: 7, skipped: 0, variance_cents: 80000 } },
      },
      errors: [],
    });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("variance");
    expect(res.body.total_variance_cents).toBe(80000);
    expect(res.body.totals_jsonb.per_location["loc-main"].over).toBe(7);
  });
});
