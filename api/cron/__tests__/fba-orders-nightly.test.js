// Tests for the FBA orders ingest cron + the ingestAllAccounts /
// syncAccountOrders core (P12a-2).

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import {
  computeSinceTime,
  mapOrderRow,
  mapOrderItemRow,
  syncAccountOrders,
  ingestAllAccounts,
} from "../../_lib/marketplaces/fba/ingest-orders.js";
import { encryptToken } from "../../_lib/marketplaces/fba/token-encryption.js";
import { _clearCacheForTest } from "../../_lib/marketplaces/fba/lwa.js";

const TEST_KEY = "1".repeat(64);

beforeAll(() => {
  process.env.FBA_TOKEN_ENC_KEY = TEST_KEY;
});

beforeEach(() => {
  _clearCacheForTest();
});

function makeEncryptedTriple(plaintext) {
  const b = encryptToken(plaintext);
  return { ct: b.ciphertext, iv: b.iv, tag: b.tag };
}

function makeAccount(overrides = {}) {
  const cid = makeEncryptedTriple("amzn1.application-oa2-client.x");
  const csec = makeEncryptedTriple("client-secret-x");
  const ref = makeEncryptedTriple("Atzr|refresh-x");
  return {
    id: overrides.id || "11111111-1111-1111-1111-111111111111",
    entity_id: "22222222-2222-2222-2222-222222222222",
    region: "NA",
    marketplace_id: "ATVPDKIKX0DER",
    is_active: true,
    last_orders_sync_at: null,
    aws_role_arn: null,
    lwa_client_id_ciphertext: cid.ct,
    lwa_client_id_iv: cid.iv,
    lwa_client_id_tag: cid.tag,
    lwa_client_secret_ciphertext: csec.ct,
    lwa_client_secret_iv: csec.iv,
    lwa_client_secret_tag: csec.tag,
    refresh_token_ciphertext: ref.ct,
    refresh_token_iv: ref.iv,
    refresh_token_tag: ref.tag,
    ...overrides,
  };
}

/**
 * Minimal supabase chain mock — tracks every upsert/update call so tests
 * can assert against them.
 */
function makeSupabaseMock(opts = {}) {
  const calls = { upserts: [], updates: [], selects: [] };
  const accountsResp = opts.accountsResp || { data: [], error: null };

  function table(name) {
    if (name === "fba_seller_accounts") {
      return {
        select: () => ({
          eq: () => Promise.resolve(accountsResp),
        }),
        update: (patch) => ({
          eq: (col, val) => {
            calls.updates.push({ table: name, patch, col, val });
            return Promise.resolve({ error: null });
          },
        }),
      };
    }
    if (name === "fba_orders") {
      return {
        upsert: (row, opts2) => {
          calls.upserts.push({ table: name, row, opts: opts2 });
          return {
            select: () => ({
              maybeSingle: () => Promise.resolve({
                data: {
                  id: `order-${calls.upserts.filter((u) => u.table === "fba_orders").length}`,
                  amazon_order_id: row.amazon_order_id,
                },
                error: null,
              }),
            }),
          };
        },
      };
    }
    if (name === "fba_order_items") {
      return {
        upsert: (row, opts2) => {
          calls.upserts.push({ table: name, row, opts: opts2 });
          return Promise.resolve({ error: null });
        },
      };
    }
    throw new Error(`unexpected table: ${name}`);
  }

  return {
    from: table,
    _calls: calls,
  };
}

function makeFakeSpApi({ orders = [], items = {} } = {}) {
  return {
    listOrders: async () => ({ Orders: orders, NextToken: null }),
    getOrderItems: async (id) => ({ OrderItems: items[id] || [], NextToken: null }),
  };
}

function makeRefreshFn() {
  return async () => ({ access_token: "Atza|fake", token_type: "bearer", expires_in: 3600, cached: false });
}

describe("computeSinceTime", () => {
  it("returns now - 14 days when lastSyncAt is null", () => {
    const now = new Date("2026-05-28T00:00:00Z");
    const since = computeSinceTime(null, now);
    expect(since).toBe("2026-05-14T00:00:00.000Z");
  });

  it("returns lastSyncAt when within 14d", () => {
    const now = new Date("2026-05-28T00:00:00Z");
    expect(computeSinceTime("2026-05-25T00:00:00Z", now)).toBe("2026-05-25T00:00:00.000Z");
  });

  it("clamps to 14d ago when lastSyncAt is older", () => {
    const now = new Date("2026-05-28T00:00:00Z");
    expect(computeSinceTime("2025-01-01T00:00:00Z", now)).toBe("2026-05-14T00:00:00.000Z");
  });

  it("handles invalid lastSyncAt strings", () => {
    const now = new Date("2026-05-28T00:00:00Z");
    expect(computeSinceTime("garbage", now)).toBe("2026-05-14T00:00:00.000Z");
  });
});

