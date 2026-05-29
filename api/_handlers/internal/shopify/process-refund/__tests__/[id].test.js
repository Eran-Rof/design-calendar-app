// Tangerine P11-6 — tests for /api/internal/shopify/process-refund/:id handler.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../../../_lib/shopify/process-refund.js", () => ({
  processShopifyRefund: vi.fn(),
}));

import handler from "../[id].js";
import { processShopifyRefund } from "../../../../../_lib/shopify/process-refund.js";

const VALID_ID = "22222222-2222-2222-2222-222222222222";
const CM_ID    = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const JE_ID    = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const INV_ID   = "cccccccc-cccc-cccc-cccc-cccccccccccc";

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
  return {
    method,
    headers: { ...headers },
    query: { id },
  };
}

describe("handler [id].js — POST /api/internal/shopify/process-refund/:id", () => {
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

  it("returns 200 with voided result (full refund happy path)", async () => {
    processShopifyRefund.mockResolvedValue({
      status: "voided",
      refund_type: "full",
      ar_invoice_id: INV_ID,
      reversed_je_ids: [JE_ID],
    });
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("voided");
    expect(res.body.ar_invoice_id).toBe(INV_ID);
    expect(processShopifyRefund).toHaveBeenCalledWith(
      expect.objectContaining({ shopifyRefundId: VALID_ID }),
    );
  });

  it("returns 200 with credit_memo_posted result (partial refund happy path)", async () => {
    processShopifyRefund.mockResolvedValue({
      status: "credit_memo_posted",
      refund_type: "partial",
      ar_credit_memo_id: CM_ID,
      je_id: JE_ID,
      cogs_je_id: null,
      inventory_layer_ids: [],
    });
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("credit_memo_posted");
    expect(res.body.ar_credit_memo_id).toBe(CM_ID);
  });

  it("returns 200 with already_processed on idempotent re-call", async () => {
    processShopifyRefund.mockResolvedValue({
      status: "already_processed",
      ar_credit_memo_id: CM_ID,
      refund_type: "partial",
    });
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("already_processed");
  });

  it("returns 401 when INTERNAL_API_TOKEN set and no token presented", async () => {
    process.env.INTERNAL_API_TOKEN = "secret-token-1234567890";
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(processShopifyRefund).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid uuid", async () => {
    const req = makeReq({ id: "not-uuid" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/uuid/);
    expect(processShopifyRefund).not.toHaveBeenCalled();
  });

  it("returns 404 when service throws not_found", async () => {
    const err = new Error("shopify_refunds xx not found");
    err.code = "not_found";
    processShopifyRefund.mockRejectedValue(err);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 on parent_ar_invoice_missing", async () => {
    const err = new Error("parent missing");
    err.code = "parent_ar_invoice_missing";
    processShopifyRefund.mockRejectedValue(err);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 on gl_accounts_missing", async () => {
    const err = new Error("Missing GL accounts: 4500");
    err.code = "gl_accounts_missing";
    processShopifyRefund.mockRejectedValue(err);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/4500/);
  });

  it("returns 400 on invalid_amounts", async () => {
    const err = new Error("restocking_fee_cents exceeds refund_amount_cents");
    err.code = "invalid_amounts";
    processShopifyRefund.mockRejectedValue(err);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(400);
  });

  it("returns 500 on rpc_failed", async () => {
    const err = new Error("period closed");
    err.code = "rpc_failed";
    processShopifyRefund.mockRejectedValue(err);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(500);
  });

  it("returns 500 + je_id when ar_invoice_insert_failed", async () => {
    const err = new Error("invoice insert failed");
    err.code = "ar_invoice_insert_failed";
    err.je_id = JE_ID;
    processShopifyRefund.mockRejectedValue(err);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.statusCode).toBe(500);
    expect(res.body.je_id).toBe(JE_ID);
  });

  it("returns 405 on GET", async () => {
    const res = makeRes();
    await handler(makeReq({ method: "GET" }), res);
    expect(res.statusCode).toBe(405);
  });

  it("returns 200 on OPTIONS", async () => {
    const res = makeRes();
    await handler(makeReq({ method: "OPTIONS" }), res);
    expect(res.statusCode).toBe(200);
  });

  it("sets CORS headers", async () => {
    processShopifyRefund.mockResolvedValue({ status: "already_processed", ar_credit_memo_id: CM_ID, refund_type: "partial" });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("*");
  });
});
