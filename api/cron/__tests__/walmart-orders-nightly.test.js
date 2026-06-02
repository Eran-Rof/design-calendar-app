// Tests for Tangerine P12b-2 — Walmart orders nightly cron orchestrator.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  runWalmartOrdersNightly,
  ingestOneAccount,
  computeStartDate,
  extractOrderTotals,
  extractLineRow,
} from "../walmart-orders-nightly.js";

function makeSupabase({ accounts = [], orderUpsertId = "wm-order-uuid-1", upsertErrors = {} } = {}) {
  const calls = { from: [], upserts: [], updates: [] };
  const supabase = {
    from(table) {
      calls.from.push(table);
      if (table === "walmart_seller_accounts") {
        const q = {
          _filters: {},
          select() { return q; },
          eq(field, value) { q._filters[field] = value; return q; },
          then(resolve) {
            // Only acts as a thenable when used with await — for select chain.
            return Promise.resolve({ data: accounts, error: null }).then(resolve);
          },
          update(payload) {
            calls.updates.push({ table, payload });
            return {
              eq(field, value) {
                calls.updates[calls.updates.length - 1].eq = { field, value };
                return Promise.resolve({ data: null, error: null });
              },
            };
          },
        };
        return q;
      }
      if (table === "walmart_orders") {
        return {
          upsert(row, opts) {
            calls.upserts.push({ table, row, opts });
            if (upsertErrors.walmart_orders) {
              return {
                select() { return { maybeSingle: async () => ({ data: null, error: { message: upsertErrors.walmart_orders } }) }; },
              };
            }
            return {
              select() {
                return {
                  maybeSingle: async () => ({
                    data: { id: orderUpsertId, purchase_order_id: row.purchase_order_id },
                    error: null,
                  }),
                };
              },
            };
          },
        };
      }
      if (table === "walmart_order_items") {
        return {
          upsert(rows, opts) {
            calls.upserts.push({ table, row: rows, opts });
            if (upsertErrors.walmart_order_items) {
              return Promise.resolve({ data: null, error: { message: upsertErrors.walmart_order_items } });
            }
            return Promise.resolve({ data: null, error: null });
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { supabase, calls };
}

function makeAcct(over = {}) {
  return {
    id: "acct-1",
    entity_id: "entity-1",
    partner_id: "PARTNER1",
    account_name: "ROF WM",
    client_id_ciphertext: Buffer.from("ct"),
    client_id_iv: Buffer.from("iv"),
    client_id_tag: Buffer.from("tg"),
    client_secret_ciphertext: Buffer.from("ct"),
    client_secret_iv: Buffer.from("iv"),
    client_secret_tag: Buffer.from("tg"),
    is_active: true,
    last_orders_sync_at: null,
    ...over,
  };
}

function fakeClient({ orders = [], orderLines = [] } = {}) {
  return {
    listOrders: vi.fn().mockImplementation(async ({ nextCursor }) => {
      if (nextCursor) return { data: [], nextCursor: null };
      return { data: orders, nextCursor: null };
    }),
    getOrderItems: vi.fn().mockImplementation(async () => ({ data: orderLines, nextCursor: null })),
  };
}

describe("computeStartDate", () => {
  it("returns now-7d when lastSync is null", () => {
    const now = Date.parse("2026-05-28T00:00:00Z");
    const got = computeStartDate(null, now);
    expect(got).toBe(new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString());
  });
  it("returns lastSync when it is more recent than 7d ago", () => {
    const now = Date.parse("2026-05-28T00:00:00Z");
    const last = "2026-05-26T00:00:00.000Z";
    expect(computeStartDate(last, now)).toBe(last);
  });
  it("returns now-7d when lastSync is older than 7d", () => {
    const now = Date.parse("2026-05-28T00:00:00Z");
    expect(computeStartDate("2026-05-01T00:00:00.000Z", now))
      .toBe(new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString());
  });
  it("handles bad input gracefully (now-7d fallback)", () => {
    const now = Date.parse("2026-05-28T00:00:00Z");
    expect(computeStartDate("not-a-date", now))
      .toBe(new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString());
  });
});

describe("extractOrderTotals", () => {
  it("sums per-line charges into header totals (item + tax + shipping − discount)", () => {
    const order = {
      orderLines: {
        orderLine: [
          {
            charges: {
              charge: [
                { chargeType: "PRODUCT", chargeAmount: { amount: 25.0, currency: "USD" } },
                { chargeType: "TAX",     chargeAmount: { amount:  2.0, currency: "USD" } },
                { chargeType: "SHIPPING", chargeAmount: { amount:  5.0, currency: "USD" } },
                { chargeType: "DISCOUNT", chargeAmount: { amount:  3.0, currency: "USD" } },
              ],
            },
          },
        ],
      },
    };
    const t = extractOrderTotals(order);
    expect(t.item_subtotal_cents).toBe(2500);
    expect(t.tax_collected_cents).toBe(200);
    expect(t.shipping_cents).toBe(500);
    expect(t.discount_cents).toBe(300);
    expect(t.order_total_cents).toBe(2500 + 200 + 500 - 300);
    expect(t.currency).toBe("USD");
  });
  it("returns all-zero totals on missing lines", () => {
    const t = extractOrderTotals({});
    expect(t.item_subtotal_cents).toBe(0);
    expect(t.tax_collected_cents).toBe(0);
  });
});

describe("extractLineRow", () => {
  it("maps lineNumber, sku, quantity, unit price into the row shape", () => {
    const ln = {
      lineNumber: 3,
      item: { sku: "ABC-001", productName: "Widget" },
      orderLineQuantity: { amount: 5 },
      charges: { charge: [{ chargeAmount: { amount: 12.5 } }] },
    };
    const row = extractLineRow(ln, 0, { id: "wm-order-1" });
    expect(row.walmart_order_id).toBe("wm-order-1");
    expect(row.line_number).toBe(3);
    expect(row.item_sku).toBe("ABC-001");
    expect(row.product_name).toBe("Widget");
    expect(row.quantity).toBe(5);
    expect(row.unit_price_cents).toBe(1250);
  });
  it("falls back to idx+1 when lineNumber missing", () => {
    const row = extractLineRow({}, 7, { id: "wm-order-2" });
    expect(row.line_number).toBe(8);
  });
});

describe("runWalmartOrdersNightly — orchestrator", () => {
  let consoleErr;
  beforeEach(() => {
    consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleErr.mockRestore();
  });

  it("processes all active accounts and aggregates totals", async () => {
    const accts = [
      makeAcct({ id: "a1", partner_id: "P1" }),
      makeAcct({ id: "a2", partner_id: "P2" }),
    ];
    const { supabase } = makeSupabase({ accounts: accts });
    const out = await runWalmartOrdersNightly(supabase, {
      deps: {
        decrypt: () => "decrypted",
        getAccessToken: async () => ({ access_token: "T" }),
        ClientCtor: function Mock({ accessToken }) {
          Object.assign(this, fakeClient({
            orders: [
              { purchaseOrderId: "PO1", orderLines: { orderLine: [{ lineNumber: 1, item: { sku: "S" }, orderLineQuantity: { amount: 1 } }] } },
            ],
          }));
        },
        postJe: async () => ({ status: "posted", je_id: "je-stub" }),
      },
    });
    expect(out.accounts).toHaveLength(2);
    expect(out.total_orders_upserted).toBe(2);
    expect(out.total_items_upserted).toBe(2);
    expect(out.total_errors).toBe(0);
  });

  it("isolates errors: one bad account doesn't break the others", async () => {
    let callCount = 0;
    const accts = [
      makeAcct({ id: "good", partner_id: "G" }),
      makeAcct({ id: "bad", partner_id: "B" }),
    ];
    const { supabase } = makeSupabase({ accounts: accts });
    const out = await runWalmartOrdersNightly(supabase, {
      deps: {
        decrypt: () => "decrypted",
        getAccessToken: async ({ clientId }) => {
          // We can't differentiate by clientId because decrypt always returns "decrypted",
          // so use a call counter to fail the SECOND account.
          callCount += 1;
          if (callCount === 2) throw new Error("auth boom");
          return { access_token: "T" };
        },
        ClientCtor: function Mock() {
          Object.assign(this, fakeClient({
            orders: [{ purchaseOrderId: "POOK", orderLines: { orderLine: [{ lineNumber: 1, item: { sku: "S" }, orderLineQuantity: { amount: 1 } }] } }],
          }));
        },
        postJe: async () => ({ status: "posted", je_id: "je-stub" }),
      },
    });
    expect(out.accounts).toHaveLength(2);
    expect(out.total_errors).toBe(1);
    expect(out.accounts[0].error).toBeNull();
    expect(out.accounts[1].error).toMatch(/auth boom/);
  });

  it("captures missing-ciphertext as a per-account error (not a throw)", async () => {
    const accts = [
      makeAcct({
        id: "a1",
        client_id_ciphertext: null,
        client_id_iv: null,
        client_id_tag: null,
      }),
    ];
    const { supabase } = makeSupabase({ accounts: accts });
    const out = await runWalmartOrdersNightly(supabase, {
      deps: {
        decrypt: () => "x",
        getAccessToken: async () => ({ access_token: "T" }),
        ClientCtor: function Mock() { Object.assign(this, fakeClient()); },
        postJe: async () => ({ status: "posted", je_id: "je-stub" }),
      },
    });
    expect(out.accounts[0].error).toMatch(/missing/i);
    expect(out.total_errors).toBe(1);
  });

  it("filters by account_id when supplied", async () => {
    const accts = [
      makeAcct({ id: "wanted" }),
    ];
    const { supabase, calls } = makeSupabase({ accounts: accts });
    await runWalmartOrdersNightly(supabase, {
      account_id: "wanted",
      deps: {
        decrypt: () => "x",
        getAccessToken: async () => ({ access_token: "T" }),
        ClientCtor: function Mock() { Object.assign(this, fakeClient()); },
        postJe: async () => ({ status: "posted", je_id: "je-stub" }),
      },
    });
    expect(calls.from).toContain("walmart_seller_accounts");
  });

  it("returns total_orders_upserted=0 when no accounts", async () => {
    const { supabase } = makeSupabase({ accounts: [] });
    const out = await runWalmartOrdersNightly(supabase, {
      deps: { decrypt: () => "", getAccessToken: async () => ({ access_token: "T" }), ClientCtor: function Mock() { Object.assign(this, fakeClient()); }, postJe: async () => ({ status: "posted", je_id: "je-stub" }) },
    });
    expect(out.accounts).toEqual([]);
    expect(out.total_orders_upserted).toBe(0);
  });

  it("populates started_at + finished_at", async () => {
    const accts = [makeAcct()];
    const { supabase } = makeSupabase({ accounts: accts });
    const out = await runWalmartOrdersNightly(supabase, {
      deps: {
        decrypt: () => "x",
        getAccessToken: async () => ({ access_token: "T" }),
        ClientCtor: function Mock() { Object.assign(this, fakeClient()); },
        postJe: async () => ({ status: "posted", je_id: "je-stub" }),
      },
    });
    expect(typeof out.started_at).toBe("string");
    expect(typeof out.finished_at).toBe("string");
    expect(Date.parse(out.finished_at)).toBeGreaterThanOrEqual(Date.parse(out.started_at));
  });

  it("updates last_orders_sync_at on success", async () => {
    const accts = [makeAcct()];
    const { supabase, calls } = makeSupabase({ accounts: accts });
    await runWalmartOrdersNightly(supabase, {
      deps: {
        decrypt: () => "x",
        getAccessToken: async () => ({ access_token: "T" }),
        ClientCtor: function Mock() { Object.assign(this, fakeClient()); },
        postJe: async () => ({ status: "posted", je_id: "je-stub" }),
      },
    });
    const updates = calls.updates.filter((u) => u.table === "walmart_seller_accounts");
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(updates[0].payload.last_orders_sync_at).toBeTruthy();
  });
});

describe("ingestOneAccount", () => {
  it("walks cursor pagination until nextCursor=null", async () => {
    const acct = makeAcct();
    const { supabase } = makeSupabase({ accounts: [acct] });
    let call = 0;
    const client = {
      listOrders: vi.fn().mockImplementation(async () => {
        call += 1;
        if (call === 1) return { data: [{ purchaseOrderId: "PO_A", orderLines: { orderLine: [{ lineNumber: 1, item: { sku: "x" }, orderLineQuantity: { amount: 1 } }] } }], nextCursor: "?next=1" };
        if (call === 2) return { data: [{ purchaseOrderId: "PO_B", orderLines: { orderLine: [{ lineNumber: 1, item: { sku: "x" }, orderLineQuantity: { amount: 1 } }] } }], nextCursor: null };
        return { data: [], nextCursor: null };
      }),
      getOrderItems: vi.fn().mockResolvedValue({ data: [], nextCursor: null }),
    };
    const deps = {
      decrypt: () => "x",
      getAccessToken: async () => ({ access_token: "T" }),
      ClientCtor: function Mock() { Object.assign(this, client); },
      postJe: async () => ({ status: "posted", je_id: "je-stub" }),
    };
    const out = await ingestOneAccount(supabase, acct, deps, {});
    expect(out.pages_walked).toBe(2);
    expect(out.orders_upserted).toBe(2);
    expect(out.error).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// P12b-3 — Auto-post AR JE after upsert
// ──────────────────────────────────────────────────────────────────────

describe("P12b-3 auto-post JE", () => {
  it("calls deps.postJe with walmartOrderId after each upsert", async () => {
    const accts = [makeAcct()];
    const { supabase } = makeSupabase({ accounts: accts, orderUpsertId: "wm-1" });
    const postJe = vi.fn().mockResolvedValue({ status: "posted", je_id: "je-1" });
    const out = await runWalmartOrdersNightly(supabase, {
      deps: {
        decrypt: () => "x",
        getAccessToken: async () => ({ access_token: "T" }),
        ClientCtor: function Mock() {
          Object.assign(this, fakeClient({
            orders: [
              { purchaseOrderId: "PO-X", orderLines: { orderLine: [
                { lineNumber: 1, item: { sku: "S" }, orderLineQuantity: { amount: 1 } },
              ] } },
            ],
          }));
        },
        postJe,
      },
    });
    expect(postJe).toHaveBeenCalledTimes(1);
    expect(postJe).toHaveBeenCalledWith(
      expect.objectContaining({ walmartOrderId: "wm-1", adminClient: supabase }),
    );
    expect(out.total_je_posted).toBe(1);
    expect(out.total_je_already_posted).toBe(0);
    expect(out.total_je_errors).toBe(0);
  });

  it("aggregates already_posted into total_je_already_posted (idempotent re-ingest)", async () => {
    const accts = [makeAcct()];
    const { supabase } = makeSupabase({ accounts: accts, orderUpsertId: "wm-1" });
    const out = await runWalmartOrdersNightly(supabase, {
      deps: {
        decrypt: () => "x",
        getAccessToken: async () => ({ access_token: "T" }),
        ClientCtor: function Mock() {
          Object.assign(this, fakeClient({
            orders: [
              { purchaseOrderId: "PO-X", orderLines: { orderLine: [
                { lineNumber: 1, item: { sku: "S" }, orderLineQuantity: { amount: 1 } },
              ] } },
            ],
          }));
        },
        postJe: async () => ({ status: "already_posted", je_id: "existing-je" }),
      },
    });
    expect(out.total_je_posted).toBe(0);
    expect(out.total_je_already_posted).toBe(1);
    expect(out.total_je_errors).toBe(0);
  });

  it("captures postJe errors into je_errors without aborting the run", async () => {
    const accts = [makeAcct()];
    const { supabase } = makeSupabase({ accounts: accts, orderUpsertId: "wm-1" });
    const out = await runWalmartOrdersNightly(supabase, {
      deps: {
        decrypt: () => "x",
        getAccessToken: async () => ({ access_token: "T" }),
        ClientCtor: function Mock() {
          Object.assign(this, fakeClient({
            orders: [
              { purchaseOrderId: "PO-FAIL", orderLines: { orderLine: [
                { lineNumber: 1, item: { sku: "S" }, orderLineQuantity: { amount: 1 } },
              ] } },
            ],
          }));
        },
        postJe: async () => {
          const e = new Error("Missing GL accounts: 4500 — Shipping Revenue");
          e.code = "gl_accounts_missing";
          throw e;
        },
      },
    });
    expect(out.total_orders_upserted).toBe(1);
    expect(out.total_je_posted).toBe(0);
    expect(out.total_je_errors).toBe(1);
    // Account-level error should NOT be set — JE error is per-order.
    expect(out.accounts[0].error).toBeNull();
    expect(out.accounts[0].je_errors).toHaveLength(1);
    expect(out.accounts[0].je_errors[0]).toMatchObject({
      walmart_order_id: "wm-1",
      purchase_order_id: "PO-FAIL",
      code: "gl_accounts_missing",
    });
  });

  it("does NOT call postJe when upsertOrder returns null (no purchase_order_id)", async () => {
    const accts = [makeAcct()];
    const { supabase } = makeSupabase({ accounts: accts });
    const postJe = vi.fn();
    await runWalmartOrdersNightly(supabase, {
      deps: {
        decrypt: () => "x",
        getAccessToken: async () => ({ access_token: "T" }),
        ClientCtor: function Mock() {
          Object.assign(this, fakeClient({
            orders: [
              // No purchaseOrderId → upsertOrder returns null
              { orderLines: { orderLine: [{ lineNumber: 1, item: { sku: "S" }, orderLineQuantity: { amount: 1 } }] } },
            ],
          }));
        },
        postJe,
      },
    });
    expect(postJe).not.toHaveBeenCalled();
  });

  it("aggregates mixed posted + already_posted + errors across multiple orders", async () => {
    const accts = [makeAcct()];
    const { supabase } = makeSupabase({ accounts: accts, orderUpsertId: "wm-N" });
    let n = 0;
    const postJe = vi.fn(async () => {
      n += 1;
      if (n === 1) return { status: "posted", je_id: "je-1" };
      if (n === 2) return { status: "already_posted", je_id: "je-2" };
      throw Object.assign(new Error("boom"), { code: "rpc_failed" });
    });
    const out = await runWalmartOrdersNightly(supabase, {
      deps: {
        decrypt: () => "x",
        getAccessToken: async () => ({ access_token: "T" }),
        ClientCtor: function Mock() {
          Object.assign(this, fakeClient({
            orders: [
              { purchaseOrderId: "PO-1", orderLines: { orderLine: [{ lineNumber: 1, item: { sku: "S" }, orderLineQuantity: { amount: 1 } }] } },
              { purchaseOrderId: "PO-2", orderLines: { orderLine: [{ lineNumber: 1, item: { sku: "S" }, orderLineQuantity: { amount: 1 } }] } },
              { purchaseOrderId: "PO-3", orderLines: { orderLine: [{ lineNumber: 1, item: { sku: "S" }, orderLineQuantity: { amount: 1 } }] } },
            ],
          }));
        },
        postJe,
      },
    });
    expect(postJe).toHaveBeenCalledTimes(3);
    expect(out.total_orders_upserted).toBe(3);
    expect(out.total_je_posted).toBe(1);
    expect(out.total_je_already_posted).toBe(1);
    expect(out.total_je_errors).toBe(1);
  });
});