describe("mapOrderRow", () => {
  it("rounds OrderTotal.Amount to cents", () => {
    const row = mapOrderRow({
      AmazonOrderId: "111-1-1",
      PurchaseDate: "2026-05-20T00:00:00Z",
      LastUpdateDate: "2026-05-21T00:00:00Z",
      OrderStatus: "Shipped",
      FulfillmentChannel: "AFN",
      MarketplaceId: "ATVPDKIKX0DER",
      OrderTotal: { Amount: "12.34", CurrencyCode: "USD" },
    }, "acct-1");
    expect(row.order_total_cents).toBe(1234);
    expect(row.currency).toBe("USD");
    expect(row.fulfillment_channel).toBe("AFN");
  });

  it("defaults missing OrderTotal to 0", () => {
    const row = mapOrderRow({ AmazonOrderId: "x", PurchaseDate: "a", LastUpdateDate: "b", OrderStatus: "Pending" }, "acct-1");
    expect(row.order_total_cents).toBe(0);
    expect(row.currency).toBe("USD");
  });

  it("clamps fulfillment_channel to AFN|MFN", () => {
    const row = mapOrderRow({
      AmazonOrderId: "x", PurchaseDate: "a", LastUpdateDate: "b", OrderStatus: "x",
      FulfillmentChannel: "GARBAGE",
      OrderTotal: { Amount: "0", CurrencyCode: "USD" },
    }, "acct");
    expect(row.fulfillment_channel).toBe("MFN");
  });
});

describe("mapOrderItemRow", () => {
  it("maps ItemPrice and tax to cents", () => {
    const item = mapOrderItemRow({
      OrderItemId: "oi-1",
      ASIN: "B0XXX",
      SellerSKU: "SKU-1",
      Title: "Tee",
      QuantityOrdered: 2,
      QuantityShipped: 2,
      ItemPrice: { Amount: "50.00" },
      ItemTax: { Amount: "4.13" },
      PromotionDiscount: { Amount: "1.50" },
    }, "ord-1");
    expect(item.item_price_cents).toBe(5000);
    expect(item.item_tax_cents).toBe(413);
    expect(item.promotion_discount_cents).toBe(150);
    expect(item.sku).toBe("SKU-1");
    expect(item.asin).toBe("B0XXX");
  });
});

