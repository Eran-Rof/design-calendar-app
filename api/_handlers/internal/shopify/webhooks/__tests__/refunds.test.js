// Tangerine P11-6 — tests for the /api/internal/shopify/webhooks/refunds handler.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(),
}));

vi.mock("../../../../../_lib/shopify/process-refund.js", () => ({
  processShopifyRefund: vi.fn(),
}));

import handler, {
  verifyShopifyHmac,
  buildRefundRow,
  computeRefundAmountCents,
  computeRestockingFeeCents,
  extractRefundsFromPayload,
  dollarsToCents,
  upsertAndProcessRefund,
  headerValue,
} from "../refunds.js";
import { createClient } from "@supabase/supabase-js";
import { processShopifyRefund } from "../../../../../_lib/shopify/process-refund.js";

const STORE_UUID  = "11111111-1111-1111-1111-111111111111";
const ENTITY_UUID = "22222222-2222-2222-2222-222222222222";
const ORDER_UUID  = "33333333-3333-3333-3333-333333333333";
const REFUND_UUID = "44444444-4444-4444-4444-444444444444";
const LOG_UUID    = "55555555-5555-5555-5555-555555555555";
const CM_ID       = "66666666-6666-6666-6666-666666666666";

const SECRET = "shpss_test_webhook_secret";

function sampleRefundPayload({ orderId = 5001, refundId = 8001 } = {}) {
  return {
    id: refundId,
    order_id: orderId,
    processed_at: "2026-05-28T11:00:00Z",
    created_at: "2026-05-28T11:00:00Z",
    refund_line_items: [
      {
        id: 1,
        line_item_id: 9001,
        quantity: 1,
        restock_type: "return",
        subtotal: "49.99",
        total_tax: "5.00",
      },
    ],
    transactions: [
      { kind: "refund", status: "success", amount: "54.99" },
    ],
    order_adjustments: [
      { kind: "restocking_fee", amount: "5.00" },
    ],
  };
}

function sign(body, secret = SECRET) {
  return createHmac("sha256", secret).update(body, "utf8").digest("base64");
}

