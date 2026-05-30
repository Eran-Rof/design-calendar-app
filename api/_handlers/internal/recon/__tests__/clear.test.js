// Tangerine P9-7 — tests for POST /api/internal/recon/variances/:id/clear.
//
// Covers validateClearBody + validateVarianceId pure helpers + the HTTP
// handler. Per T11 D3 audit pattern, reason is REQUIRED (NOT NULL on
// recon_cleared_log.reason). Covers idempotency (409 on already-cleared),
// 404 missing variance, insert into recon_cleared_log + status flip, and
// 500 paths.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockState = vi.hoisted(() => ({ admin: null }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => mockState.admin,
}));

const {
  default: handler,
  validateClearBody,
  validateVarianceId,
} = await import("../clear.js");

const VID = "33333333-3333-3333-3333-333333333333";

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

function makeReq({
  method = "POST",
  body = { reason: "Xoro retroactive credit memo" },
  query = { id: VID },
  headers = {},
} = {}) {
  return {
    method,
    headers: { host: "localhost", "content-type": "application/json", ...headers },
    url: `/api/internal/recon/variances/${VID}/clear`,
    query,
    body,
  };
}

// Tiny supabase fake. Tracks what gets inserted into recon_cleared_log
// and what status update was issued.
function buildAdmin({
  variance = null,
  variancesLookupError = null,
  insertError = null,
  updateError = null,
} = {}) {
  const inserts = [];
  const updates = [];
  let updatedRow = null;

  return {
    _inserts: inserts,
    _updates: updates,
    from(table) {
      if (table === "recon_variances") {
        const state = { mode: "select", payload: null, filters: [] };
        const builder = {
          select() { state.mode = state.mode === "insert" || state.mode === "update" ? state.mode : "select"; return builder; },
          eq(col, val) { state.filters.push([col, val]); return builder; },
          maybeSingle() {
            if (state.mode === "update") {
              if (updateError) return Promise.resolve({ data: null, error: updateError });
              updatedRow = { ...(variance || {}), ...(state.payload || {}) };
              updates.push({ payload: state.payload, filters: state.filters });
              return Promise.resolve({ data: updatedRow, error: null });
            }
            // select path
            if (variancesLookupError) {
              return Promise.resolve({ data: null, error: variancesLookupError });
            }
            return Promise.resolve({ data: variance, error: null });
          },
          update(payload) { state.mode = "update"; state.payload = payload; return builder; },
        };
        return builder;
      }
      if (table === "recon_cleared_log") {
        const state = { payload: null };
        const builder = {
          insert(payload) { state.payload = payload; return builder; },
          select() { return builder; },
          maybeSingle() {
            if (insertError) return Promise.resolve({ data: null, error: insertError });
            inserts.push(state.payload);
            return Promise.resolve({
              data: {
                id: "cl-" + Math.random().toString(36).slice(2, 8),
                recon_variance_id: state.payload?.recon_variance_id,
                reason: state.payload?.reason,
                cleared_at: new Date().toISOString(),
              },
              error: null,
            });
          },
        };
        return builder;
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
}

// ────────────────────────────────────────────────────────────────────────
// validateClearBody + validateVarianceId (pure)
// ────────────────────────────────────────────────────────────────────────
describe("validateClearBody", () => {
  it("requires reason to be a string", () => {
    expect(validateClearBody({}).error).toMatch(/reason is required/);
    expect(validateClearBody({ reason: 42 }).error).toMatch(/reason is required/);
  });

  it("rejects empty / whitespace-only reason", () => {
    expect(validateClearBody({ reason: "" }).error).toMatch(/cannot be empty/);
    expect(validateClearBody({ reason: "   " }).error).toMatch(/cannot be empty/);
  });

  it("trims a valid reason", () => {
    const v = validateClearBody({ reason: "  ok  " });
    expect(v.data.reason).toBe("ok");
  });

  it("rejects > 2000 char reason", () => {
    const long = "x".repeat(2001);
    expect(validateClearBody({ reason: long }).error).toMatch(/2000 characters/);
  });
});

describe("validateVarianceId", () => {
  it("rejects non-string / empty id", () => {
    expect(validateVarianceId(undefined).error).toMatch(/uuid/);
    expect(validateVarianceId("").error).toMatch(/uuid/);
  });

  it("rejects malformed uuid", () => {
    expect(validateVarianceId("abc-def").error).toMatch(/uuid/);
  });

  it("accepts a valid uuid (trimmed)", () => {
    const v = validateVarianceId(`  ${VID}  `);
    expect(v.data).toBe(VID);
  });
});

// ────────────────────────────────────────────────────────────────────────
// HTTP handler
// ────────────────────────────────────────────────────────────────────────
describe("POST /api/internal/recon/variances/:id/clear handler", () => {
  const origToken = process.env.INTERNAL_API_TOKEN;
  beforeEach(() => {
    process.env.VITE_SUPABASE_URL = "https://fake.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-key";
    delete process.env.INTERNAL_API_TOKEN;
    mockState.admin = buildAdmin({
      variance: {
        id: VID, recon_run_id: "run-1", source_table: "ar_invoices",
        source_id: "i1", source_tag: "shopify",
        tangerine_amount_cents: 100, xoro_amount_cents: 80,
        variance_amount_cents: 20, status: "over", notes: null,
      },
    });
  });
  afterEach(() => {
    mockState.admin = null;
    if (origToken === undefined) delete process.env.INTERNAL_API_TOKEN;
    else process.env.INTERNAL_API_TOKEN = origToken;
  });

  it("405 on non-POST", async () => {
    const res = makeRes();
    await handler(makeReq({ method: "GET" }), res);
    expect(res.statusCode).toBe(405);
  });

  it("200 on OPTIONS preflight", async () => {
    const res = makeRes();
    await handler(makeReq({ method: "OPTIONS" }), res);
    expect(res.statusCode).toBe(200);
  });

  it("401 when INTERNAL_API_TOKEN is set + missing token", async () => {
    process.env.INTERNAL_API_TOKEN = "secret";
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(401);
  });

  it("400 missing reason (T11 D3 audit-trail required)", async () => {
    const res = makeRes();
    await handler(makeReq({ body: {} }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/reason/);
  });

  it("400 empty-string reason", async () => {
    const res = makeRes();
    await handler(makeReq({ body: { reason: "   " } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/empty/);
  });

  it("400 when variance id is not a uuid", async () => {
    const res = makeRes();
    await handler(makeReq({ query: { id: "not-a-uuid" } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/uuid/);
  });

  it("400 when the JSON body string is unparseable", async () => {
    const res = makeRes();
    await handler(makeReq({ body: "{not json" }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/Invalid JSON/);
  });

  it("404 when the variance id doesn't exist", async () => {
    mockState.admin = buildAdmin({ variance: null });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toMatch(/not found/);
  });

  it("409 when variance is already cleared (idempotency guard)", async () => {
    mockState.admin = buildAdmin({
      variance: { id: VID, status: "cleared" },
    });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toMatch(/already cleared/);
  });

  it("200 on success — inserts into recon_cleared_log + flips status='cleared'", async () => {
    const res = makeRes();
    await handler(makeReq({ body: { reason: "Xoro CM-99213 not yet mirrored" } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.variance.status).toBe("cleared");
    expect(res.body.cleared_log).toBeTruthy();
    expect(res.body.cleared_log.reason).toBe("Xoro CM-99213 not yet mirrored");
    // Verify the log insert + the status flip happened.
    expect(mockState.admin._inserts).toHaveLength(1);
    expect(mockState.admin._inserts[0].recon_variance_id).toBe(VID);
    expect(mockState.admin._inserts[0].reason).toBe("Xoro CM-99213 not yet mirrored");
    expect(mockState.admin._updates).toHaveLength(1);
    expect(mockState.admin._updates[0].payload).toEqual({ status: "cleared" });
  });

  it("500 when variance lookup errors", async () => {
    mockState.admin = buildAdmin({
      variancesLookupError: { message: "lookup-boom" },
    });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/lookup-boom/);
  });

  it("500 when cleared_log insert errors", async () => {
    mockState.admin = buildAdmin({
      variance: { id: VID, status: "over" },
      insertError: { message: "log-boom" },
    });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/log-boom/);
  });

  it("500 when status update errors", async () => {
    mockState.admin = buildAdmin({
      variance: { id: VID, status: "over" },
      updateError: { message: "update-boom" },
    });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toMatch(/update-boom/);
  });

  it("500 when supabase env vars are missing", async () => {
    delete process.env.VITE_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    mockState.admin = null;
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(500);
  });

  it("accepts a JSON string body (parses it)", async () => {
    const res = makeRes();
    await handler(
      makeReq({ body: JSON.stringify({ reason: "via string body" }) }),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(mockState.admin._inserts[0].reason).toBe("via string body");
  });
});
