// Tangerine P9-4 — tests for the run-cash handler.
//
// Coverage:
//   - method gating (OPTIONS / 405 / non-POST)
//   - body validation (period_start / period_end / inversion / replay_of_id)
//   - X-Entity-ID header gating
//   - missing env vars → 500
//   - happy path (manual cadence) shape
//   - replay path (cadence=replay)
//   - engine failure surfaces as 500 with errors[]

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const ENTITY = "11111111-1111-1111-1111-111111111111";
const REPLAY_OF = "22222222-2222-2222-2222-222222222222";

// Mock the @supabase/supabase-js + engine modules BEFORE we import the
// handler so the handler picks up our mocks.
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ from: () => ({}), state: {} })),
}));

const engineSpy = vi.fn();
vi.mock("../../../../_lib/recon/cash-engine.js", () => ({
  runCashReconciliation: (...args) => engineSpy(...args),
}));

let handler;
beforeEach(async () => {
  engineSpy.mockReset();
  process.env.VITE_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
  vi.resetModules();
  const mod = await import("../run-cash.js");
  handler = mod.default;
});

afterEach(() => {
  delete process.env.VITE_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(k, v) { this.headers[k] = v; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
  return res;
}

function makeReq({ method = "POST", body = null, headers = {} } = {}) {
  return { method, body, headers };
}

describe("run-cash handler — method gating", () => {
  it("OPTIONS returns 200 + CORS headers", async () => {
    const res = makeRes();
    await handler(makeReq({ method: "OPTIONS" }), res);
    expect(res.statusCode).toBe(200);
    expect(res.headers["Access-Control-Allow-Methods"]).toContain("POST");
  });
  it("GET returns 405", async () => {
    const res = makeRes();
    await handler(makeReq({ method: "GET" }), res);
    expect(res.statusCode).toBe(405);
    expect(res.body.error).toMatch(/Method/);
  });
  it("PUT returns 405", async () => {
    const res = makeRes();
    await handler(makeReq({ method: "PUT" }), res);
    expect(res.statusCode).toBe(405);
  });
});

describe("run-cash handler — body validation", () => {
  it("rejects missing period_start", async () => {
    const res = makeRes();
    await handler(
      makeReq({ body: { period_end: "2026-05-31" }, headers: { "X-Entity-ID": ENTITY } }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/period_start/);
  });
  it("rejects missing period_end", async () => {
    const res = makeRes();
    await handler(
      makeReq({ body: { period_start: "2026-05-01" }, headers: { "X-Entity-ID": ENTITY } }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/period_end/);
  });
  it("rejects period_end < period_start", async () => {
    const res = makeRes();
    await handler(
      makeReq({
        body: { period_start: "2026-05-31", period_end: "2026-05-01" },
        headers: { "X-Entity-ID": ENTITY },
      }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/before/);
  });
  it("rejects bad replay_of_id", async () => {
    const res = makeRes();
    await handler(
      makeReq({
        body: { period_start: "2026-05-01", period_end: "2026-05-31", replay_of_id: "abc" },
        headers: { "X-Entity-ID": ENTITY },
      }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/replay_of_id/);
  });
  it("rejects malformed JSON string body", async () => {
    const res = makeRes();
    await handler(makeReq({ body: "not json", headers: { "X-Entity-ID": ENTITY } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/Invalid JSON/);
  });
});

describe("run-cash handler — entity header", () => {
  it("rejects missing X-Entity-ID", async () => {
    const res = makeRes();
    await handler(
      makeReq({ body: { period_start: "2026-05-01", period_end: "2026-05-31" } }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/X-Entity-ID/);
  });
  it("rejects non-uuid X-Entity-ID", async () => {
    const res = makeRes();
    await handler(
      makeReq({
        body: { period_start: "2026-05-01", period_end: "2026-05-31" },
        headers: { "X-Entity-ID": "not-a-uuid" },
      }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/X-Entity-ID/);
  });
});

describe("run-cash handler — happy path", () => {
  it("manual cadence is passed through to the engine; returns 200 with summary", async () => {
    engineSpy.mockResolvedValue({
      ok: true,
      recon_run_id: "run-1",
      status: "clean",
      summary: { rows_compared: 0, variances_found: 0, matches_found: 12 },
      errors: [],
    });
    const res = makeRes();
    await handler(
      makeReq({
        body: { period_start: "2026-05-01", period_end: "2026-05-31" },
        headers: { "X-Entity-ID": ENTITY },
      }),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.cadence).toBe("manual");
    expect(res.body.summary.matches_found).toBe(12);
    expect(engineSpy).toHaveBeenCalledTimes(1);
    const call = engineSpy.mock.calls[0][0];
    expect(call.entity_id).toBe(ENTITY);
    expect(call.period_start).toBe("2026-05-01");
    expect(call.period_end).toBe("2026-05-31");
    expect(call.cadence).toBe("manual");
    expect(call.replay_of_id).toBeNull();
  });

  it("replay_of_id set → cadence=replay routed to engine", async () => {
    engineSpy.mockResolvedValue({
      ok: true,
      recon_run_id: "run-2",
      status: "variance",
      summary: { rows_compared: 5, variances_found: 1 },
      errors: [],
    });
    const res = makeRes();
    await handler(
      makeReq({
        body: { period_start: "2026-05-01", period_end: "2026-05-31", replay_of_id: REPLAY_OF },
        headers: { "X-Entity-ID": ENTITY },
      }),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.cadence).toBe("replay");
    expect(engineSpy.mock.calls[0][0].cadence).toBe("replay");
    expect(engineSpy.mock.calls[0][0].replay_of_id).toBe(REPLAY_OF);
  });

  it("accepts string JSON body", async () => {
    engineSpy.mockResolvedValue({ ok: true, recon_run_id: "x", status: "clean", summary: {}, errors: [] });
    const res = makeRes();
    await handler(
      makeReq({
        body: JSON.stringify({ period_start: "2026-05-01", period_end: "2026-05-31" }),
        headers: { "X-Entity-ID": ENTITY },
      }),
      res,
    );
    expect(res.statusCode).toBe(200);
  });

  it("accepts lowercase x-entity-id header", async () => {
    engineSpy.mockResolvedValue({ ok: true, recon_run_id: "x", status: "clean", summary: {}, errors: [] });
    const res = makeRes();
    await handler(
      makeReq({
        body: { period_start: "2026-05-01", period_end: "2026-05-31" },
        headers: { "x-entity-id": ENTITY },
      }),
      res,
    );
    expect(res.statusCode).toBe(200);
  });
});

describe("run-cash handler — env + engine error", () => {
  it("500 when supabase env vars are not configured", async () => {
    delete process.env.VITE_SUPABASE_URL;
    vi.resetModules();
    const { default: fresh } = await import("../run-cash.js");
    engineSpy.mockResolvedValue({ ok: true, recon_run_id: "x", status: "clean", summary: {}, errors: [] });
    const res = makeRes();
    await fresh(
      makeReq({
        body: { period_start: "2026-05-01", period_end: "2026-05-31" },
        headers: { "X-Entity-ID": ENTITY },
      }),
      res,
    );
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/configured/);
  });

  it("500 when engine returns ok=false", async () => {
    engineSpy.mockResolvedValue({
      ok: false,
      recon_run_id: null,
      status: "error",
      summary: {},
      errors: [{ kind: "bank_transactions_read_failed", message: "boom" }],
    });
    const res = makeRes();
    await handler(
      makeReq({
        body: { period_start: "2026-05-01", period_end: "2026-05-31" },
        headers: { "X-Entity-ID": ENTITY },
      }),
      res,
    );
    expect(res.statusCode).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.errors[0].kind).toBe("bank_transactions_read_failed");
  });

  it("500 when engine throws", async () => {
    engineSpy.mockRejectedValue(new Error("kaboom"));
    const res = makeRes();
    await handler(
      makeReq({
        body: { period_start: "2026-05-01", period_end: "2026-05-31" },
        headers: { "X-Entity-ID": ENTITY },
      }),
      res,
    );
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/kaboom/);
  });
});