function mockReq({
  body,
  signed = true,
  secret = SECRET,
  webhookId = "WH-R-1",
  shopDomain = "rof.myshopify.com",
  topic = "refunds/create",
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
    url: "/api/internal/shopify/webhooks/refunds",
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
  parentOrder = { id: ORDER_UUID, entity_id: ENTITY_UUID, total_amount_cents: "12999", ar_invoice_id: null },
  refundUpsertReturn = { id: REFUND_UUID, ar_credit_memo_id: null, refund_type: "partial" },
  logInsertReturn = { id: LOG_UUID },
  logInsertError = null,
} = {}) {
  const calls = {
    refundUpserts: [], logInserts: [], logUpdates: [], logUpserts: [], storeUpdates: [],
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
      if (table === "shopify_orders") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: parentOrder, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === "shopify_refunds") {
        return {
          upsert: (row) => {
            calls.refundUpserts.push(row);
            return {
              select: () => ({
                single: async () => ({ data: refundUpsertReturn, error: null }),
              }),
            };
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
});

afterEach(() => {
  delete process.env.SHOPIFY_WEBHOOK_SECRET;
  delete process.env.SHOPIFY_WEBHOOK_SKIP_VERIFY;
});

// ────────────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────────────

describe("verifyShopifyHmac", () => {
  it("accepts a correctly-signed body", () => {
    const body = JSON.stringify({ a: 1 });
    expect(verifyShopifyHmac(sign(body), body, SECRET)).toBe(true);
  });
  it("rejects tampered body", () => {
    expect(verifyShopifyHmac(sign("{}"), "{\"a\":1}", SECRET)).toBe(false);
  });
});

describe("dollarsToCents", () => {
  it("rounds strings to cents", () => {
    expect(dollarsToCents("12.99")).toBe(1299);
    expect(dollarsToCents("0")).toBe(0);
    expect(dollarsToCents("0.01")).toBe(1);
  });
  it("handles null/empty/junk", () => {
    expect(dollarsToCents(null)).toBe(0);
    expect(dollarsToCents("")).toBe(0);
    expect(dollarsToCents("abc")).toBe(0);
  });
});

describe("computeRefundAmountCents", () => {
  it("prefers successful refund transactions", () => {
    expect(computeRefundAmountCents(sampleRefundPayload())).toBe(5499);
  });

  it("falls back to refund_line_items subtotal+tax when no transactions", () => {
    const p = sampleRefundPayload();
    p.transactions = [];
    // 4999 + 500 = 5499
    expect(computeRefundAmountCents(p)).toBe(5499);
  });

  it("includes order_adjustments fallback absolute amounts", () => {
    const p = {
      refund_line_items: [],
      transactions: [],
      order_adjustments: [{ amount: "-10.00", kind: "shipping_refund" }],
    };
    expect(computeRefundAmountCents(p)).toBe(1000);
  });

  it("ignores failed transactions", () => {
    const p = {
      transactions: [
        { kind: "refund", status: "failure", amount: "100.00" },
        { kind: "refund", status: "success", amount: "5.00" },
      ],
    };
    expect(computeRefundAmountCents(p)).toBe(500);
  });

  it("returns 0 for empty payload", () => {
    expect(computeRefundAmountCents({})).toBe(0);
    expect(computeRefundAmountCents(null)).toBe(0);
  });
});

describe("computeRestockingFeeCents", () => {
  it("extracts restocking_fee adjustments", () => {
    expect(computeRestockingFeeCents(sampleRefundPayload())).toBe(500);
  });
  it("returns 0 when none present", () => {
    expect(computeRestockingFeeCents({ order_adjustments: [] })).toBe(0);
    expect(computeRestockingFeeCents({})).toBe(0);
  });
  it("sums multiple restocking_fee adjustments", () => {
    const p = {
      order_adjustments: [
        { kind: "restocking_fee", amount: "3.00" },
        { kind: "restocking_fee", amount: "2.00" },
        { kind: "shipping_refund", amount: "1.00" },
      ],
    };
    expect(computeRestockingFeeCents(p)).toBe(500);
  });
});

describe("extractRefundsFromPayload", () => {
  it("returns [payload] for refunds/create topic", () => {
    const p = sampleRefundPayload();
    expect(extractRefundsFromPayload(p, "refunds/create")).toEqual([p]);
  });

  it("returns payload.refunds[] for orders/refunded topic", () => {
    const order = {
      id: 5001,
      refunds: [
        { id: 8001, transactions: [{ kind: "refund", status: "success", amount: "5.00" }] },
        { id: 8002, transactions: [{ kind: "refund", status: "success", amount: "3.00" }] },
      ],
    };
    const out = extractRefundsFromPayload(order, "orders/refunded");
    expect(out).toHaveLength(2);
    expect(out[0].order_id).toBe(5001);
    expect(out[1].order_id).toBe(5001);
  });

  it("returns [] for non-refund payload", () => {
    expect(extractRefundsFromPayload({}, "refunds/create")).toEqual([]);
    expect(extractRefundsFromPayload(null, "refunds/create")).toEqual([]);
  });
});

describe("buildRefundRow", () => {
  it("classifies as full when refund_amount >= total", () => {
    const row = buildRefundRow({
      refundPayload: sampleRefundPayload(),
      store: { id: STORE_UUID, entity_id: ENTITY_UUID },
      parentOrder: { id: ORDER_UUID, entity_id: ENTITY_UUID, total_amount_cents: "5499" },
      rawTopic: "refunds/create",
    });
    expect(row.refund_type).toBe("full");
    expect(row.shopify_order_id).toBe(ORDER_UUID);
    expect(row.shopify_refund_id).toBe("8001");
    expect(row.refund_amount_cents).toBe(5499);
    expect(row.restocking_fee_cents).toBe(500);
    expect(row.raw_payload._webhook_topic).toBe("refunds/create");
  });
  it("classifies as partial when refund_amount < total", () => {
    const row = buildRefundRow({
      refundPayload: sampleRefundPayload(),
      store: { id: STORE_UUID, entity_id: ENTITY_UUID },
      parentOrder: { id: ORDER_UUID, entity_id: ENTITY_UUID, total_amount_cents: "12999" },
      rawTopic: "refunds/create",
    });
    expect(row.refund_type).toBe("partial");
  });
});

describe("headerValue", () => {
  it("returns lowercased-key value", () => {
    const req = { headers: { "x-shopify-topic": "refunds/create" } };
    expect(headerValue(req, "X-Shopify-Topic")).toBe("refunds/create");
  });
  it("returns null when absent", () => {
    expect(headerValue({ headers: {} }, "x-y")).toBe(null);
  });
});

// ────────────────────────────────────────────────────────────────────────
// upsertAndProcessRefund (service wiring)
// ────────────────────────────────────────────────────────────────────────

describe("upsertAndProcessRefund", () => {
  it("calls processShopifyRefund for a newly-upserted refund", async () => {
    const sb = makeSupabase();
    processShopifyRefund.mockResolvedValue({
      status: "credit_memo_posted",
      refund_type: "partial",
      ar_credit_memo_id: CM_ID,
      je_id: "je-1",
      cogs_je_id: null,
      inventory_layer_ids: [],
    });
    const result = await upsertAndProcessRefund({
      admin: sb,
      store: { id: STORE_UUID, entity_id: ENTITY_UUID },
      refundPayload: sampleRefundPayload(),
      rawTopic: "refunds/create",
    });
    expect(result.status).toBe("credit_memo_posted");
    expect(result.ar_credit_memo_id).toBe(CM_ID);
    expect(processShopifyRefund).toHaveBeenCalledWith(
      expect.objectContaining({ shopifyRefundId: REFUND_UUID }),
    );
  });

  it("short-circuits when refund already has ar_credit_memo_id", async () => {
    const sb = makeSupabase({
      refundUpsertReturn: { id: REFUND_UUID, ar_credit_memo_id: CM_ID, refund_type: "partial" },
    });
    const result = await upsertAndProcessRefund({
      admin: sb,
      store: { id: STORE_UUID, entity_id: ENTITY_UUID },
      refundPayload: sampleRefundPayload(),
      rawTopic: "refunds/create",
    });
    expect(result.status).toBe("already_processed");
    expect(processShopifyRefund).not.toHaveBeenCalled();
  });

  it("throws when parent order is not found", async () => {
    const sb = makeSupabase({ parentOrder: null });
    await expect(upsertAndProcessRefund({
      admin: sb,
      store: { id: STORE_UUID, entity_id: ENTITY_UUID },
      refundPayload: sampleRefundPayload(),
      rawTopic: "refunds/create",
    })).rejects.toThrow(/parent shopify_orders not found/);
  });

  it("throws when payload missing order_id", async () => {
    const sb = makeSupabase();
    const p = sampleRefundPayload();
    delete p.order_id;
    await expect(upsertAndProcessRefund({
      admin: sb,
      store: { id: STORE_UUID, entity_id: ENTITY_UUID },
      refundPayload: p,
      rawTopic: "refunds/create",
    })).rejects.toThrow(/missing order_id/);
  });

  it("uses injected processShopifyRefund dep", async () => {
    const sb = makeSupabase();
    const customFn = vi.fn().mockResolvedValue({
      status: "voided", refund_type: "full", ar_invoice_id: "x", reversed_je_ids: [],
    });
    const result = await upsertAndProcessRefund({
      admin: sb,
      store: { id: STORE_UUID, entity_id: ENTITY_UUID },
      refundPayload: sampleRefundPayload(),
      rawTopic: "refunds/create",
      deps: { processShopifyRefund: customFn },
    });
    expect(customFn).toHaveBeenCalled();
    expect(result.status).toBe("voided");
  });
});

// ────────────────────────────────────────────────────────────────────────
// Handler integration (mocked supabase)
// ────────────────────────────────────────────────────────────────────────

describe("refunds webhook handler", () => {
  it("405s non-POST", async () => {
    createClient.mockReturnValue(makeSupabase());
    const res = mockRes();
    await handler({ method: "GET", headers: {}, url: "" }, res);
    expect(res.statusCode).toBe(405);
  });

  it("200s on OPTIONS preflight", async () => {
    createClient.mockReturnValue(makeSupabase());
    const res = mockRes();
    await handler({ method: "OPTIONS", headers: {}, url: "" }, res);
    expect(res.statusCode).toBe(200);
  });

  it("401s on bad HMAC", async () => {
    createClient.mockReturnValue(makeSupabase());
    const res = mockRes();
    const req = mockReq({ body: sampleRefundPayload() });
    req.headers["x-shopify-hmac-sha256"] = "bogus";
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it("processes a valid refunds/create webhook end-to-end", async () => {
    const sb = makeSupabase();
    createClient.mockReturnValue(sb);
    processShopifyRefund.mockResolvedValue({
      status: "credit_memo_posted",
      refund_type: "partial",
      ar_credit_memo_id: CM_ID,
      je_id: "je-1",
      cogs_je_id: null,
      inventory_layer_ids: [],
    });
    const res = mockRes();
    await handler(mockReq({ body: sampleRefundPayload() }), res);
    expect(res.statusCode).toBe(200);
    expect(res._payload.status).toBe("processed");
    expect(res._payload.refunds_processed).toHaveLength(1);
    expect(sb.__calls.refundUpserts).toHaveLength(1);
    expect(sb.__calls.logInserts).toHaveLength(1);
    expect(sb.__calls.logInserts[0].topic).toBe("refunds/create");
  });

  it("returns 200 duplicate when webhook_id already in log", async () => {
    const sb = makeSupabase({ existingLog: { id: "old-log", status: "processed" } });
    createClient.mockReturnValue(sb);
    const res = mockRes();
    await handler(mockReq({ body: sampleRefundPayload() }), res);
    expect(res.statusCode).toBe(200);
    expect(res._payload.status).toBe("duplicate");
    expect(sb.__calls.refundUpserts).toHaveLength(0);
  });

  it("returns 200 ignored for unknown shop_domain", async () => {
    const sb = makeSupabase({ store: null });
    createClient.mockReturnValue(sb);
    const res = mockRes();
    await handler(mockReq({ body: sampleRefundPayload(), shopDomain: "ghost.myshopify.com" }), res);
    expect(res.statusCode).toBe(200);
    expect(res._payload.status).toBe("ignored");
    expect(res._payload.reason).toBe("unknown_shop");
  });

  it("skips HMAC verify with SHOPIFY_WEBHOOK_SKIP_VERIFY=true", async () => {
    process.env.SHOPIFY_WEBHOOK_SKIP_VERIFY = "true";
    const sb = makeSupabase();
    createClient.mockReturnValue(sb);
    processShopifyRefund.mockResolvedValue({
      status: "credit_memo_posted", refund_type: "partial", ar_credit_memo_id: CM_ID, je_id: "je-1",
    });
    const res = mockRes();
    await handler(mockReq({ body: sampleRefundPayload(), signed: false }), res);
    expect(res.statusCode).toBe(200);
    expect(res._payload.status).toBe("processed");
  });

  it("400s when X-Shopify-Shop-Domain missing", async () => {
    createClient.mockReturnValue(makeSupabase());
    const res = mockRes();
    const req = mockReq({ body: sampleRefundPayload() });
    delete req.headers["x-shopify-shop-domain"];
    req.headers["x-shopify-hmac-sha256"] = sign(JSON.stringify(sampleRefundPayload()));
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("400s when X-Shopify-Webhook-Id missing", async () => {
    createClient.mockReturnValue(makeSupabase());
    const res = mockRes();
    const req = mockReq({ body: sampleRefundPayload() });
    delete req.headers["x-shopify-webhook-id"];
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it("401 when SHOPIFY_WEBHOOK_SECRET unset and not skipping", async () => {
    delete process.env.SHOPIFY_WEBHOOK_SECRET;
    createClient.mockReturnValue(makeSupabase());
    const res = mockRes();
    await handler(mockReq({ body: sampleRefundPayload() }), res);
    expect(res.statusCode).toBe(401);
  });

  it("400 on invalid JSON body", async () => {
    createClient.mockReturnValue(makeSupabase());
    const res = mockRes();
    const raw = "not json";
    await handler({
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shopify-shop-domain": "rof.myshopify.com",
        "x-shopify-topic": "refunds/create",
        "x-shopify-webhook-id": "WH-bad-1",
        "x-shopify-hmac-sha256": sign(raw),
      },
      body: raw,
      url: "/api/internal/shopify/webhooks/refunds",
      readable: false,
    }, res);
    expect(res.statusCode).toBe(400);
  });

  it("returns noop when payload has no refunds", async () => {
    const sb = makeSupabase();
    createClient.mockReturnValue(sb);
    const res = mockRes();
    // orders/refunded with empty refunds[]
    await handler(mockReq({
      body: { id: 5001, refunds: [] },
      topic: "orders/refunded",
    }), res);
    expect(res.statusCode).toBe(200);
    expect(res._payload.status).toBe("noop");
  });

  it("handles orders/refunded topic with multiple refunds", async () => {
    const sb = makeSupabase();
    createClient.mockReturnValue(sb);
    processShopifyRefund.mockResolvedValue({
      status: "credit_memo_posted", refund_type: "partial",
      ar_credit_memo_id: CM_ID, je_id: "je",
    });
    const res = mockRes();
    await handler(mockReq({
      body: {
        id: 5001,
        refunds: [
          { id: 8001, transactions: [{ kind: "refund", status: "success", amount: "5.00" }] },
          { id: 8002, transactions: [{ kind: "refund", status: "success", amount: "3.00" }] },
        ],
      },
      topic: "orders/refunded",
    }), res);
    expect(res.statusCode).toBe(200);
    expect(res._payload.refunds_processed).toHaveLength(2);
    expect(sb.__calls.refundUpserts).toHaveLength(2);
  });

  it("returns partial status when one refund fails", async () => {
    const sb = makeSupabase({ parentOrder: null });
    createClient.mockReturnValue(sb);
    const res = mockRes();
    await handler(mockReq({ body: sampleRefundPayload() }), res);
    expect(res.statusCode).toBe(200);
    expect(res._payload.status).toBe("partial");
    expect(res._payload.refunds_processed[0].status).toBe("error");
  });
});
