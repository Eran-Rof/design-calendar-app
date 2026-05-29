// Tests for Tangerine P11-2 Shopify orders webhook intake handler.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(),
}));

import handler, {
  verifyShopifyHmac,
  buildOrderRow,
  buildOrderLines,
  dollarsToCents,
  headerValue,
} from "../orders.js";
import { createClient } from "@supabase/supabase-js";

const STORE_UUID  = "11111111-1111-1111-1111-111111111111";
const ENTITY_UUID = "22222222-2222-2222-2222-222222222222";
const ORDER_UUID  = "33333333-3333-3333-3333-333333333333";
const LOG_UUID    = "44444444-4444-4444-4444-444444444444";

const SECRET = "shpss_test_webhook_secret";

function samplePayload() {
  return {
    id: 5001,
    name: "#1001",
    email: "shopper@example.com",
    financial_status: "paid",
    fulfillment_status: "fulfilled",
    processed_at: "2026-05-28T10:00:00Z",
    currency: "USD",
    total_price: "129.99",
    subtotal_price: "119.99",
    total_tax: "10.00",
    total_discounts: "5.00",
    payment_gateway_names: ["shopify_payments"],
    discount_codes: [{ code: "SAVE5", amount: "5.00" }],
    shipping_lines: [{ price: "7.50" }],
    line_items: [
      {
        id: 9001,
        sku: "ROF-001",
        title: "Test Tee",
        quantity: 2,
        price: "49.99",
        tax_lines: [{ price: "5.00" }],
        discount_allocations: [{ amount: "2.50" }],
      },
      {
        id: 9002,
        sku: "ROF-002",
        title: "Test Hat",
        quantity: 1,
        price: "20.01",
        tax_lines: [],
        discount_allocations: [],
      },
    ],
  };
}

function sign(body, secret = SECRET) {
  return createHmac("sha256", secret).update(body, "utf8").digest("base64");
}

