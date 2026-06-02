// Tangerine P12c-3 — tests for /api/internal/faire/post-order/:id handler.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../../../_lib/marketplaces/faire/post-order-je.js", () => ({
  postFaireOrderJe: vi.fn(),
}));

import handler from "../[id].js";
import { postFaireOrderJe } from "../../../../../_lib/marketplaces/faire/post-order-je.js";

const VALID_ID = "22222222-2222-2222-2222-222222222222";
const JE_ID    = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const AR_INV   = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function makeRes() {
  const r = {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end() { this.body = ""; return this; },
  };
  return r;
}

function makeReq({ method = "POST", id = VALID_ID, headers = {} } = {}) {
  return {
    method,
    headers: { ...headers },
    query: { id },
  };
}

describe("handler [id].js — POST /api/internal/faire/post-order/:id", () => {
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

  it("returns 200 with posted result on happy path", async () => {
    postFaireOrderJe.mockResolvedValue({
      status: "posted",
      je_id: JE_ID,
      ar_invoice_id: AR_INV,
    });
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: "posted",
      je_id: JE_ID,
      ar_invoice_id: AR_INV,
    });
    expect(postFaireOrderJe).toHaveBeenCalledWith(
      expect.objectContaining({ faireOrderId: VALID_ID }),
    );
  });

  it("returns 200 with already_posted when service short-circuits", async () => {
    postFaireOrderJe.mockResolvedValue({
      status: "already_posted",
      je_id: JE_ID,
    });
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("already_posted");
  });

  it("returns 401 when INTERNAL_API_TOKEN set and no token", async () => {
    process.env.INTERNAL_API_TOKEN = "shhh-secret";
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(postFaireOrderJe).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid uuid", async () => {
    const req = makeReq({ id: "not-uuid" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/uuid/);
    expect(postFaireOrderJe).not.toHaveBeenCalled();
  });

  it("returns 404 on not_found", async () => {
    const err = new Error("not found");
    err.code = "not_found";
    postFaireOrderJe.mockRejectedValue(err);
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 on gl_accounts_missing", async () => {
    const err = new Error("Missing GL accounts: 1115");
    err.code = "gl_accounts_missing";
    postFaireOrderJe.mockRejectedValue(err);
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/1115/);
  });

  it("returns 500 on rpc_failed", async () => {
    const err = new Error("period closed");
    err.code = "rpc_failed";
    postFaireOrderJe.mockRejectedValue(err);
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
  });

  it("returns 500 with je_id on ar_invoice_insert_failed", async () => {
    const err = new Error("invoice insert failed");
    err.code = "ar_invoice_insert_failed";
    err.je_id = JE_ID;
    postFaireOrderJe.mockRejectedValue(err);
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.je_id).toBe(JE_ID);
  });

  it("returns 405 on GET", async () => {
    const req = makeReq({ method: "GET" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it("returns 200 on OPTIONS preflight", async () => {
    const req = makeReq({ method: "OPTIONS" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it("sets CORS headers", async () => {
    postFaireOrderJe.mockResolvedValue({
      status: "posted", je_id: JE_ID, ar_invoice_id: AR_INV,
    });
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("*");
  });
});
