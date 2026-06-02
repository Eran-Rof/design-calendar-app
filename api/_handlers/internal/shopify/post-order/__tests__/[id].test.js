// Tangerine P11-3 — tests for /api/internal/shopify/post-order/:id handler.
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

vi.mock("../../../../../_lib/shopify/post-order-je.js", () => ({
  postShopifyOrderJe: vi.fn(),
}));

// Lazy import so the mock is wired before module evaluation
import handler from "../[id].js";
import { postShopifyOrderJe } from "../../../../../_lib/shopify/post-order-je.js";

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

describe("handler [id].js — POST /api/internal/shopify/post-order/:id", () => {
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
    postShopifyOrderJe.mockResolvedValue({
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
    expect(postShopifyOrderJe).toHaveBeenCalledWith(
      expect.objectContaining({ shopifyOrderId: VALID_ID }),
    );
  });

  it("returns 200 with already_posted when service short-circuits", async () => {
    postShopifyOrderJe.mockResolvedValue({
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
    const req = makeReq(); // no auth headers
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toMatch(/internal token/i);
    expect(postShopifyOrderJe).not.toHaveBeenCalled();
  });

  it("returns 401 when wrong token presented", async () => {
    process.env.INTERNAL_API_TOKEN = "right-token-1234";
    const req = makeReq({
      headers: { authorization: "Bearer wrong-token-xxxx" },
    });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it("accepts the correct Bearer token and proceeds", async () => {
    process.env.INTERNAL_API_TOKEN = "right-token";
    postShopifyOrderJe.mockResolvedValue({
      status: "posted", je_id: JE_ID, ar_invoice_id: AR_INV,
    });
    const req = makeReq({
      headers: { authorization: "Bearer right-token" },
    });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it("returns 400 for invalid uuid", async () => {
    const req = makeReq({ id: "not-uuid" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/uuid/);
    expect(postShopifyOrderJe).not.toHaveBeenCalled();
  });

  it("returns 404 when service throws code='not_found'", async () => {
    const err = new Error("shopify_orders xx not found");
    err.code = "not_found";
    postShopifyOrderJe.mockRejectedValue(err);
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 when service throws gl_accounts_missing", async () => {
    const err = new Error("Missing GL accounts: 1200 — AR");
    err.code = "gl_accounts_missing";
    postShopifyOrderJe.mockRejectedValue(err);
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/1200/);
  });

  it("returns 400 on customer_resolution_failed", async () => {
    const err = new Error("no customer email");
    err.code = "customer_resolution_failed";
    postShopifyOrderJe.mockRejectedValue(err);
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("returns 500 on rpc_failed", async () => {
    const err = new Error("period closed");
    err.code = "rpc_failed";
    postShopifyOrderJe.mockRejectedValue(err);
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
  });

  it("returns 500 with je_id when ar_invoice_insert_failed (post-RPC error)", async () => {
    const err = new Error("invoice insert failed");
    err.code = "ar_invoice_insert_failed";
    err.je_id = JE_ID;
    postShopifyOrderJe.mockRejectedValue(err);
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
    expect(res.headers["Allow"]).toBe("POST");
  });

  it("returns 200 on OPTIONS preflight", async () => {
    const req = makeReq({ method: "OPTIONS" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });

  it("sets CORS headers", async () => {
    postShopifyOrderJe.mockResolvedValue({
      status: "posted", je_id: JE_ID, ar_invoice_id: AR_INV,
    });
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("*");
    expect(res.headers["Access-Control-Allow-Methods"]).toMatch(/POST/);
  });
});
