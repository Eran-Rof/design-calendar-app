// Tangerine P12a-3 — tests for /api/internal/fba/post-order/:id handler.
//
// Coverage:
//   - 401 when INTERNAL_API_TOKEN set + caller presents no/bad token
//   - 200 + result body when service returns posted
//   - 200 + result body when service returns already_posted
//   - 400 on bad uuid
//   - 404 on not_found
//   - 400 on gl_accounts_missing
//   - 500 on rpc_failed
//   - 405 on non-POST method
//   - OPTIONS preflight returns 200

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../../_lib/marketplaces/fba/post-order-je.js", () => ({
  postFbaOrderJe: vi.fn(),
}));

import handler from "../post-order/[id].js";
import { postFbaOrderJe } from "../../../../_lib/marketplaces/fba/post-order-je.js";

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

describe("handler [id].js — POST /api/internal/fba/post-order/:id", () => {
  const originalEnv = process.env.INTERNAL_API_TOKEN;
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.VITE_SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
    delete process.env.INTERNAL_API_TOKEN; // soft-open by default
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.INTERNAL_API_TOKEN;
    else process.env.INTERNAL_API_TOKEN = originalEnv;
  });

  it("returns 200 with posted result on happy path", async () => {
    postFbaOrderJe.mockResolvedValue({
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
    expect(postFbaOrderJe).toHaveBeenCalledWith(
      expect.objectContaining({ fbaOrderId: VALID_ID }),
    );
  });

  it("returns 200 with already_posted when service short-circuits", async () => {
    postFbaOrderJe.mockResolvedValue({
      status: "already_posted",
      je_id: JE_ID,
    });
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("already_posted");
  });

  it("returns 401 when INTERNAL_API_TOKEN set and no token presented", async () => {
    process.env.INTERNAL_API_TOKEN = "shhh-secret";
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toMatch(/internal token/i);
    expect(postFbaOrderJe).not.toHaveBeenCalled();
  });

  it("returns 200 when INTERNAL_API_TOKEN set and valid token presented", async () => {
    process.env.INTERNAL_API_TOKEN = "shhh-secret";
    postFbaOrderJe.mockResolvedValue({
      status: "posted", je_id: JE_ID, ar_invoice_id: AR_INV,
    });
    const req = makeReq({ headers: { authorization: "Bearer shhh-secret" } });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it("returns 400 on invalid uuid", async () => {
    const req = makeReq({ id: "not-a-uuid" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/uuid/i);
  });

  it("returns 404 when service throws not_found", async () => {
    const err = new Error("fba_orders missing");
    err.code = "not_found";
    postFbaOrderJe.mockRejectedValue(err);
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toMatch(/missing/);
  });

  it("returns 400 when service throws gl_accounts_missing", async () => {
    const err = new Error("Missing GL accounts: 1200");
    err.code = "gl_accounts_missing";
    postFbaOrderJe.mockRejectedValue(err);
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/1200/);
  });

  it("returns 500 when service throws rpc_failed", async () => {
    const err = new Error("RPC boom");
    err.code = "rpc_failed";
    postFbaOrderJe.mockRejectedValue(err);
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
  });

  it("returns 500 with je_id when ar_invoice_insert_failed", async () => {
    const err = new Error("invoice insert failed");
    err.code = "ar_invoice_insert_failed";
    err.je_id = JE_ID;
    postFbaOrderJe.mockRejectedValue(err);
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.je_id).toBe(JE_ID);
  });

  it("returns 500 with je_id + ar_invoice_id on fba_orders_update_failed", async () => {
    const err = new Error("update failed");
    err.code = "fba_orders_update_failed";
    err.je_id = JE_ID;
    err.ar_invoice_id = AR_INV;
    postFbaOrderJe.mockRejectedValue(err);
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.je_id).toBe(JE_ID);
    expect(res.body.ar_invoice_id).toBe(AR_INV);
  });

  it("returns 405 on GET / non-POST methods", async () => {
    const req = makeReq({ method: "GET" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe("POST");
  });

  it("returns 200 on OPTIONS preflight", async () => {
    const req = makeReq({ method: "OPTIONS" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("*");
  });
});
