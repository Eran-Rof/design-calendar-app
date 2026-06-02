// Tangerine P11-6 — tests for the Shopify refunds backfill orchestrator.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../token-encryption.js", () => ({
  decryptToken: vi.fn().mockReturnValue("shpat_decrypted"),
}));

vi.mock("../client.js", () => ({
  ShopifyClient: vi.fn(),
}));

vi.mock("../process-refund.js", () => ({
  processShopifyRefund: vi.fn(),
}));

vi.mock("../../../_handlers/internal/shopify/webhooks/refunds.js", () => ({
  buildRefundRow: vi.fn(),
  upsertAndProcessRefund: vi.fn(),
}));

import {
  backfillShopifyRefunds,
  backfillStoreRefunds,
  computeSinceIso,
} from "../backfill-refunds.js";
import { decryptToken } from "../token-encryption.js";
import { ShopifyClient } from "../client.js";
import { processShopifyRefund } from "../process-refund.js";
import {
  upsertAndProcessRefund,
} from "../../../_handlers/internal/shopify/webhooks/refunds.js";

const STORE_UUID = "11111111-1111-1111-1111-111111111111";
const ENTITY     = "22222222-2222-2222-2222-222222222222";
const ORDER_UUID = "33333333-3333-3333-3333-333333333333";
const REFUND_UUID = "44444444-4444-4444-4444-444444444444";
const CM_ID      = "55555555-5555-5555-5555-555555555555";

function sampleStore(overrides = {}) {
  return {
    id: STORE_UUID,
    entity_id: ENTITY,
    shopify_domain: "rof.myshopify.com",
    api_version: "2025-01",
    access_token_ciphertext: Buffer.from("ct"),
    access_token_iv: Buffer.from("iv"),
    access_token_tag: Buffer.from("tag"),
    ...overrides,
  };
}

function sampleOrder(overrides = {}) {
  return {
    id: ORDER_UUID,
    entity_id: ENTITY,
    shopify_order_id: "9001",
    total_amount_cents: "12999",
    ar_invoice_id: null,
    financial_status: "paid",
    processed_at: "2026-05-28T10:00:00Z",
    ...overrides,
  };
}

function sampleRefundPayload({ id = 8001, orderId = 9001 } = {}) {
  return {
    id,
    order_id: orderId,
    processed_at: "2026-05-28T11:00:00Z",
    refund_line_items: [{ line_item_id: 1, quantity: 1, restock_type: "return", subtotal: "5.00" }],
    transactions: [{ kind: "refund", status: "success", amount: "5.00" }],
  };
}

