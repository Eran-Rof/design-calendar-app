// Tests for Tangerine P11-8 Shopify dispute webhook intake handler.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(),
}));

vi.mock("../../../../../_lib/shopify/process-dispute.js", () => ({
  processShopifyDispute: vi.fn(),
}));

import handler, {
  verifyShopifyHmac,
  headerValue,
} from "../disputes.js";
import { createClient } from "@supabase/supabase-js";
import { processShopifyDispute } from "../../../../../_lib/shopify/process-dispute.js";

const STORE_UUID   = "11111111-1111-1111-1111-111111111111";
const ENTITY_UUID  = "22222222-2222-2222-2222-222222222222";
const LOG_UUID     = "44444444-4444-4444-4444-444444444444";
const CASE_UUID    = "55555555-5555-5555-5555-555555555555";
const JE_UUID      = "66666666-6666-6666-6666-666666666666";
const DISPUTE_UUID = "77777777-7777-7777-7777-777777777777";

const SECRET = "shpss_test_webhook_secret";

function samplePayload() {
  return {
    id: 90001,
    order_id: 5001,
    type: "chargeback",
    amount: "129.99",
    currency: "USD",
    reason: "fraudulent",
    status: "needs_response",
    evidence_due_by: "2026-06-10T00:00:00Z",
  };
}

function sign(body, secret = SECRET) {
  return createHmac("sha256", secret).update(body, "utf8").digest("base64");
}

function mockReq({
  body,
  signed = true,
  secret = SECRET,
  webhookId = "WH-DISPUTE-1",
  shopDomain = "rof.myshopify.com",
  topic = "disputes/create",
} = {}) {
  const raw = JSON.stringify(body);
  const headers = {
    "content-type": "application/json",
    "x-shopify-shop-domain": shopDomain,
    "x-shopify-topic": topic,
    "x-shopify-webhook-id": webhookId,
  };
  if (signed) headers["x-shopify-hmac-sha256"] = sign(raw, secret);
  return {
    method: "POST",
    headers,
    url: "/api/internal/shopify/webhooks/disputes",
    body,
    readable: false,
  };
}

function mockRes() {
  return {
    statusCode: 200,
    _headers: {},
    setHeader(k, v) { this._headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(p) { this._payload = p; return this; },
    end() { return this; },
  };
}

function makeSupabase({
  store = { id: STORE_UUID, entity_id: ENTITY_UUID },
  existingLog = null,
  logInsertReturn = { id: LOG_UUID },
  logInsertError = null,
} = {}) {
  const calls = {
    logInserts: [],
    logUpdates: [],
    logUpserts: [],
    storeUpdates: [],
  };

  return {
    __calls: calls,
    from(table) {
      if (table === "shopify_stores") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: store, error: null }),
            }),
          }),
          update: (row) => {
            calls.storeUpdates.push(row);
            return { eq: async () => ({ data: row, error: null }) };
          },
        };
      }
      if (table === "shopify_webhook_log") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: existingLog, error: null }),
            }),
          }),
          insert: (row) => {
            calls.logInserts.push(row);
            return {
              select: () => ({
                single: async () => ({
                  data: logInsertError ? null : logInsertReturn,
                  error: logInsertError,
                }),
              }),
            };
          },
          upsert: (row) => {
            calls.logUpserts.push(row);
            return Promise.resolve({ data: row, error: null });
          },
          update: (row) => {
            calls.logUpdates.push(row);
            return { eq: async () => ({ data: row, error: null }) };
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
}

beforeEach(() => {
  process.env.VITE_SUPABASE_URL = "http://localhost";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
  process.env.SHOPIFY_WEBHOOK_SECRET = SECRET;
  delete process.env.SHOPIFY_WEBHOOK_SKIP_VERIFY;
  vi.clearAllMocks();
  processShopifyDispute.mockResolvedValue({
    status: "processed",
    dispute_id: DISPUTE_UUID,
    case_id: CASE_UUID,
    je_id: JE_UUID,
  });
});

