// Tests for Tangerine T6-2 global search handler.
//
// Pure-shape tests for the validator + handler. Supabase RPC is mocked.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(),
}));

import handler, { validateQuery } from "../index.js";
import { createClient } from "@supabase/supabase-js";

function P(o) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) sp.set(k, String(v));
  return sp;
}

function mockReq(opts = {}) {
  const { q, limit } = opts;
  // Use hasOwnProperty so explicit `auth: undefined` actually drops the header.
  const auth = Object.prototype.hasOwnProperty.call(opts, "auth")
    ? opts.auth
    : "Bearer test-jwt-token";
  const params = new URLSearchParams();
  if (q != null) params.set("q", q);
  if (limit != null) params.set("limit", String(limit));
  const qs = params.toString();
  const headers = { host: "localhost" };
  if (auth !== undefined) headers.authorization = auth;
  return {
    method: "GET",
    headers,
    url: `/api/internal/search${qs ? "?" + qs : ""}`,
  };
}

function mockRes() {
  return {
    statusCode: 200,
    _headers: {},
    _payload: undefined,
    setHeader(k, v) { this._headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(p) { this._payload = p; return this; },
    end() { return this; },
  };
}

function installSupabaseMock(rpcResult) {
  const rpc = vi.fn().mockResolvedValue(rpcResult);
  createClient.mockReturnValue({ rpc });
  return { rpc };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.VITE_SUPABASE_URL = "https://example.supabase.co";
  process.env.VITE_SUPABASE_ANON_KEY = "anon-key";
});

// ──────────────────────────────── validateQuery ────────────────────────────
describe("validateQuery", () => {
  it("rejects missing q", () => {
    expect(validateQuery(P({})).error).toMatch(/q is required/);
  });

  it("rejects q shorter than 2 chars", () => {
    expect(validateQuery(P({ q: "a" })).error).toMatch(/at least 2/);
  });

  it("rejects whitespace-only q (trims to empty)", () => {
    expect(validateQuery(P({ q: "   " })).error).toMatch(/at least 2/);
  });

  it("rejects q longer than 200 chars", () => {
    const long = "a".repeat(201);
    expect(validateQuery(P({ q: long })).error).toMatch(/at most 200/);
  });

  it("accepts a 2-char q at the boundary", () => {
    const v = validateQuery(P({ q: "ab" }));
    expect(v.error).toBeUndefined();
    expect(v.data.q).toBe("ab");
    expect(v.data.limit).toBe(30);
  });

  it("accepts a 200-char q at the boundary", () => {
    const q200 = "x".repeat(200);
    const v = validateQuery(P({ q: q200 }));
    expect(v.error).toBeUndefined();
    expect(v.data.q.length).toBe(200);
  });

  it("trims q before validating", () => {
    const v = validateQuery(P({ q: "  hello  " }));
    expect(v.data.q).toBe("hello");
  });

  it("defaults limit to 30 when omitted", () => {
    const v = validateQuery(P({ q: "abc" }));
    expect(v.data.limit).toBe(30);
  });

  it("clamps limit > 100 down to 100", () => {
    const v = validateQuery(P({ q: "abc", limit: 500 }));
    expect(v.data.limit).toBe(100);
  });

  it("clamps limit < 1 up to 1", () => {
    const v = validateQuery(P({ q: "abc", limit: 0 }));
    expect(v.data.limit).toBe(1);
  });

  it("rejects non-numeric limit", () => {
    expect(validateQuery(P({ q: "abc", limit: "abc" })).error).toMatch(/limit must be/);
  });

  it("accepts explicit limit in [1, 100]", () => {
    const v = validateQuery(P({ q: "abc", limit: 50 }));
    expect(v.data.limit).toBe(50);
  });
});

// ──────────────────────────────── handler ─────────────────────────────────
describe("handler — auth", () => {
  it("returns 401 when Authorization header is missing", async () => {
    installSupabaseMock({ data: [], error: null });
    const req = mockReq({ q: "abc", auth: undefined });
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res._payload.error).toMatch(/Authentication required/i);
  });

  it("returns 401 when Authorization header does not start with Bearer", async () => {
    installSupabaseMock({ data: [], error: null });
    const req = mockReq({ q: "abc", auth: "Basic xxx" });
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 when Bearer token is empty", async () => {
    installSupabaseMock({ data: [], error: null });
    const req = mockReq({ q: "abc", auth: "Bearer " });
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });
});

