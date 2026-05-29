// Tangerine P12b-3 — tests for /api/internal/walmart/post-order/:id handler.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../../_lib/marketplaces/walmart/post-order-je.js", () => ({
  postWalmartOrderJe: vi.fn(),
}));

import handler from "../post-order/[id].js";
import { postWalmartOrderJe } from "../../../../_lib/marketplaces/walmart/post-order-je.js";

const VALID_ID = "22222222-2222-2222-2222-222222222222";
const JE_ID    = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const AR_INV   = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

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

function makeReq({ method = "POST", id = VALID_ID, headers = {} } = {}) {
  return { method, headers: { ...headers }, query: { id } };
}

describe("POST /api/internal/walmart/post-order/:id", () => {
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

  it("200 with posted result on happy path", async () => {
    postWalmartOrderJe.mockResolvedValue({
      status: "posted", je_id: JE_ID, ar_invoice_id: AR_INV,
    });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: "posted", je_id: JE_ID, ar_invoice_id: AR_INV,
    });
    expect(postWalmartOrderJe).toHaveBeenCalledWith(
      expect.objectContaining({ walmartOrderId: VALID_ID }),
    );
  });

  it("200 with already_posted when service short-circuits", async () => {
    postWalmartOrderJe.mockResolvedValue({
      status: "already_posted", je_id: JE_ID,
    });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("already_posted");
  });

  it("401 when INTERNAL_API_TOKEN set + no token presented", async () => {
    process.env.INTERNAL_API_TOKEN = "secret-token";
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(401);
    expect(postWalmartOrderJe).not.toHaveBeenCalled();
  });

  it("401 when wrong Bearer token presented", async () => {
    process.env.INTERNAL_API_TOKEN = "right-token-1234";
    const res = makeRes();
    await handler(makeReq({
      headers: { authorization: "Bearer wrong-token" },
    }), res);
    expect(res.statusCode).toBe(401);
  });

  it("accepts correct Bearer token", async () => {
    process.env.INTERNAL_API_TOKEN = "right-token";
    postWalmartOrderJe.mockResolvedValue({
      status: "posted", je_id: JE_ID, ar_invoice_id: AR_INV,
    });
    const res = makeRes();
    await handler(makeReq({
      headers: { authorization: "Bearer right-token" },
    }), res);
    expect(res.statusCode).toBe(200);
  });

  it("400 on bad uuid", async () => {
    const res = makeRes();
    await handler(makeReq({ id: "not-a-uuid" }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/uuid/);
    expect(postWalmartOrderJe).not.toHaveBeenCalled();
  });

  it("404 on not_found", async () => {
    const err = new Error("walmart_orders xx not found");
    err.code = "not_found";
    postWalmartOrderJe.mockRejectedValue(err);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(404);
  });

  it("400 on gl_accounts_missing", async () => {
    const err = new Error("Missing GL accounts: 1200 — AR");
    err.code = "gl_accounts_missing";
    postWalmartOrderJe.mockRejectedValue(err);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/1200/);
  });

  it("400 on customer_resolution_failed", async () => {
    const err = new Error("no customer key");
    err.code = "customer_resolution_failed";
    postWalmartOrderJe.mockRejectedValue(err);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(400);
  });

  it("500 on rpc_failed", async () => {
    const err = new Error("period closed");
    err.code = "rpc_failed";
    postWalmartOrderJe.mockRejectedValue(err);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(500);
  });

  it("500 with je_id when ar_invoice_insert_failed", async () => {
    const err = new Error("invoice insert failed");
    err.code = "ar_invoice_insert_failed";
    err.je_id = JE_ID;
    postWalmartOrderJe.mockRejectedValue(err);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(500);
    expect(res.body.je_id).toBe(JE_ID);
  });

  it("500 with je_id + ar_invoice_id when walmart_orders_update_failed", async () => {
    const err = new Error("update failed");
    err.code = "walmart_orders_update_failed";
    err.je_id = JE_ID;
    err.ar_invoice_id = AR_INV;
    postWalmartOrderJe.mockRejectedValue(err);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(500);
    expect(res.body.je_id).toBe(JE_ID);
    expect(res.body.ar_invoice_id).toBe(AR_INV);
  });

  it("405 on GET", async () => {
    const res = makeRes();
    await handler(makeReq({ method: "GET" }), res);
    expect(res.statusCode).toBe(405);
    expect(res.headers["Allow"]).toBe("POST");
  });

  it("200 on OPTIONS preflight", async () => {
    const res = makeRes();
    await handler(makeReq({ method: "OPTIONS" }), res);
    expect(res.statusCode).toBe(200);
  });

  it("sets CORS headers", async () => {
    postWalmartOrderJe.mockResolvedValue({
      status: "posted", je_id: JE_ID, ar_invoice_id: AR_INV,
    });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("*");
    expect(res.headers["Access-Control-Allow-Methods"]).toMatch(/POST/);
  });
});
