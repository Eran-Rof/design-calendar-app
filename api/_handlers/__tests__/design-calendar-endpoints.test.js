// Happy-path + auth-gate tests for the three Design Calendar
// scriptable endpoints. Real work is exercised in
// api/_lib/__tests__/planning-sync.test.js — these tests cover the
// HTTP-shaped concerns: auth, method gate, response shape.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the heavy collaborators before importing handlers so the
// module-level `import { createClient }` and `import {
// syncOnHandFromAtsSnapshot, ... }` resolve to stubs.
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({})), // handlers only pass it through
}));
vi.mock("../../_lib/planning-sync.js", () => ({
  syncOnHandFromAtsSnapshot: vi.fn(),
  syncOpenPosFromTandaPos: vi.fn(),
}));

import { syncOnHandFromAtsSnapshot, syncOpenPosFromTandaPos } from "../../_lib/planning-sync.js";
import syncOnHandHandler  from "../planning/sync-on-hand.js";
import syncOpenPosHandler from "../planning/sync-open-pos.js";

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end() { return this; },
  };
  return res;
}

function makeReq({ method = "POST", token = TOKEN } = {}) {
  return {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  };
}

describe("POST /api/planning/sync-on-hand", () => {
  let originalToken, originalSb, originalKey;

  beforeEach(() => {
    originalToken = process.env.DESIGN_CALENDAR_API_TOKEN;
    originalSb    = process.env.VITE_SUPABASE_URL;
    originalKey   = process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.DESIGN_CALENDAR_API_TOKEN = TOKEN;
    process.env.VITE_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    vi.mocked(syncOnHandFromAtsSnapshot).mockReset();
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.DESIGN_CALENDAR_API_TOKEN; else process.env.DESIGN_CALENDAR_API_TOKEN = originalToken;
    if (originalSb    === undefined) delete process.env.VITE_SUPABASE_URL;          else process.env.VITE_SUPABASE_URL = originalSb;
    if (originalKey   === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;  else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
  });

  it("returns 401 when bearer token is missing", async () => {
    const req = makeReq({ token: null });
    const res = makeRes();
    await syncOnHandHandler(req, res);
    expect(res.statusCode).toBe(401);
    expect(syncOnHandFromAtsSnapshot).not.toHaveBeenCalled();
  });

  it("returns 401 when bearer token is wrong", async () => {
    const wrong = "f" + TOKEN.slice(1);
    const req = makeReq({ token: wrong });
    const res = makeRes();
    await syncOnHandHandler(req, res);
    expect(res.statusCode).toBe(401);
    expect(syncOnHandFromAtsSnapshot).not.toHaveBeenCalled();
  });

  it("returns 405 for GET", async () => {
    const req = makeReq({ method: "GET" });
    const res = makeRes();
    await syncOnHandHandler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it("returns 200 with the spec'd shape on success", async () => {
    vi.mocked(syncOnHandFromAtsSnapshot).mockResolvedValue({
      upserted: 2468,
      new_skus: 1,
      skipped: 0,
      scanned: 2751,
      chunks: 2,
      errors: [],
      error: null,
    });
    const req = makeReq();
    const res = makeRes();
    await syncOnHandHandler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      upserted: 2468,
      new_skus: 1,
      skipped: 0,
      scanned: 2751,
      chunks: 2,
      errors: [],
    });
    expect(syncOnHandFromAtsSnapshot).toHaveBeenCalledTimes(1);
  });

  it("returns 400 when the core surfaces a user-facing error", async () => {
    vi.mocked(syncOnHandFromAtsSnapshot).mockResolvedValue({
      upserted: 0, new_skus: 0, skipped: 0, scanned: 0, chunks: 1,
      errors: [], error: "No ATS Excel snapshot uploaded yet — upload via /api/ats/upload first.",
      details: null,
    });
    const req = makeReq();
    const res = makeRes();
    await syncOnHandHandler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/No ATS Excel snapshot/);
  });
});