function mockReq({ body, signed = true, secret = SECRET, webhookId = "WH-1", shopDomain = "rof.myshopify.com", topic = "orders/create" } = {}) {
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
    url: "/api/internal/shopify/webhooks/orders",
    body, // dispatcher pre-parses JSON → object on req.body
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

/**
 * Build a chainable mock Supabase client that captures the calls per-table
 * and lets each test inject the resolved values.
 */
function makeSupabase({ store = { id: STORE_UUID, entity_id: ENTITY_UUID }, existingLog = null, orderUpsertReturn = { id: ORDER_UUID }, linesError = null, logInsertReturn = { id: LOG_UUID }, logInsertError = null } = {}) {
  const calls = { orderUpserts: [], lineUpserts: [], logInserts: [], logUpdates: [], logUpserts: [] };

  function chainable(returnRow) {
    const obj = {};
    obj.select = vi.fn(() => obj);
    obj.eq = vi.fn(() => obj);
    obj.maybeSingle = vi.fn(async () => ({ data: returnRow, error: null }));
    obj.single = vi.fn(async () => ({ data: returnRow, error: null }));
    return obj;
  }

  return {
    __calls: calls,
    from(table) {
      if (table === "shopify_stores") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({ data: store, error: null })),
            })),
          })),
          update: vi.fn((row) => ({
            eq: vi.fn(async () => ({ data: row, error: null })),
          })),
        };
      }
      if (table === "shopify_webhook_log") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({ data: existingLog, error: null })),
            })),
          })),
          insert: vi.fn((row) => {
            calls.logInserts.push(row);
            return {
              select: vi.fn(() => ({
                single: vi.fn(async () => ({
                  data: logInsertError ? null : logInsertReturn,
                  error: logInsertError,
                })),
              })),
            };
          }),
          upsert: vi.fn((row) => {
            calls.logUpserts.push(row);
            return Promise.resolve({ data: row, error: null });
          }),
          update: vi.fn((row) => {
            calls.logUpdates.push(row);
            return {
              eq: vi.fn(async () => ({ data: row, error: null })),
            };
          }),
        };
      }
      if (table === "shopify_orders") {
        return {
          upsert: vi.fn((row) => {
            calls.orderUpserts.push(row);
            return {
              select: vi.fn(() => ({
                single: vi.fn(async () => ({ data: orderUpsertReturn, error: null })),
              })),
            };
          }),
        };
      }
      if (table === "shopify_order_lines") {
        return {
          upsert: vi.fn((rows) => {
            calls.lineUpserts.push(rows);
            return Promise.resolve({ data: rows, error: linesError });
          }),
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

describe("dollarsToCents", () => {
  it("rounds string dollars to integer cents", () => {
    expect(dollarsToCents("12.99")).toBe(1299);
    expect(dollarsToCents("0.01")).toBe(1);
    expect(dollarsToCents("100")).toBe(10000);
  });
  it("handles null/empty/non-numeric", () => {
    expect(dollarsToCents(null)).toBe(0);
    expect(dollarsToCents("")).toBe(0);
    expect(dollarsToCents("abc")).toBe(0);
  });
  it("handles numeric input", () => {
    expect(dollarsToCents(1.23)).toBe(123);
  });
});

describe("buildOrderRow", () => {
  it("maps a typical payload into the shopify_orders insert shape", () => {
    const row = buildOrderRow(samplePayload(), { id: STORE_UUID, entity_id: ENTITY_UUID });
    expect(row.shopify_store_id).toBe(STORE_UUID);
    expect(row.entity_id).toBe(ENTITY_UUID);
    expect(row.shopify_order_id).toBe("5001");
    expect(row.order_number).toBe("#1001");
    expect(row.financial_status).toBe("paid");
    expect(row.fulfillment_status).toBe("fulfilled");
    expect(row.processed_at).toBe("2026-05-28T10:00:00Z");
    expect(row.currency).toBe("USD");
    expect(row.total_amount_cents).toBe(12999);
    expect(row.subtotal_amount_cents).toBe(11999);
    expect(row.tax_amount_cents).toBe(1000);
    expect(row.shipping_amount_cents).toBe(750);
    expect(row.discount_amount_cents).toBe(500);
    expect(row.payment_gateway).toBe("shopify_payments");
    expect(row.discount_codes).toEqual([{ code: "SAVE5", amount: "5.00" }]);
    expect(row.customer_email).toBe("shopper@example.com");
    expect(row.raw_payload).toEqual(samplePayload());
  });

  it("defaults discount_codes to [] when missing", () => {
    const p = samplePayload();
    delete p.discount_codes;
    const row = buildOrderRow(p, { id: STORE_UUID, entity_id: ENTITY_UUID });
    expect(row.discount_codes).toEqual([]);
  });
});

describe("buildOrderLines", () => {
  it("maps line_items with line_number = idx+1 + cents conversion", () => {
    const lines = buildOrderLines(samplePayload(), ORDER_UUID);
    expect(lines).toHaveLength(2);
    expect(lines[0].line_number).toBe(1);
    expect(lines[0].shopify_order_id).toBe(ORDER_UUID);
    expect(lines[0].shopify_line_id).toBe("9001");
    expect(lines[0].sku).toBe("ROF-001");
    expect(lines[0].quantity).toBe(2);
    expect(lines[0].unit_price_cents).toBe(4999);
    expect(lines[0].line_total_cents).toBe(9998);
    expect(lines[0].line_tax_cents).toBe(500);
    expect(lines[0].line_discount_cents).toBe(250);
    expect(lines[1].line_number).toBe(2);
    expect(lines[1].line_total_cents).toBe(2001);
  });

  it("returns [] when no line_items", () => {
    expect(buildOrderLines({}, ORDER_UUID)).toEqual([]);
  });
});

describe("headerValue", () => {
  it("returns the lowercased-key value", () => {
    const req = { headers: { "x-shopify-shop-domain": "rof.myshopify.com" } };
    expect(headerValue(req, "X-Shopify-Shop-Domain")).toBe("rof.myshopify.com");
  });
  it("returns null when absent", () => {
    expect(headerValue({ headers: {} }, "x-y")).toBe(null);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Handler integration (mocked supabase)
// ────────────────────────────────────────────────────────────────────────

describe("orders webhook handler", () => {
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

  it("processes a valid HMAC + new webhook end-to-end", async () => {
    const sb = makeSupabase();
    createClient.mockReturnValue(sb);
    const res = mockRes();
    await handler(mockReq({ body: samplePayload() }), res);

    expect(res.statusCode).toBe(200);
    expect(res._payload.status).toBe("processed");
    expect(res._payload.shopify_order_id).toBe(ORDER_UUID);

    // 1 webhook_log insert, 1 order upsert, 1 lines upsert (array of 2)
    expect(sb.__calls.logInserts).toHaveLength(1);
    expect(sb.__calls.logInserts[0].topic).toBe("orders/create");
    expect(sb.__calls.orderUpserts).toHaveLength(1);
    expect(sb.__calls.orderUpserts[0].shopify_order_id).toBe("5001");
    expect(sb.__calls.lineUpserts).toHaveLength(1);
    expect(sb.__calls.lineUpserts[0]).toHaveLength(2);
    // status='processed' update happened
    const processedUpdate = sb.__calls.logUpdates.find((u) => u.status === "processed");
    expect(processedUpdate).toBeTruthy();
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

  it("returns 200 duplicate when webhook_id already in log", async () => {
    const sb = makeSupabase({ existingLog: { id: "old-log-id", status: "processed" } });
    createClient.mockReturnValue(sb);
    const res = mockRes();
    await handler(mockReq({ body: samplePayload() }), res);
    expect(res.statusCode).toBe(200);
    expect(res._payload.status).toBe("duplicate");
    expect(sb.__calls.orderUpserts).toHaveLength(0);
  });

  it("returns 200 ignored for unknown shop_domain", async () => {
    const sb = makeSupabase({ store: null });
    createClient.mockReturnValue(sb);
    const res = mockRes();
    await handler(mockReq({ body: samplePayload(), shopDomain: "ghost.myshopify.com" }), res);
    expect(res.statusCode).toBe(200);
    expect(res._payload.status).toBe("ignored");
    expect(res._payload.reason).toBe("unknown_shop");
    expect(sb.__calls.logUpserts).toHaveLength(1);
  });

  it("400s when X-Shopify-Shop-Domain is missing", async () => {
    const sb = makeSupabase();
    createClient.mockReturnValue(sb);
    const res = mockRes();
    const req = mockReq({ body: samplePayload() });
    delete req.headers["x-shopify-shop-domain"];
    // re-sign with the existing body so HMAC still matches
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

  it("401s when SHOPIFY_WEBHOOK_SECRET env is missing (and not skipping)", async () => {
    delete process.env.SHOPIFY_WEBHOOK_SECRET;
    const sb = makeSupabase();
    createClient.mockReturnValue(sb);
    const res = mockRes();
    await handler(mockReq({ body: samplePayload() }), res);
    expect(res.statusCode).toBe(401);
    expect(res._payload.error).toMatch(/secret/);
  });

  it("inserts lines with correct (shopify_order_id, line_number) tuple", async () => {
    const sb = makeSupabase();
    createClient.mockReturnValue(sb);
    const res = mockRes();
    await handler(mockReq({ body: samplePayload() }), res);
    const lines = sb.__calls.lineUpserts[0];
    expect(lines[0].shopify_order_id).toBe(ORDER_UUID);
    expect(lines[0].line_number).toBe(1);
    expect(lines[1].line_number).toBe(2);
  });

  it("logs failed status when order upsert fails", async () => {
    const sb = {
      from(table) {
        if (table === "shopify_stores") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: { id: STORE_UUID, entity_id: ENTITY_UUID }, error: null }),
              }),
            }),
          };
        }
        if (table === "shopify_webhook_log") {
          const inserts = [];
          const updates = [];
          this.__inserts = inserts;
          this.__updates = updates;
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: null, error: null }),
              }),
            }),
            insert: (row) => {
              inserts.push(row);
              return {
                select: () => ({
                  single: async () => ({ data: { id: LOG_UUID }, error: null }),
                }),
              };
            },
            update: (row) => {
              updates.push(row);
              return { eq: async () => ({ data: row, error: null }) };
            },
          };
        }
        if (table === "shopify_orders") {
          return {
            upsert: () => ({
              select: () => ({
                single: async () => ({ data: null, error: { message: "constraint violation" } }),
              }),
            }),
          };
        }
        throw new Error(`unexpected: ${table}`);
      },
    };
    createClient.mockReturnValue(sb);
    const res = mockRes();
    await handler(mockReq({ body: samplePayload() }), res);
    expect(res.statusCode).toBe(500);
    expect(res._payload.error).toMatch(/order upsert/);
  });

  it("400s on invalid JSON body", async () => {
    const sb = makeSupabase();
    createClient.mockReturnValue(sb);
    const res = mockRes();
    // build a request whose body is a string "not json"
    const raw = "not json";
    const headers = {
      "content-type": "application/json",
      "x-shopify-shop-domain": "rof.myshopify.com",
      "x-shopify-topic": "orders/create",
      "x-shopify-webhook-id": "WH-1",
      "x-shopify-hmac-sha256": sign(raw),
    };
    await handler({
      method: "POST",
      headers,
      url: "/api/internal/shopify/webhooks/orders",
      body: raw,
      readable: false,
    }, res);
    expect(res.statusCode).toBe(400);
    expect(res._payload.error).toMatch(/invalid JSON/);
  });
});