describe("handler — validation", () => {
  it("returns 400 when q is missing", async () => {
    installSupabaseMock({ data: [], error: null });
    const req = mockReq({ q: undefined });
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res._payload.error).toMatch(/q is required/);
  });

  it("returns 400 when q is too short", async () => {
    installSupabaseMock({ data: [], error: null });
    const req = mockReq({ q: "a" });
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res._payload.error).toMatch(/at least 2/);
  });

  it("returns 400 when q is too long", async () => {
    installSupabaseMock({ data: [], error: null });
    const req = mockReq({ q: "b".repeat(201) });
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res._payload.error).toMatch(/at most 200/);
  });

  it("returns 405 for non-GET methods", async () => {
    installSupabaseMock({ data: [], error: null });
    const req = mockReq({ q: "abc" });
    req.method = "POST";
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });
});

describe("handler — RPC behavior", () => {
  it("returns 200 with empty results when RPC returns no rows", async () => {
    installSupabaseMock({ data: [], error: null });
    const req = mockReq({ q: "nomatch" });
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res._payload).toEqual({ results: [] });
  });

  it("returns 200 with results shape { results: [...] }", async () => {
    const rows = [
      {
        entity_type: "customer",
        entity_id: "cust-1",
        title: "Acme Corp",
        subtitle: "ACM",
        rank: 0.5,
        route_hint: "/customers/cust-1",
      },
      {
        entity_type: "vendor",
        entity_id: "vend-1",
        title: "Acme Supplies",
        subtitle: "ACME-SUP",
        rank: 0.3,
        route_hint: "/vendors/vend-1",
      },
    ];
    installSupabaseMock({ data: rows, error: null });
    const req = mockReq({ q: "acme" });
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res._payload).toEqual({ results: rows });
  });

  it("passes default limit of 30 to the RPC when limit param omitted", async () => {
    const { rpc } = installSupabaseMock({ data: [], error: null });
    const req = mockReq({ q: "abc" });
    const res = mockRes();
    await handler(req, res);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("global_search", {
      q: "abc",
      max_results: 30,
    });
  });

  it("clamps limit=500 to 100 before calling the RPC", async () => {
    const { rpc } = installSupabaseMock({ data: [], error: null });
    const req = mockReq({ q: "abc", limit: 500 });
    const res = mockRes();
    await handler(req, res);
    expect(rpc).toHaveBeenCalledWith("global_search", {
      q: "abc",
      max_results: 100,
    });
  });

  it("clamps limit=0 up to 1 before calling the RPC", async () => {
    const { rpc } = installSupabaseMock({ data: [], error: null });
    const req = mockReq({ q: "abc", limit: 0 });
    const res = mockRes();
    await handler(req, res);
    expect(rpc).toHaveBeenCalledWith("global_search", {
      q: "abc",
      max_results: 1,
    });
  });

  it("forwards the user JWT to the Supabase client via Authorization header", async () => {
    installSupabaseMock({ data: [], error: null });
    const req = mockReq({ q: "abc", auth: "Bearer the-user-jwt" });
    const res = mockRes();
    await handler(req, res);
    expect(createClient).toHaveBeenCalledWith(
      "https://example.supabase.co",
      "anon-key",
      expect.objectContaining({
        global: { headers: { Authorization: "Bearer the-user-jwt" } },
      }),
    );
  });

  it("returns 500 when the RPC fails", async () => {
    installSupabaseMock({ data: null, error: { message: "RLS denied" } });
    const req = mockReq({ q: "abc" });
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    expect(res._payload.error).toMatch(/RLS denied/);
  });

  it("returns 500 when env vars are missing", async () => {
    delete process.env.VITE_SUPABASE_URL;
    const req = mockReq({ q: "abc" });
    const res = mockRes();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    expect(res._payload.error).toMatch(/Server not configured/);
  });
});