describe("POST /api/planning/sync-open-pos", () => {
  let originalToken, originalSb, originalKey;

  beforeEach(() => {
    originalToken = process.env.DESIGN_CALENDAR_API_TOKEN;
    originalSb    = process.env.VITE_SUPABASE_URL;
    originalKey   = process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.DESIGN_CALENDAR_API_TOKEN = TOKEN;
    process.env.VITE_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    vi.mocked(syncOpenPosFromTandaPos).mockReset();
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.DESIGN_CALENDAR_API_TOKEN; else process.env.DESIGN_CALENDAR_API_TOKEN = originalToken;
    if (originalSb    === undefined) delete process.env.VITE_SUPABASE_URL;          else process.env.VITE_SUPABASE_URL = originalSb;
    if (originalKey   === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;  else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
  });

  it("returns 401 when bearer token is missing", async () => {
    const req = makeReq({ token: null });
    const res = makeRes();
    await syncOpenPosHandler(req, res);
    expect(res.statusCode).toBe(401);
    expect(syncOpenPosFromTandaPos).not.toHaveBeenCalled();
  });

  it("returns 200 with upserted count on success", async () => {
    vi.mocked(syncOpenPosFromTandaPos).mockResolvedValue({
      pos_scanned: 50,
      inserted: 1286,
      auto_created_skus: 0,
      cleaned: 12,
      errors: [],
    });
    const req = makeReq();
    const res = makeRes();
    await syncOpenPosHandler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      upserted: 1286,
      auto_created_skus: 0,
      cleaned: 12,
      pos_scanned: 50,
      errors: [],
    });
    expect(syncOpenPosFromTandaPos).toHaveBeenCalledTimes(1);
  });
});

// /api/ats/upload — covered at the auth-gate layer here; the
// pipeline behavior is covered by the existing ats/normalize and
// ats-pipeline tests, which exercise the same shared helpers the
// handler calls.
describe("POST /api/ats/upload — auth gate", () => {
  let uploadHandler;
  let originalToken, originalSb, originalKey;

  beforeEach(async () => {
    originalToken = process.env.DESIGN_CALENDAR_API_TOKEN;
    originalSb    = process.env.VITE_SUPABASE_URL;
    originalKey   = process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.DESIGN_CALENDAR_API_TOKEN = TOKEN;
    process.env.VITE_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    // Reset rate-limit bucket so 429 from earlier tests doesn't bleed in.
    const { _resetRateLimitForTests } = await import("../../_lib/auth.js");
    _resetRateLimitForTests();
    // Imported lazily — handler is heavy and only this block needs it.
    uploadHandler = (await import("../ats/upload.js")).default;
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.DESIGN_CALENDAR_API_TOKEN; else process.env.DESIGN_CALENDAR_API_TOKEN = originalToken;
    if (originalSb    === undefined) delete process.env.VITE_SUPABASE_URL;          else process.env.VITE_SUPABASE_URL = originalSb;
    if (originalKey   === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;  else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
  });

  it("returns 401 when bearer token is missing", async () => {
    const req = makeReq({ token: null });
    const res = makeRes();
    await uploadHandler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 when bearer token is wrong", async () => {
    const req = makeReq({ token: "f" + TOKEN.slice(1) });
    const res = makeRes();
    await uploadHandler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it("returns 405 for GET", async () => {
    const req = makeReq({ method: "GET" });
    const res = makeRes();
    await uploadHandler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it("rate-limits past the 60/hour ceiling", async () => {
    // First call past the gate fails on body parse (no multipart),
    // returning 400 — that still counts toward the rate limit. Burn
    // through the bucket and confirm the next call is 429.
    for (let i = 0; i < 60; i++) {
      const req = { ...makeReq(), on() {}, headers: { authorization: `Bearer ${TOKEN}` } };
      const res = makeRes();
      await uploadHandler(req, res);
      expect([400, 200]).toContain(res.statusCode);
    }
    const req61 = { ...makeReq(), on() {}, headers: { authorization: `Bearer ${TOKEN}` } };
    const res61 = makeRes();
    await uploadHandler(req61, res61);
    expect(res61.statusCode).toBe(429);
    expect(res61.body.error).toMatch(/Rate limit/);
    expect(res61.body.retry_after_s).toBeGreaterThan(0);
  });
});