afterEach(() => {
  delete process.env.SHOPIFY_WEBHOOK_SECRET;
  delete process.env.SHOPIFY_WEBHOOK_SKIP_VERIFY;
});

// ────────────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────────────

describe("verifyShopifyHmac (disputes handler)", () => {
  it("accepts a correctly-signed body", () => {
    const body = JSON.stringify({ a: 1 });
    expect(verifyShopifyHmac(sign(body), body, SECRET)).toBe(true);
  });
  it("rejects a tampered body", () => {
    const body = JSON.stringify({ a: 1 });
    const sig = sign(body);
    expect(verifyShopifyHmac(sig, JSON.stringify({ a: 2 }), SECRET)).toBe(false);
  });
  it("rejects missing inputs", () => {
    expect(verifyShopifyHmac(null, "body", SECRET)).toBe(false);
    expect(verifyShopifyHmac("sig", "", SECRET)).toBe(false);
    expect(verifyShopifyHmac("sig", "body", "")).toBe(false);
  });
});

describe("headerValue (disputes handler)", () => {
  it("returns the lowercased-key value", () => {
    const req = { headers: { "x-shopify-shop-domain": "rof.myshopify.com" } };
    expect(headerValue(req, "X-Shopify-Shop-Domain")).toBe("rof.myshopify.com");
  });
  it("returns null when absent", () => {
    expect(headerValue({ headers: {} }, "x-y")).toBe(null);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Handler integration
// ────────────────────────────────────────────────────────────────────────

describe("disputes webhook handler", () => {
  it("405s non-POST", async () => {
    const sb = makeSupabase();
    createClient.mockReturnValue(sb);
    const res = mockRes();
    await handler({ method: "GET", headers: {}, url: "" }, res);
    expect(res.statusCode).toBe(405);
  });

  it("401s when HMAC is invalid", async () => {
    const sb = makeSupabase();
    createClient.mockReturnValue(sb);
    const res = mockRes();
    const req = mockReq({ body: samplePayload() });
    req.headers["x-shopify-hmac-sha256"] = "bogus";
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(res._payload.error).toMatch(/HMAC/);
  });

  it("401s when SHOPIFY_WEBHOOK_SECRET env is missing (and not skipping)", async () => {
    delete process.env.SHOPIFY_WEBHOOK_SECRET;
    const sb = makeSupabase();
    createClient.mockReturnValue(sb);
    const res = mockRes();
    await handler(mockReq({ body: samplePayload() }), res);
    expect(res.statusCode).toBe(401);
    expect(res._payload.error).toMatch(/secret/);
  });

  it("skips HMAC verify when SHOPIFY_WEBHOOK_SKIP_VERIFY=true", async () => {
    process.env.SHOPIFY_WEBHOOK_SKIP_VERIFY = "true";
    const sb = makeSupabase();
    createClient.mockReturnValue(sb);
    const res = mockRes();
    const req = mockReq({ body: samplePayload(), signed: false });
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res._payload.status).toBe("processed");
  });

  it("processes a valid HMAC + new dispute end-to-end", async () => {
    const sb = makeSupabase();
    createClient.mockReturnValue(sb);
    const res = mockRes();
    await handler(mockReq({ body: samplePayload() }), res);

    expect(res.statusCode).toBe(200);
    expect(res._payload.status).toBe("processed");
    expect(res._payload.dispute_id).toBe(DISPUTE_UUID);
    expect(res._payload.case_id).toBe(CASE_UUID);
    expect(res._payload.je_id).toBe(JE_UUID);

    // webhook_log insert with topic disputes/create.
    expect(sb.__calls.logInserts).toHaveLength(1);
    expect(sb.__calls.logInserts[0].topic).toBe("disputes/create");
    // Service was invoked with the right inputs.
    expect(processShopifyDispute).toHaveBeenCalledTimes(1);
    const arg = processShopifyDispute.mock.calls[0][0];
    expect(arg.shopDomain).toBe("rof.myshopify.com");
    expect(arg.payload.id).toBe(90001);
    // status='processed' update happened.
    const processedUpdate = sb.__calls.logUpdates.find((u) => u.status === "processed");
    expect(processedUpdate).toBeTruthy();
    // last_webhook_at touched on the store row.
    expect(sb.__calls.storeUpdates.some((u) => u.last_webhook_at)).toBe(true);
  });

  it("returns 200 duplicate when webhook_id already in log", async () => {
    const sb = makeSupabase({ existingLog: { id: "old-log-id", status: "processed" } });
    createClient.mockReturnValue(sb);
    const res = mockRes();
    await handler(mockReq({ body: samplePayload() }), res);
    expect(res.statusCode).toBe(200);
    expect(res._payload.status).toBe("duplicate");
    expect(processShopifyDispute).not.toHaveBeenCalled();
  });

  it("returns 200 ignored + upserts log row when shop_domain unknown", async () => {
    const sb = makeSupabase({ store: null });
    createClient.mockReturnValue(sb);
    const res = mockRes();
    await handler(mockReq({ body: samplePayload(), shopDomain: "ghost.myshopify.com" }), res);
    expect(res.statusCode).toBe(200);
    expect(res._payload.status).toBe("ignored");
    expect(res._payload.reason).toBe("unknown_shop");
    expect(sb.__calls.logUpserts).toHaveLength(1);
    expect(processShopifyDispute).not.toHaveBeenCalled();
  });

  it("400s when X-Shopify-Shop-Domain is missing", async () => {
    const sb = makeSupabase();
    createClient.mockReturnValue(sb);
    const res = mockRes();
    const req = mockReq({ body: samplePayload() });
    delete req.headers["x-shopify-shop-domain"];
    req.headers["x-shopify-hmac-sha256"] = sign(JSON.stringify(samplePayload()));
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res._payload.error).toMatch(/Shop-Domain/);
  });

  it("400s when X-Shopify-Webhook-Id is missing", async () => {
    const sb = makeSupabase();
    createClient.mockReturnValue(sb);
    const res = mockRes();
    const req = mockReq({ body: samplePayload() });
    delete req.headers["x-shopify-webhook-id"];
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res._payload.error).toMatch(/Webhook-Id/);
  });

  it("400s on invalid JSON body", async () => {
    const sb = makeSupabase();
    createClient.mockReturnValue(sb);
    const res = mockRes();
    const raw = "not json";
    const headers = {
      "content-type": "application/json",
      "x-shopify-shop-domain": "rof.myshopify.com",
      "x-shopify-topic": "disputes/create",
      "x-shopify-webhook-id": "WH-DISPUTE-1",
      "x-shopify-hmac-sha256": sign(raw),
    };
    await handler({
      method: "POST",
      headers,
      url: "/api/internal/shopify/webhooks/disputes",
      body: raw,
      readable: false,
    }, res);
    expect(res.statusCode).toBe(400);
    expect(res._payload.error).toMatch(/invalid JSON/);
  });

  it("logs failed status when the processing service throws", async () => {
    processShopifyDispute.mockRejectedValue(new Error("RPC went boom"));
    const sb = makeSupabase();
    createClient.mockReturnValue(sb);
    const res = mockRes();
    await handler(mockReq({ body: samplePayload() }), res);
    expect(res.statusCode).toBe(500);
    expect(res._payload.error).toMatch(/RPC went boom/);
    const failed = sb.__calls.logUpdates.find((u) => u.status === "failed");
    expect(failed).toBeTruthy();
    expect(failed.error_message).toMatch(/RPC went boom/);
  });

  it("returns the already_processed status from the service when dispute pre-exists", async () => {
    processShopifyDispute.mockResolvedValue({
      status: "already_processed",
      dispute_id: "old-dispute",
      shopify_dispute_id: "90001",
    });
    const sb = makeSupabase();
    createClient.mockReturnValue(sb);
    const res = mockRes();
    await handler(mockReq({ body: samplePayload() }), res);
    expect(res.statusCode).toBe(200);
    expect(res._payload.status).toBe("already_processed");
    expect(res._payload.dispute_id).toBe("old-dispute");
  });
});