describe("syncAccountOrders — happy path", () => {
  it("upserts an order and its items, then bumps last_orders_sync_at", async () => {
    const supabase = makeSupabaseMock();
    const orders = [{
      AmazonOrderId: "111-1-1",
      PurchaseDate: "2026-05-25T00:00:00Z",
      LastUpdateDate: "2026-05-26T00:00:00Z",
      OrderStatus: "Shipped",
      FulfillmentChannel: "AFN",
      MarketplaceId: "ATVPDKIKX0DER",
      OrderTotal: { Amount: "20.00", CurrencyCode: "USD" },
    }];
    const items = { "111-1-1": [{
      OrderItemId: "oi-1", SellerSKU: "SKU-1", QuantityOrdered: 1,
      ItemPrice: { Amount: "20.00" },
    }] };
    const acct = makeAccount();
    const summary = await syncAccountOrders(supabase, acct, {
      postJe: false, // P12a-3 — auto-post tested separately below
      now: new Date("2026-05-28T00:00:00Z"),
      deps: {
        refreshAccessToken: makeRefreshFn(),
        makeClient: () => makeFakeSpApi({ orders, items }),
      },
    });
    expect(summary.orders_upserted).toBe(1);
    expect(summary.items_upserted).toBe(1);
    expect(supabase._calls.upserts.filter((u) => u.table === "fba_orders")).toHaveLength(1);
    expect(supabase._calls.upserts.filter((u) => u.table === "fba_order_items")).toHaveLength(1);
    expect(supabase._calls.updates).toHaveLength(1);
    expect(supabase._calls.updates[0].patch.last_orders_sync_at).toBe("2026-05-28T00:00:00.000Z");
  });

  it("computes since from now - 14 days for fresh account", async () => {
    const supabase = makeSupabaseMock();
    const acct = makeAccount({ last_orders_sync_at: null });
    let sinceArg = null;
    const fakeClient = {
      listOrders: async ({ lastUpdatedAfter }) => { sinceArg = lastUpdatedAfter; return { Orders: [], NextToken: null }; },
      getOrderItems: async () => ({ OrderItems: [] }),
    };
    await syncAccountOrders(supabase, acct, {
      postJe: false,
      now: new Date("2026-05-28T00:00:00Z"),
      deps: { refreshAccessToken: makeRefreshFn(), makeClient: () => fakeClient },
    });
    expect(sinceArg).toBe("2026-05-14T00:00:00.000Z");
  });

  it("uses opts.since override when provided", async () => {
    const supabase = makeSupabaseMock();
    const acct = makeAccount();
    let sinceArg = null;
    const fakeClient = {
      listOrders: async ({ lastUpdatedAfter }) => { sinceArg = lastUpdatedAfter; return { Orders: [], NextToken: null }; },
      getOrderItems: async () => ({ OrderItems: [] }),
    };
    await syncAccountOrders(supabase, acct, {
      postJe: false,
      since: "2026-05-20T00:00:00Z",
      deps: { refreshAccessToken: makeRefreshFn(), makeClient: () => fakeClient },
    });
    expect(sinceArg).toBe("2026-05-20T00:00:00Z");
  });

  it("paginates listOrders via NextToken", async () => {
    const supabase = makeSupabaseMock();
    let pages = 0;
    const fakeClient = {
      listOrders: async (args) => {
        pages++;
        if (pages === 1) return { Orders: [{
          AmazonOrderId: "p1", PurchaseDate: "2026-05-20T00:00:00Z",
          LastUpdateDate: "2026-05-20T00:00:00Z", OrderStatus: "Shipped",
          FulfillmentChannel: "AFN", OrderTotal: { Amount: "1", CurrencyCode: "USD" },
        }], NextToken: "next-1" };
        if (pages === 2) {
          expect(args.nextToken).toBe("next-1");
          return { Orders: [{
            AmazonOrderId: "p2", PurchaseDate: "2026-05-21T00:00:00Z",
            LastUpdateDate: "2026-05-21T00:00:00Z", OrderStatus: "Shipped",
            FulfillmentChannel: "AFN", OrderTotal: { Amount: "1", CurrencyCode: "USD" },
          }], NextToken: null };
        }
        throw new Error("over-paginated");
      },
      getOrderItems: async () => ({ OrderItems: [] }),
    };
    const summary = await syncAccountOrders(supabase, makeAccount(), {
      postJe: false,
      deps: { refreshAccessToken: makeRefreshFn(), makeClient: () => fakeClient },
    });
    expect(summary.pages).toBe(2);
    expect(summary.orders_upserted).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────
// P12a-3 — auto-post JE per order after ingest
// ─────────────────────────────────────────────────────────────────────

describe("syncAccountOrders — P12a-3 auto-post JE", () => {
  it("invokes postFbaOrderJe per order upserted", async () => {
    const supabase = makeSupabaseMock();
    const orders = [
      {
        AmazonOrderId: "111-A",
        PurchaseDate: "2026-05-25T00:00:00Z",
        LastUpdateDate: "2026-05-26T00:00:00Z",
        OrderStatus: "Shipped",
        FulfillmentChannel: "AFN",
        OrderTotal: { Amount: "20.00", CurrencyCode: "USD" },
      },
      {
        AmazonOrderId: "111-B",
        PurchaseDate: "2026-05-25T00:00:00Z",
        LastUpdateDate: "2026-05-26T00:00:00Z",
        OrderStatus: "Shipped",
        FulfillmentChannel: "AFN",
        OrderTotal: { Amount: "20.00", CurrencyCode: "USD" },
      },
    ];
    const postFbaOrderJe = vi.fn().mockResolvedValue({ status: "posted", je_id: "je-x" });
    const summary = await syncAccountOrders(supabase, makeAccount(), {
      now: new Date("2026-05-28T00:00:00Z"),
      deps: {
        refreshAccessToken: makeRefreshFn(),
        makeClient: () => makeFakeSpApi({ orders }),
        postFbaOrderJe,
      },
    });
    expect(postFbaOrderJe).toHaveBeenCalledTimes(2);
    expect(summary.je_posted).toBe(2);
    expect(summary.je_errors).toBe(0);
    expect(postFbaOrderJe).toHaveBeenCalledWith(
      expect.objectContaining({ fbaOrderId: expect.any(String), adminClient: supabase }),
    );
  });

  it("does NOT abort ingest when postFbaOrderJe throws — errors are isolated", async () => {
    const supabase = makeSupabaseMock();
    const orders = [
      { AmazonOrderId: "111-A", PurchaseDate: "2026-05-25T00:00:00Z",
        LastUpdateDate: "2026-05-26T00:00:00Z", OrderStatus: "Shipped",
        FulfillmentChannel: "AFN", OrderTotal: { Amount: "20", CurrencyCode: "USD" } },
      { AmazonOrderId: "111-B", PurchaseDate: "2026-05-25T00:00:00Z",
        LastUpdateDate: "2026-05-26T00:00:00Z", OrderStatus: "Shipped",
        FulfillmentChannel: "AFN", OrderTotal: { Amount: "20", CurrencyCode: "USD" } },
    ];
    let call = 0;
    const postFbaOrderJe = vi.fn().mockImplementation(async () => {
      call++;
      if (call === 1) throw new Error("rpc_failed: period closed");
      return { status: "posted", je_id: `je-${call}` };
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const summary = await syncAccountOrders(supabase, makeAccount(), {
        deps: {
          refreshAccessToken: makeRefreshFn(),
          makeClient: () => makeFakeSpApi({ orders }),
          postFbaOrderJe,
        },
      });
      // Both orders still upserted; ingest didn't abort.
      expect(summary.orders_upserted).toBe(2);
      expect(summary.je_posted).toBe(1);
      expect(summary.je_errors).toBe(1);
      // Error was logged
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("does NOT call postFbaOrderJe when postJe option = false", async () => {
    const supabase = makeSupabaseMock();
    const orders = [{
      AmazonOrderId: "111-A", PurchaseDate: "2026-05-25T00:00:00Z",
      LastUpdateDate: "2026-05-26T00:00:00Z", OrderStatus: "Shipped",
      FulfillmentChannel: "AFN", OrderTotal: { Amount: "1", CurrencyCode: "USD" },
    }];
    const postFbaOrderJe = vi.fn();
    await syncAccountOrders(supabase, makeAccount(), {
      postJe: false,
      deps: {
        refreshAccessToken: makeRefreshFn(),
        makeClient: () => makeFakeSpApi({ orders }),
        postFbaOrderJe,
      },
    });
    expect(postFbaOrderJe).not.toHaveBeenCalled();
  });
});

describe("syncAccountOrders — error surfacing", () => {
  it("throws when fba_orders upsert errors", async () => {
    const supabase = {
      from: (name) => {
        if (name === "fba_orders") {
          return {
            upsert: () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: { message: "boom" } }) }) }),
          };
        }
        if (name === "fba_seller_accounts") {
          return { update: () => ({ eq: async () => ({ error: null }) }) };
        }
        throw new Error("nope");
      },
    };
    const orders = [{
      AmazonOrderId: "x", PurchaseDate: "a", LastUpdateDate: "b", OrderStatus: "S",
      FulfillmentChannel: "AFN", OrderTotal: { Amount: "1", CurrencyCode: "USD" },
    }];
    await expect(syncAccountOrders(supabase, makeAccount(), {
      deps: { refreshAccessToken: makeRefreshFn(), makeClient: () => makeFakeSpApi({ orders }) },
    })).rejects.toThrow(/boom/);
  });
});

describe("ingestAllAccounts — multi-account loop + error isolation", () => {
  it("processes every active account and isolates failures", async () => {
    const acctA = makeAccount({ id: "a-a-a-a-a" });
    const acctB = makeAccount({ id: "b-b-b-b-b" });
    const supabase = makeSupabaseMock({
      accountsResp: { data: [acctA, acctB], error: null },
    });

    // A succeeds, B throws inside listOrders.
    let calls = 0;
    const refreshFn = makeRefreshFn();
    const out = await ingestAllAccounts(supabase, {
      deps: {
        refreshAccessToken: refreshFn,
        makeClient: () => {
          const idx = ++calls;
          return idx === 1
            ? makeFakeSpApi({ orders: [] })
            : { listOrders: async () => { throw new Error("spapi 403"); }, getOrderItems: async () => ({}) };
        },
      },
    });
    expect(out.accounts).toHaveLength(2);
    expect(out.accounts[0].ok).toBe(true);
    expect(out.accounts[1].ok).toBe(false);
    expect(out.accounts[1].error).toMatch(/spapi 403/);
  });

  it("returns started_at and finished_at timestamps", async () => {
    const supabase = makeSupabaseMock({ accountsResp: { data: [], error: null } });
    const out = await ingestAllAccounts(supabase);
    expect(typeof out.started_at).toBe("string");
    expect(typeof out.finished_at).toBe("string");
    expect(new Date(out.finished_at).getTime()).toBeGreaterThanOrEqual(new Date(out.started_at).getTime());
  });

  it("throws when accounts read fails", async () => {
    const supabase = makeSupabaseMock({
      accountsResp: { data: null, error: { message: "rls denied" } },
    });
    await expect(ingestAllAccounts(supabase)).rejects.toThrow(/rls denied/);
  });

  it("returns empty accounts array when no active rows", async () => {
    const supabase = makeSupabaseMock({ accountsResp: { data: [], error: null } });
    const out = await ingestAllAccounts(supabase);
    expect(out.accounts).toEqual([]);
  });
});
