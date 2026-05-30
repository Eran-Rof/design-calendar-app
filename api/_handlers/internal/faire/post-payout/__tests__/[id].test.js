// Tangerine P12c-3 — tests for /api/internal/faire/post-payout/:id handler.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../../../_lib/marketplaces/faire/post-payout-je.js", () => ({
  postFairePayoutJe: vi.fn(),
}));

import handler from "../[id].js";
import { postFairePayoutJe } from "../../../../../_lib/marketplaces/faire/post-payout-je.js";

const VALID_ID = "22222222-2222-2222-2222-222222222222";
const JE_ID    = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const BANK_TXN = "88888888-8888-8888-8888-888888888888";

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

describe("handler [id].js — POST /api/internal/faire/post-payout/:id", () => {
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

  it("returns 200 on happy path", async () => {
    postFairePayoutJe.mockResolvedValue({
      status: "posted", je_id: JE_ID, bank_transaction_id: BANK_TXN,
    });
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.je_id).toBe(JE_ID);
    expect(res.body.bank_transaction_id).toBe(BANK_TXN);
    expect(postFairePayoutJe).toHaveBeenCalledWith(
      expect.objectContaining({ fairePayoutId: VALID_ID }),
    );
  });

  it("returns 200 with already_posted", async () => {
    postFairePayoutJe.mockResolvedValue({ status: "already_posted", je_id: JE_ID });
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("already_posted");
  });

  it("returns 401 when INTERNAL_API_TOKEN set + no token", async () => {
    process.env.INTERNAL_API_TOKEN = "secret";
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(postFairePayoutJe).not.toHaveBeenCalled();
  });

  it("returns 400 on bad uuid", async () => {
    const req = makeReq({ id: "bad" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(postFairePayoutJe).not.toHaveBeenCalled();
  });

  it("returns 404 on not_found", async () => {
    const err = new Error("not found");
    err.code = "not_found";
    postFairePayoutJe.mockRejectedValue(err);
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 on gl_accounts_missing", async () => {
    const err = new Error("Missing GL: 1115");
    err.code = "gl_accounts_missing";
    postFairePayoutJe.mockRejectedValue(err);
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("returns 500 on rpc_failed", async () => {
    const err = new Error("period locked");
    err.code = "rpc_failed";
    postFairePayoutJe.mockRejectedValue(err);
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(500);
  });

  it("returns 500 with je_id on faire_payouts_update_failed", async () => {
    const err = new Error("upd fail");
    err.code = "faire_payouts_update_failed";
    err.je_id = JE_ID;
    postFairePayoutJe.mockRejectedValue(err);
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

  it("returns 200 on OPTIONS", async () => {
    const req = makeReq({ method: "OPTIONS" });
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
  });
});