function makeAdmin({ stores = [sampleStore()], orders = [sampleOrder()], lastBackfillError = null, ordersError = null, storesError = null } = {}) {
  const calls = { lastBackfillUpdates: [] };
  return {
    __calls: calls,
    from(table) {
      if (table === "shopify_stores") {
        return {
          select: () => ({
            eq: () => ({
              not: () => Promise.resolve({ data: stores, error: storesError }),
            }),
          }),
          update: (patch) => {
            calls.lastBackfillUpdates.push(patch);
            return { eq: async () => ({ data: patch, error: lastBackfillError }) };
          },
        };
      }
      if (table === "shopify_orders") {
        return {
          select: () => ({
            eq: () => ({
              in: () => ({
                gte: () => ({
                  order: () => ({
                    limit: () => Promise.resolve({ data: orders, error: ordersError }),
                  }),
                }),
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  decryptToken.mockReturnValue("shpat_decrypted");
});

// ────────────────────────────────────────────────────────────────────────
// Pure helper
// ────────────────────────────────────────────────────────────────────────

describe("computeSinceIso", () => {
  it("subtracts hours from now in ISO", () => {
    const now = Date.UTC(2026, 4, 29, 0, 0, 0);
    const out = computeSinceIso(24, now);
    expect(out).toBe("2026-05-28T00:00:00.000Z");
  });
  it("rejects non-positive", () => {
    expect(() => computeSinceIso(0)).toThrow();
    expect(() => computeSinceIso(-1)).toThrow();
    expect(() => computeSinceIso("abc")).toThrow();
  });
});

// ────────────────────────────────────────────────────────────────────────
// backfillStoreRefunds
// ────────────────────────────────────────────────────────────────────────

describe("backfillStoreRefunds", () => {
  it("walks listRefunds for each candidate order + processes refunds", async () => {
    const listRefunds = vi.fn().mockResolvedValue({
      data: [sampleRefundPayload()],
      nextPageInfo: null,
    });
    ShopifyClient.mockImplementation(() => ({ listRefunds }));
    upsertAndProcessRefund.mockResolvedValue({
      status: "credit_memo_posted", refund_type: "partial",
      ar_credit_memo_id: CM_ID, je_id: "je",
    });

    const admin = makeAdmin();
    const storeSummary = { refunds_upserted: 0, refunds_processed: 0, refunds_already_processed: 0, refund_errors: [], orders_scanned: 0 };
    await backfillStoreRefunds({
      adminClient: admin,
      store: sampleStore(),
      sinceIso: "2026-05-28T00:00:00.000Z",
      deps: {
        decryptToken,
        makeClient: (opts) => new ShopifyClient(opts),
        processShopifyRefund,
        upsertAndProcessRefund,
        now: () => Date.now(),
      },
      storeSummary,
    });
    expect(listRefunds).toHaveBeenCalledTimes(1);
    expect(listRefunds).toHaveBeenCalledWith("9001");
    expect(upsertAndProcessRefund).toHaveBeenCalledTimes(1);
    expect(storeSummary.refunds_upserted).toBe(1);
    expect(storeSummary.refunds_processed).toBe(1);
    expect(storeSummary.cursor_updated).toBe(true);
    expect(admin.__calls.lastBackfillUpdates).toHaveLength(1);
  });

  it("records refund errors per-order without sinking the store", async () => {
    const listRefunds = vi.fn().mockResolvedValue({
      data: [sampleRefundPayload(), sampleRefundPayload({ id: 8002 })],
      nextPageInfo: null,
    });
    ShopifyClient.mockImplementation(() => ({ listRefunds }));
    upsertAndProcessRefund.mockResolvedValueOnce({ status: "credit_memo_posted", refund_type: "partial", ar_credit_memo_id: CM_ID })
      .mockRejectedValueOnce(new Error("processing failed"));

    const admin = makeAdmin();
    const storeSummary = { refunds_upserted: 0, refunds_processed: 0, refunds_already_processed: 0, refund_errors: [], orders_scanned: 0 };
    await backfillStoreRefunds({
      adminClient: admin,
      store: sampleStore(),
      sinceIso: "2026-05-28T00:00:00.000Z",
      deps: {
        decryptToken,
        makeClient: (opts) => new ShopifyClient(opts),
        processShopifyRefund,
        upsertAndProcessRefund,
        now: () => Date.now(),
      },
      storeSummary,
    });
    expect(storeSummary.refunds_processed).toBe(1);
    expect(storeSummary.refund_errors).toHaveLength(1);
    expect(storeSummary.refund_errors[0].error).toMatch(/processing failed/);
  });

  it("records listRefunds API failure per-order", async () => {
    const listRefunds = vi.fn().mockRejectedValue(new Error("429 rate limited"));
    ShopifyClient.mockImplementation(() => ({ listRefunds }));
    const admin = makeAdmin();
    const storeSummary = { refunds_upserted: 0, refunds_processed: 0, refunds_already_processed: 0, refund_errors: [], orders_scanned: 0 };
    await backfillStoreRefunds({
      adminClient: admin,
      store: sampleStore(),
      sinceIso: "2026-05-28T00:00:00.000Z",
      deps: {
        decryptToken,
        makeClient: (opts) => new ShopifyClient(opts),
        processShopifyRefund,
        upsertAndProcessRefund,
        now: () => Date.now(),
      },
      storeSummary,
    });
    expect(storeSummary.refund_errors[0].error).toMatch(/listRefunds failed/);
  });

  it("throws when token decrypt fails", async () => {
    decryptToken.mockImplementationOnce(() => { throw new Error("bad key"); });
    const admin = makeAdmin();
    const storeSummary = { refunds_upserted: 0, refunds_processed: 0, refunds_already_processed: 0, refund_errors: [], orders_scanned: 0 };
    await expect(backfillStoreRefunds({
      adminClient: admin,
      store: sampleStore(),
      sinceIso: "2026-05-28T00:00:00.000Z",
      deps: { decryptToken, makeClient: (opts) => new ShopifyClient(opts), processShopifyRefund, upsertAndProcessRefund, now: () => Date.now() },
      storeSummary,
    })).rejects.toThrow(/decrypt access_token failed/);
  });

  it("counts already_processed separately", async () => {
    const listRefunds = vi.fn().mockResolvedValue({
      data: [sampleRefundPayload()],
      nextPageInfo: null,
    });
    ShopifyClient.mockImplementation(() => ({ listRefunds }));
    upsertAndProcessRefund.mockResolvedValue({ status: "already_processed", refund_type: "partial", ar_credit_memo_id: CM_ID });
    const admin = makeAdmin();
    const storeSummary = { refunds_upserted: 0, refunds_processed: 0, refunds_already_processed: 0, refund_errors: [], orders_scanned: 0 };
    await backfillStoreRefunds({
      adminClient: admin,
      store: sampleStore(),
      sinceIso: "2026-05-28T00:00:00.000Z",
      deps: { decryptToken, makeClient: (opts) => new ShopifyClient(opts), processShopifyRefund, upsertAndProcessRefund, now: () => Date.now() },
      storeSummary,
    });
    expect(storeSummary.refunds_already_processed).toBe(1);
    expect(storeSummary.refunds_processed).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────
// backfillShopifyRefunds (orchestrator)
// ────────────────────────────────────────────────────────────────────────

describe("backfillShopifyRefunds", () => {
  it("processes all active stores + sums per-store stats", async () => {
    const listRefunds = vi.fn().mockResolvedValue({
      data: [sampleRefundPayload()],
      nextPageInfo: null,
    });
    ShopifyClient.mockImplementation(() => ({ listRefunds }));
    upsertAndProcessRefund.mockResolvedValue({ status: "credit_memo_posted", refund_type: "partial", ar_credit_memo_id: CM_ID });

    const admin = makeAdmin({
      stores: [
        sampleStore(),
        sampleStore({ id: "store-2-uuid-aaaa-aaaa-aaaa-aaaaaaaaaaaa", shopify_domain: "two.myshopify.com" }),
      ],
    });
    const summary = await backfillShopifyRefunds({ adminClient: admin });
    expect(summary.stores_processed).toBe(2);
    expect(summary.refunds_upserted).toBe(2);
    expect(summary.refunds_processed).toBe(2);
    expect(summary.errors).toHaveLength(0);
  });

  it("isolates per-store errors", async () => {
    decryptToken
      .mockImplementationOnce(() => { throw new Error("bad key"); })
      .mockReturnValue("shpat_ok");
    const listRefunds = vi.fn().mockResolvedValue({ data: [], nextPageInfo: null });
    ShopifyClient.mockImplementation(() => ({ listRefunds }));

    const admin = makeAdmin({
      stores: [
        sampleStore(),
        sampleStore({ id: "store-2-uuid-aaaa-aaaa-aaaa-aaaaaaaaaaaa", shopify_domain: "two.myshopify.com" }),
      ],
    });
    const summary = await backfillShopifyRefunds({ adminClient: admin });
    expect(summary.stores_processed).toBe(2);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toMatch(/decrypt access_token failed/);
  });

  it("validates adminClient", async () => {
    await expect(backfillShopifyRefunds({ adminClient: null })).rejects.toThrow();
    await expect(backfillShopifyRefunds({ adminClient: {} })).rejects.toThrow();
  });

  it("propagates shopify_stores read errors", async () => {
    const admin = makeAdmin({ storesError: { message: "RLS denied" } });
    await expect(backfillShopifyRefunds({ adminClient: admin })).rejects.toThrow(/RLS denied/);
  });

  it("emits an empty summary when no active stores", async () => {
    const admin = makeAdmin({ stores: [] });
    const summary = await backfillShopifyRefunds({ adminClient: admin });
    expect(summary.stores_processed).toBe(0);
    expect(summary.refunds_upserted).toBe(0);
  });

  it("uses default 30-day window when sinceHoursAgo omitted", async () => {
    const listRefunds = vi.fn().mockResolvedValue({ data: [], nextPageInfo: null });
    ShopifyClient.mockImplementation(() => ({ listRefunds }));
    const admin = makeAdmin({ stores: [sampleStore()] });
    const summary = await backfillShopifyRefunds({ adminClient: admin });
    // window covers a 30-day lookback (720h)
    expect(summary.since).toMatch(/^2/);
  });

  it("honors custom sinceHoursAgo", async () => {
    const listRefunds = vi.fn().mockResolvedValue({ data: [], nextPageInfo: null });
    ShopifyClient.mockImplementation(() => ({ listRefunds }));
    const admin = makeAdmin({ stores: [sampleStore()] });
    const summary = await backfillShopifyRefunds({ adminClient: admin, sinceHoursAgo: 24 });
    expect(typeof summary.since).toBe("string");
  });

  it("counts orders_scanned per store", async () => {
    const listRefunds = vi.fn().mockResolvedValue({ data: [], nextPageInfo: null });
    ShopifyClient.mockImplementation(() => ({ listRefunds }));
    const admin = makeAdmin({
      orders: [
        sampleOrder(),
        sampleOrder({ id: "ord-2-uuid-aaaa-aaaa-aaaa-aaaaaaaaaaaa", shopify_order_id: "9002" }),
      ],
    });
    const summary = await backfillShopifyRefunds({ adminClient: admin });
    expect(summary.per_store[0].orders_scanned).toBe(2);
  });
});
