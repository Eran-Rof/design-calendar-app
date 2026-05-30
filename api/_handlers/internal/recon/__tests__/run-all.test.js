// Tangerine P9-8 — tests for POST /api/internal/recon/run-all.
//
// Covers:
//   - HTTP gate (405 on non-POST, 400 on bad body, 200 happy path)
//   - validateBody (period dates, optional entity_id, both required)
//   - OPTIONS preflight (CORS)
//   - Auth gate (open mode passes, denied when token mismatch)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockState = vi.hoisted(() => ({ admin: null, orchestratorResult: null, orchestratorError: null }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => mockState.admin,
}));

vi.mock("../../../../cron/recon-weekly.js", () => ({
  runReconWeekly: async (admin, opts) => {
    if (mockState.orchestratorError) throw mockState.orchestratorError;
    return mockState.orchestratorResult || {
      period_start: opts.period_start,
      period_end: opts.period_end,
      entities: [],
      total_entities: 0,
      total_notifications: 0,
    };
  },
}));

function makeRes() {
  const headers = {};
  return {
    statusCode: 0,
    body: null,
    headers,
    setHeader(k, v) { headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

function makeReq({ method = "POST", body = null, headers = {} } = {}) {
  return {
    method,
    headers: { host: "localhost", ...headers },
    url: "/api/internal/recon/run-all",
    body,
    query: {},
  };
}

const ORIGINAL_ENV = { ...process.env };
beforeEach(() => {
  process.env.VITE_SUPABASE_URL = "https://x.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
  delete process.env.INTERNAL_API_TOKEN;
  mockState.admin = { from() { return {}; } };
  mockState.orchestratorResult = null;
  mockState.orchestratorError = null;
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

// ─────────────────────────────────────────────────────────────────────────
// validateBody
// ─────────────────────────────────────────────────────────────────────────
describe("validateBody", () => {
  it("accepts a valid happy-path body", async () => {
    const { validateBody } = await import("../run-all.js");
    const v = validateBody({ period_start: "2026-05-18", period_end: "2026-05-24" });
    expect(v.data).toEqual({
      period_start: "2026-05-18",
      period_end: "2026-05-24",
      entity_id: null,
    });
  });
  it("rejects missing period_start", async () => {
    const { validateBody } = await import("../run-all.js");
    const v = validateBody({ period_end: "2026-05-24" });
    expect(v.error).toMatch(/period_start/);
  });
  it("rejects bad period date format", async () => {
    const { validateBody } = await import("../run-all.js");
    const v = validateBody({ period_start: "not-a-date", period_end: "2026-05-24" });
    expect(v.error).toMatch(/period_start/);
  });
  it("rejects period_end < period_start", async () => {
    const { validateBody } = await import("../run-all.js");
    const v = validateBody({ period_start: "2026-05-24", period_end: "2026-05-18" });
    expect(v.error).toMatch(/period_end/);
  });
  it("accepts optional entity_id uuid", async () => {
    const { validateBody } = await import("../run-all.js");
    const v = validateBody({
      period_start: "2026-05-18",
      period_end: "2026-05-24",
      entity_id: "00000000-0000-0000-0000-000000000001",
    });
    expect(v.data.entity_id).toBe("00000000-0000-0000-0000-000000000001");
  });
  it("rejects non-uuid entity_id", async () => {
    const { validateBody } = await import("../run-all.js");
    const v = validateBody({
      period_start: "2026-05-18",
      period_end: "2026-05-24",
      entity_id: "not-a-uuid",
    });
    expect(v.error).toMatch(/entity_id/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// HTTP handler
// ─────────────────────────────────────────────────────────────────────────
describe("run-all handler", () => {
  it("returns 405 on GET", async () => {
    const { default: handler } = await import("../run-all.js");
    const req = makeReq({ method: "GET" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it("returns 200 on OPTIONS preflight", async () => {
    const { default: handler } = await import("../run-all.js");
    const req = makeReq({ method: "OPTIONS" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it("returns 400 on bad body", async () => {
    const { default: handler } = await import("../run-all.js");
    const req = makeReq({ body: { period_start: "bad" } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 on invalid JSON string body", async () => {
    const { default: handler } = await import("../run-all.js");
    const req = makeReq({ body: "{bad" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/JSON/);
  });

  it("returns 500 when supabase env is missing", async () => {
    delete process.env.VITE_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const { default: handler } = await import("../run-all.js");
    const req = makeReq({ body: { period_start: "2026-05-18", period_end: "2026-05-24" } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
  });

  it("returns 200 with orchestrator summary on happy path", async () => {
    mockState.orchestratorResult = {
      period_start: "2026-05-18",
      period_end: "2026-05-24",
      entities: [{ entity_id: "ent-1", domains_run: ["ap", "ar", "cash", "inventory", "gl"], notifications_emitted: 0 }],
      total_entities: 1,
      total_notifications: 0,
    };
    const { default: handler } = await import("../run-all.js");
    const req = makeReq({ body: { period_start: "2026-05-18", period_end: "2026-05-24" } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.total_entities).toBe(1);
    expect(res.body.period_start).toBe("2026-05-18");
  });

  it("returns 500 when orchestrator throws", async () => {
    mockState.orchestratorError = new Error("boom");
    const { default: handler } = await import("../run-all.js");
    const req = makeReq({ body: { period_start: "2026-05-18", period_end: "2026-05-24" } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/boom/);
  });

  it("denies when INTERNAL_API_TOKEN is set but request omits it", async () => {
    process.env.INTERNAL_API_TOKEN = "supersecret-token-supersecret-token";
    const { default: handler } = await import("../run-all.js");
    const req = makeReq({ body: { period_start: "2026-05-18", period_end: "2026-05-24" } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it("accepts request when X-Internal-Token matches", async () => {
    const token = "supersecret-token-supersecret-token";
    process.env.INTERNAL_API_TOKEN = token;
    mockState.orchestratorResult = {
      period_start: "2026-05-18",
      period_end: "2026-05-24",
      entities: [],
      total_entities: 0,
      total_notifications: 0,
    };
    const { default: handler } = await import("../run-all.js");
    const req = makeReq({
      body: { period_start: "2026-05-18", period_end: "2026-05-24" },
      headers: { "x-internal-token": token },
    });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });
});
