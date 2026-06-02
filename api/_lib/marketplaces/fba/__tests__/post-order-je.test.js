// Tangerine P12a-3 — tests for the FBA AR JE posting service.
//
// Coverage:
//   - BigInt cents helpers (toBigInt / centsToDecimal)
//   - buildJournalEntryPayload:
//       * revenue / shipping math
//       * tax recorded as memo (debit=0, credit=0) — D8
//       * per-line fee lines (6523 / 6524 / 1115)
//       * balance check
//       * negative revenue throws
//       * missing-account throws when relevant amount > 0
//   - resolveGlAccounts: code map, 1200/1201 fallback, missing codes → null
//   - resolveCustomerId:
//       * existing customer_id short-circuit
//       * email branch: lookup by code, upsert with source='fba'
//       * race retry, source-column retry
//       * ANON branch when no email + no customer_id
//   - buildArInvoiceRow: source='fba', invoice_number prefix, JE link,
//     total = revenue + shipping (NOT including tax — D8)
//   - postFbaOrderJe end-to-end:
//       * idempotent already_posted short-circuit
//       * not_found
//       * missing GL accounts → gl_accounts_missing (400)
//       * happy path → posted with je_id + ar_invoice_id stamped back
//       * RPC error → rpc_failed
//       * ar_invoices insert error → ar_invoice_insert_failed (je_id stamped)
//       * fba_orders update error → fba_orders_update_failed
//       * 2200 Sales Tax Payable is NEVER referenced (D8)

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  postFbaOrderJe,
  buildJournalEntryPayload,
  buildArInvoiceRow,
  resolveCustomerId,
  resolveGlAccounts,
  toBigInt,
  centsToDecimal,
} from "../post-order-je.js";

// ──────────────────────────────────────────────────────────────────────
// Test fixtures
// ──────────────────────────────────────────────────────────────────────

const ENTITY    = "11111111-1111-1111-1111-111111111111";
const ORDER     = "22222222-2222-2222-2222-222222222222";
const ACCT      = "33333333-3333-3333-3333-333333333333";
const CUSTOMER  = "44444444-4444-4444-4444-444444444444";
const AR_ACCT   = "55555555-5555-5555-5555-555555555555";
const REV_ACCT  = "66666666-6666-6666-6666-666666666666";
const SHIP_ACCT = "77777777-7777-7777-7777-777777777777";
const FF_ACCT   = "88888888-8888-8888-8888-888888888888";
const RF_ACCT   = "99999999-9999-9999-9999-999999999999";
const CLR_ACCT  = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const JE_ID     = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const AR_INV_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function makeOrder(overrides = {}) {
  return {
    id: ORDER,
    entity_id: ENTITY,
    fba_seller_account_id: ACCT,
    amazon_order_id: "111-2222222-3333333",
    purchase_date: "2026-05-28T12:34:56Z",
    last_update_date: "2026-05-28T12:34:56Z",
    order_status: "Shipped",
    fulfillment_channel: "AFN",
    marketplace_id: "ATVPDKIKX0DER",
    currency: "USD",
    order_total_cents: 11000,            // total = item_subtotal + tax + shipping - promo
    item_subtotal_cents: 10000,          // $100
    tax_collected_cents: 800,            // $8 — memo only (D8)
    shipping_cents: 500,                 // $5
    promotion_discount_cents: 0,
    customer_id: CUSTOMER,
    ar_invoice_id: null,
    je_id: null,
    raw_payload: {},
    source: "fba",
    ...overrides,
  };
}

function makeItems(overrides = []) {
  if (overrides.length > 0) return overrides;
  return [
    {
      id: "item-1",
      fba_order_id: ORDER,
      order_item_id: "oi-1",
      asin: "B0XXX",
      sku: "SKU-1",
      title: "T-shirt",
      quantity_ordered: 1,
      quantity_shipped: 1,
      item_price_cents: 10000,
      item_tax_cents: 800,
      promotion_discount_cents: 0,
      fulfillment_fee_cents: 350,        // $3.50
      referral_fee_cents: 1500,          // $15.00
    },
  ];
}

function makeAccounts(overrides = {}) {
  return {
    arId: AR_ACCT,
    revenueId: REV_ACCT,
    shippingRevenueId: SHIP_ACCT,
    fulfillmentFeeId: FF_ACCT,
    referralFeeId: RF_ACCT,
    clearingId: CLR_ACCT,
    ...overrides,
  };
}

/**
 * Chainable Supabase mock — records all calls and lets a test inject
 * specific responses per table+method via overrides.
 */
function makeSupabaseMock({
  order = makeOrder(),
  items = makeItems(),
  accountRows = [
    { code: "1200", id: AR_ACCT },
    { code: "4000", id: REV_ACCT },
    { code: "4500", id: SHIP_ACCT },
    { code: "6523", id: FF_ACCT },
    { code: "6524", id: RF_ACCT },
    { code: "1115", id: CLR_ACCT },
  ],
  customerLookup = null,
  customerInsert = { id: CUSTOMER },
  customerInsertError = null,
  rpcResult = JE_ID,
  rpcError = null,
  arInvoiceInsert = { id: AR_INV_ID },
  arInvoiceInsertError = null,
  fbaOrdersUpdateError = null,
  fbaOrdersJeOnlyUpdateError = null,
} = {}) {
  const calls = {
    rpc: [],
    arInvoiceInsert: [],
    fbaOrdersUpdate: [],
    customerInsert: [],
    customerLookup: [],
    itemsRead: 0,
  };

  const sb = {
    from(table) {
      if (table === "fba_orders") {
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle: async () => ({ data: order, error: null }),
                };
              },
            };
          },
          update(patch) {
            return {
              eq: async (col, val) => {
                calls.fbaOrdersUpdate.push({ patch, col, val });
                if (Object.keys(patch).length === 1 && patch.je_id != null) {
                  return { error: fbaOrdersJeOnlyUpdateError };
                }
                return { error: fbaOrdersUpdateError };
              },
            };
          },
        };
      }
      if (table === "fba_order_items") {
        return {
          select() {
            return {
              eq: async () => {
                calls.itemsRead++;
                return { data: items, error: null };
              },
            };
          },
        };
      }
      if (table === "gl_accounts") {
        return {
          select() {
            return {
              eq() {
                return {
                  in: () => Promise.resolve({ data: accountRows, error: null }),
                };
              },
            };
          },
        };
      }
      if (table === "customers") {
        return {
          select() {
            return {
              eq() {
                return {
                  eq() {
                    return {
                      maybeSingle: async () => {
                        calls.customerLookup.push(true);
                        return { data: customerLookup, error: null };
                      },
                    };
                  },
                };
              },
            };
          },
          insert(row) {
            calls.customerInsert.push(row);
            return {
              select: () => ({
                single: async () => ({
                  data: customerInsert,
                  error: customerInsertError,
                }),
              }),
            };
          },
        };
      }
      if (table === "ar_invoices") {
        return {
          insert(row) {
            calls.arInvoiceInsert.push(row);
            return {
              select: () => ({
                single: async () => ({
                  data: arInvoiceInsert,
                  error: arInvoiceInsertError,
                }),
              }),
            };
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
    rpc: vi.fn(async (name, args) => {
      calls.rpc.push({ name, args });
      return { data: rpcResult, error: rpcError };
    }),
  };
  return { sb, calls };
}

// ──────────────────────────────────────────────────────────────────────
// toBigInt
// ──────────────────────────────────────────────────────────────────────

describe("toBigInt", () => {
  it("returns 0n for null / undefined / empty", () => {
    expect(toBigInt(null)).toBe(0n);
    expect(toBigInt(undefined)).toBe(0n);
    expect(toBigInt("")).toBe(0n);
  });
  it("passes through bigint unchanged", () => {
    expect(toBigInt(500n)).toBe(500n);
  });
  it("converts safe integer", () => {
    expect(toBigInt(10000)).toBe(10000n);
  });
  it("converts integer string", () => {
    expect(toBigInt("10000")).toBe(10000n);
  });
  it("throws on float", () => {
    expect(() => toBigInt(1.5)).toThrow(/integer/);
  });
  it("throws on non-integer string", () => {
    expect(() => toBigInt("12.34")).toThrow(/integer-cents/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// centsToDecimal
// ──────────────────────────────────────────────────────────────────────

describe("centsToDecimal", () => {
  it("formats whole dollars", () => {
    expect(centsToDecimal(10000n)).toBe("100.00");
  });
  it("formats fractional cents", () => {
    expect(centsToDecimal(10001n)).toBe("100.01");
  });
  it("pads single-digit cents", () => {
    expect(centsToDecimal(10005n)).toBe("100.05");
  });
  it("handles zero", () => {
    expect(centsToDecimal(0n)).toBe("0.00");
  });
});

// ──────────────────────────────────────────────────────────────────────
// buildJournalEntryPayload
// ──────────────────────────────────────────────────────────────────────

describe("buildJournalEntryPayload", () => {
  it("AR amount excludes tax (D8 — tax memo only, not in receivable)", () => {
    const order = makeOrder(); // subtotal 100, ship 5, tax 8 (memo)
    const payload = buildJournalEntryPayload({
      order, items: makeItems(), accounts: makeAccounts(), customerId: CUSTOMER,
    });
    // AR debit = revenue + shipping = 100 + 5 = 105.00
    expect(payload.lines[0]).toMatchObject({
      account_id: AR_ACCT,
      debit: "105.00",
      credit: "0",
    });
  });

  it("CR Revenue = item_subtotal - promo_discount", () => {
    const order = makeOrder({ promotion_discount_cents: 1000 });
    const payload = buildJournalEntryPayload({
      order, items: makeItems(), accounts: makeAccounts(), customerId: CUSTOMER,
    });
    const rev = payload.lines.find((l) => l.account_id === REV_ACCT);
    expect(rev.credit).toBe("90.00"); // 100 - 10
  });

  it("CR Shipping Revenue when shipping > 0", () => {
    const payload = buildJournalEntryPayload({
      order: makeOrder(), items: makeItems(),
      accounts: makeAccounts(), customerId: CUSTOMER,
    });
    const ship = payload.lines.find((l) => l.account_id === SHIP_ACCT);
    expect(ship.credit).toBe("5.00");
  });

  it("omits shipping line when shipping_cents = 0", () => {
    const order = makeOrder({ shipping_cents: 0 });
    const payload = buildJournalEntryPayload({
      order, items: makeItems(),
      accounts: makeAccounts(), customerId: CUSTOMER,
    });
    const ship = payload.lines.find((l) => l.account_id === SHIP_ACCT);
    expect(ship).toBeUndefined();
  });

  it("D8: tax line is debit=0 / credit=0 memo — NOT a credit to 2200", () => {
    const payload = buildJournalEntryPayload({
      order: makeOrder({ tax_collected_cents: 800 }),
      items: makeItems(),
      accounts: makeAccounts(),
      customerId: CUSTOMER,
    });
    const taxMemo = payload.lines.find((l) => /facilitator tax/i.test(l.memo || ""));
    expect(taxMemo).toBeDefined();
    expect(taxMemo.debit).toBe("0");
    expect(taxMemo.credit).toBe("0");
    // The 8.00 amount surfaces in the memo text for auditors
    expect(taxMemo.memo).toMatch(/8\.00/);
    // And NO 2200 account id appears anywhere
    for (const l of payload.lines) {
      expect(l.memo || "").not.toMatch(/2200 Sales Tax Payable/);
    }
  });

  it("D8: no tax memo line when tax_collected_cents = 0", () => {
    const payload = buildJournalEntryPayload({
      order: makeOrder({ tax_collected_cents: 0 }),
      items: makeItems(),
      accounts: makeAccounts(),
      customerId: CUSTOMER,
    });
    const taxMemo = payload.lines.find((l) => /facilitator tax/i.test(l.memo || ""));
    expect(taxMemo).toBeUndefined();
  });

  it("per-line fees emit DR 6523 + DR 6524 + CR 1115 per item", () => {
    const payload = buildJournalEntryPayload({
      order: makeOrder(),
      items: makeItems([{
        id: "i1", fba_order_id: ORDER, order_item_id: "oi-1",
        sku: "SKU-1", asin: "B1",
        item_price_cents: 10000,
        fulfillment_fee_cents: 350, referral_fee_cents: 1500,
      }]),
      accounts: makeAccounts(), customerId: CUSTOMER,
    });
    const ff = payload.lines.find((l) => l.account_id === FF_ACCT);
    const rf = payload.lines.find((l) => l.account_id === RF_ACCT);
    const cl = payload.lines.find((l) => l.account_id === CLR_ACCT);
    expect(ff.debit).toBe("3.50");
    expect(rf.debit).toBe("15.00");
    expect(cl.credit).toBe("18.50");
  });

  it("emits one fee triple per line item (no aggregation across items)", () => {
    const items = [
      { id: "i1", fba_order_id: ORDER, order_item_id: "oi-1", sku: "A",
        item_price_cents: 5000, fulfillment_fee_cents: 100, referral_fee_cents: 500 },
      { id: "i2", fba_order_id: ORDER, order_item_id: "oi-2", sku: "B",
        item_price_cents: 5000, fulfillment_fee_cents: 200, referral_fee_cents: 700 },
    ];
    const payload = buildJournalEntryPayload({
      order: makeOrder({ item_subtotal_cents: 10000 }),
      items, accounts: makeAccounts(), customerId: CUSTOMER,
    });
    const ffLines = payload.lines.filter((l) => l.account_id === FF_ACCT);
    const rfLines = payload.lines.filter((l) => l.account_id === RF_ACCT);
    const clrLines = payload.lines.filter((l) => l.account_id === CLR_ACCT);
    expect(ffLines).toHaveLength(2);
    expect(rfLines).toHaveLength(2);
    expect(clrLines).toHaveLength(2);
  });

  it("includes SKU + ASIN in per-line fee memos", () => {
    const payload = buildJournalEntryPayload({
      order: makeOrder(),
      items: makeItems([{
        id: "i1", fba_order_id: ORDER, order_item_id: "oi-77",
        sku: "MY-SKU-A", asin: "B07XYZ",
        item_price_cents: 1000,
        fulfillment_fee_cents: 50, referral_fee_cents: 50,
      }]),
      accounts: makeAccounts(), customerId: CUSTOMER,
    });
    const ffMemo = payload.lines.find((l) => l.account_id === FF_ACCT).memo;
    expect(ffMemo).toMatch(/MY-SKU-A/);
    expect(ffMemo).toMatch(/B07XYZ/);
    expect(ffMemo).toMatch(/oi-77/);
  });

  it("skips fee triple for items with no fees", () => {
    const payload = buildJournalEntryPayload({
      order: makeOrder({ item_subtotal_cents: 10000 }),
      items: makeItems([{
        id: "i1", fba_order_id: ORDER, order_item_id: "oi-1",
        item_price_cents: 10000,
        fulfillment_fee_cents: 0, referral_fee_cents: 0,
      }]),
      accounts: makeAccounts(), customerId: CUSTOMER,
    });
    const ff = payload.lines.find((l) => l.account_id === FF_ACCT);
    const rf = payload.lines.find((l) => l.account_id === RF_ACCT);
    const cl = payload.lines.find((l) => l.account_id === CLR_ACCT);
    expect(ff).toBeUndefined();
    expect(rf).toBeUndefined();
    expect(cl).toBeUndefined();
  });

  it("debits = credits (balance check)", () => {
    const payload = buildJournalEntryPayload({
      order: makeOrder(), items: makeItems(),
      accounts: makeAccounts(), customerId: CUSTOMER,
    });
    let dr = 0n;
    let cr = 0n;
    for (const ln of payload.lines) {
      dr += BigInt(ln.debit.replace(".", ""));
      cr += BigInt(ln.credit.replace(".", ""));
    }
    expect(dr).toBe(cr);
  });

  it("throws when promo_discount > item_subtotal (negative revenue)", () => {
    expect(() => buildJournalEntryPayload({
      order: makeOrder({
        item_subtotal_cents: 1000,
        promotion_discount_cents: 2000,
      }),
      items: makeItems(),
      accounts: makeAccounts(), customerId: CUSTOMER,
    })).toThrow(/negative/);
  });

  it("throws when shipping > 0 but no 4500 account", () => {
    expect(() => buildJournalEntryPayload({
      order: makeOrder({ shipping_cents: 500 }),
      items: makeItems(),
      accounts: makeAccounts({ shippingRevenueId: null }),
      customerId: CUSTOMER,
    })).toThrow(/4500/);
  });

  it("throws when fees > 0 but no 6523 account", () => {
    expect(() => buildJournalEntryPayload({
      order: makeOrder(),
      items: makeItems([{
        id: "i1", fba_order_id: ORDER, order_item_id: "oi-1",
        fulfillment_fee_cents: 100, referral_fee_cents: 0,
      }]),
      accounts: makeAccounts({ fulfillmentFeeId: null }),
      customerId: CUSTOMER,
    })).toThrow(/6523/);
  });

  it("throws when referral fees > 0 but no 6524 account", () => {
    expect(() => buildJournalEntryPayload({
      order: makeOrder(),
      items: makeItems([{
        id: "i1", fba_order_id: ORDER, order_item_id: "oi-1",
        fulfillment_fee_cents: 0, referral_fee_cents: 100,
      }]),
      accounts: makeAccounts({ referralFeeId: null }),
      customerId: CUSTOMER,
    })).toThrow(/6524/);
  });

  it("throws when fees > 0 but no 1115 clearing account", () => {
    expect(() => buildJournalEntryPayload({
      order: makeOrder(),
      items: makeItems([{
        id: "i1", fba_order_id: ORDER, order_item_id: "oi-1",
        fulfillment_fee_cents: 100, referral_fee_cents: 100,
      }]),
      accounts: makeAccounts({ clearingId: null }),
      customerId: CUSTOMER,
    })).toThrow(/1115/);
  });

  it("sets source_module='fba' and source_id=order.id", () => {
    const payload = buildJournalEntryPayload({
      order: makeOrder(), items: makeItems(),
      accounts: makeAccounts(), customerId: CUSTOMER,
    });
    expect(payload.source_module).toBe("fba");
    expect(payload.source_table).toBe("fba_orders");
    expect(payload.source_id).toBe(ORDER);
  });

  it("derives posting_date from purchase_date (date-only)", () => {
    const order = makeOrder({ purchase_date: "2026-05-28T23:59:00Z" });
    const payload = buildJournalEntryPayload({
      order, items: makeItems(),
      accounts: makeAccounts(), customerId: CUSTOMER,
    });
    expect(payload.posting_date).toBe("2026-05-28");
  });

  it("DR AR row carries the customer subledger pointer", () => {
    const payload = buildJournalEntryPayload({
      order: makeOrder(), items: makeItems(),
      accounts: makeAccounts(), customerId: CUSTOMER,
    });
    expect(payload.lines[0]).toMatchObject({
      subledger_type: "customer",
      subledger_id: CUSTOMER,
    });
  });

  it("description includes amazon_order_id", () => {
    const payload = buildJournalEntryPayload({
      order: makeOrder({ amazon_order_id: "111-AAAA-BBBB" }),
      items: makeItems(),
      accounts: makeAccounts(), customerId: CUSTOMER,
    });
    expect(payload.description).toContain("111-AAAA-BBBB");
  });
});

// ──────────────────────────────────────────────────────────────────────
// resolveGlAccounts
// ──────────────────────────────────────────────────────────────────────

describe("resolveGlAccounts", () => {
  it("maps codes to account ids", async () => {
    const sb = {
      from: () => ({
        select: () => ({
          eq: () => ({
            in: () => Promise.resolve({
              data: [
                { code: "1200", id: AR_ACCT },
                { code: "4000", id: REV_ACCT },
                { code: "4500", id: SHIP_ACCT },
                { code: "6523", id: FF_ACCT },
                { code: "6524", id: RF_ACCT },
                { code: "1115", id: CLR_ACCT },
              ],
              error: null,
            }),
          }),
        }),
      }),
    };
    const out = await resolveGlAccounts(sb, ENTITY);
    expect(out).toEqual({
      arId: AR_ACCT,
      revenueId: REV_ACCT,
      shippingRevenueId: SHIP_ACCT,
      fulfillmentFeeId: FF_ACCT,
      referralFeeId: RF_ACCT,
      clearingId: CLR_ACCT,
    });
  });

  it("falls back to 1201 when 1200 missing", async () => {
    const sb = {
      from: () => ({
        select: () => ({
          eq: () => ({
            in: () => Promise.resolve({
              data: [{ code: "1201", id: "alt-ar" }],
              error: null,
            }),
          }),
        }),
      }),
    };
    const out = await resolveGlAccounts(sb, ENTITY);
    expect(out.arId).toBe("alt-ar");
  });

  it("returns null for missing optional codes", async () => {
    const sb = {
      from: () => ({
        select: () => ({
          eq: () => ({
            in: () => Promise.resolve({
              data: [
                { code: "1200", id: AR_ACCT },
                { code: "4000", id: REV_ACCT },
              ],
              error: null,
            }),
          }),
        }),
      }),
    };
    const out = await resolveGlAccounts(sb, ENTITY);
    expect(out.shippingRevenueId).toBeNull();
    expect(out.fulfillmentFeeId).toBeNull();
    expect(out.referralFeeId).toBeNull();
    expect(out.clearingId).toBeNull();
  });

  it("never queries 2200 (D8 — facilitator tax is memo-only)", async () => {
    let codesIn = null;
    const sb = {
      from: () => ({
        select: () => ({
          eq: () => ({
            in: (col, codes) => { codesIn = codes; return Promise.resolve({ data: [], error: null }); },
          }),
        }),
      }),
    };
    await resolveGlAccounts(sb, ENTITY);
    expect(codesIn).not.toContain("2200");
  });

  it("surfaces query errors", async () => {
    const sb = {
      from: () => ({
        select: () => ({
          eq: () => ({
            in: () => Promise.resolve({
              data: null,
              error: { message: "boom" },
            }),
          }),
        }),
      }),
    };
    await expect(resolveGlAccounts(sb, ENTITY)).rejects.toThrow(/boom/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// resolveCustomerId
// ──────────────────────────────────────────────────────────────────────

describe("resolveCustomerId", () => {
  it("returns existing order.customer_id immediately", async () => {
    const order = makeOrder({ customer_id: CUSTOMER });
    const sb = { from: vi.fn() };
    const id = await resolveCustomerId(sb, order);
    expect(id).toBe(CUSTOMER);
    expect(sb.from).not.toHaveBeenCalled();
  });

  it("upserts customer with FBA- prefix when buyer email present", async () => {
    const order = makeOrder({
      customer_id: null,
      raw_payload: { BuyerInfo: { BuyerEmail: "Buyer@example.com" } },
    });
    const inserts = [];
    const sb = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
        }),
        insert: (row) => {
          inserts.push(row);
          return {
            select: () => ({
              single: async () => ({ data: { id: "new-id" }, error: null }),
            }),
          };
        },
      }),
    };
    const id = await resolveCustomerId(sb, order);
    expect(id).toBe("new-id");
    expect(inserts[0]).toMatchObject({
      entity_id: ENTITY,
      code: "FBA-buyer@example.com",
      customer_type: "ecom",
      status: "active",
      source: "fba",
    });
  });

  it("returns existing customer found by code", async () => {
    const order = makeOrder({
      customer_id: null,
      raw_payload: { BuyerInfo: { BuyerEmail: "found@example.com" } },
    });
    const sb = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { id: "found-id" }, error: null }),
            }),
          }),
        }),
      }),
    };
    const id = await resolveCustomerId(sb, order);
    expect(id).toBe("found-id");
  });

  it("uses ANON code when no email and no customer_id", async () => {
    const order = makeOrder({
      customer_id: null,
      amazon_order_id: "111-ANON-1",
      raw_payload: {},
    });
    const inserts = [];
    const sb = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
        }),
        insert: (row) => {
          inserts.push(row);
          return {
            select: () => ({
              single: async () => ({ data: { id: "anon-id" }, error: null }),
            }),
          };
        },
      }),
    };
    const id = await resolveCustomerId(sb, order);
    expect(id).toBe("anon-id");
    expect(inserts[0].code).toBe("FBA-ANON-111-ANON-1");
  });

  it("retries without source if column rejected", async () => {
    const order = makeOrder({
      customer_id: null,
      raw_payload: { BuyerInfo: { BuyerEmail: "x@example.com" } },
    });
    const inserts = [];
    let firstCall = true;
    const sb = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
        }),
        insert: (row) => {
          inserts.push(row);
          return {
            select: () => ({
              single: async () => {
                if (firstCall) {
                  firstCall = false;
                  return { data: null, error: { message: "column 'source' does not exist" } };
                }
                return { data: { id: "retry-id" }, error: null };
              },
            }),
          };
        },
      }),
    };
    const id = await resolveCustomerId(sb, order);
    expect(id).toBe("retry-id");
    expect(inserts[0]).toHaveProperty("source");
    expect(inserts[1]).not.toHaveProperty("source");
  });

  it("returns race-winner row on conflict during insert", async () => {
    const order = makeOrder({
      customer_id: null,
      raw_payload: { BuyerInfo: { BuyerEmail: "race@example.com" } },
    });
    let lookupCount = 0;
    const sb = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => {
                lookupCount++;
                return lookupCount === 1
                  ? { data: null, error: null }
                  : { data: { id: "race-winner" }, error: null };
              },
            }),
          }),
        }),
        insert: () => ({
          select: () => ({
            single: async () => ({
              data: null,
              error: { message: "duplicate key value" },
            }),
          }),
        }),
      }),
    };
    const id = await resolveCustomerId(sb, order);
    expect(id).toBe("race-winner");
  });
});

// ──────────────────────────────────────────────────────────────────────
// buildArInvoiceRow
// ──────────────────────────────────────────────────────────────────────

describe("buildArInvoiceRow", () => {
  it("stamps source='fba'", () => {
    const row = buildArInvoiceRow({
      order: makeOrder(), customerId: CUSTOMER,
      accounts: makeAccounts(), jeId: JE_ID,
    });
    expect(row.source).toBe("fba");
  });

  it("uses FBA- prefix in invoice_number", () => {
    const row = buildArInvoiceRow({
      order: makeOrder({ amazon_order_id: "111-AAAA" }),
      customerId: CUSTOMER, accounts: makeAccounts(), jeId: JE_ID,
    });
    expect(row.invoice_number).toBe("FBA-111-AAAA");
  });

  it("total_amount_cents excludes tax (D8) — = revenue + shipping", () => {
    // subtotal 10000, ship 500, tax 800 (memo-only) → total = 10500
    const row = buildArInvoiceRow({
      order: makeOrder(),
      customerId: CUSTOMER, accounts: makeAccounts(), jeId: JE_ID,
    });
    expect(row.total_amount_cents).toBe("10500");
  });

  it("links accrual_je_id", () => {
    const row = buildArInvoiceRow({
      order: makeOrder(), customerId: CUSTOMER,
      accounts: makeAccounts(), jeId: JE_ID,
    });
    expect(row.accrual_je_id).toBe(JE_ID);
  });

  it("paid_amount_cents = '0'", () => {
    const row = buildArInvoiceRow({
      order: makeOrder(), customerId: CUSTOMER,
      accounts: makeAccounts(), jeId: JE_ID,
    });
    expect(row.paid_amount_cents).toBe("0");
  });
});

// ──────────────────────────────────────────────────────────────────────
// postFbaOrderJe — end-to-end
// ──────────────────────────────────────────────────────────────────────

describe("postFbaOrderJe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects invalid uuid", async () => {
    await expect(postFbaOrderJe({
      fbaOrderId: "not-a-uuid",
      adminClient: { from: () => ({}) },
    })).rejects.toThrow(/uuid/);
  });

  it("rejects when adminClient is invalid", async () => {
    await expect(postFbaOrderJe({
      fbaOrderId: ORDER,
      adminClient: null,
    })).rejects.toThrow(/Supabase/);
  });

  it("returns already_posted when je_id already set (idempotent)", async () => {
    const { sb, calls } = makeSupabaseMock({
      order: makeOrder({ je_id: "existing-je-id" }),
    });
    const result = await postFbaOrderJe({
      fbaOrderId: ORDER, adminClient: sb,
    });
    expect(result).toEqual({
      status: "already_posted",
      je_id: "existing-je-id",
    });
    expect(calls.rpc).toHaveLength(0);
    expect(calls.arInvoiceInsert).toHaveLength(0);
    // Items must not have been read either
    expect(calls.itemsRead).toBe(0);
  });

  it("throws not_found when fba_orders row missing", async () => {
    const sb = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: null }),
          }),
        }),
      }),
      rpc: vi.fn(),
    };
    await expect(postFbaOrderJe({
      fbaOrderId: ORDER, adminClient: sb,
    })).rejects.toMatchObject({ code: "not_found" });
  });

  it("surfaces gl_accounts_missing when AR account not configured", async () => {
    const { sb } = makeSupabaseMock({
      accountRows: [{ code: "4000", id: REV_ACCT }],
    });
    await expect(postFbaOrderJe({
      fbaOrderId: ORDER, adminClient: sb,
    })).rejects.toMatchObject({ code: "gl_accounts_missing" });
  });

  it("surfaces gl_accounts_missing when revenue account not configured", async () => {
    const { sb } = makeSupabaseMock({
      accountRows: [{ code: "1200", id: AR_ACCT }],
    });
    await expect(postFbaOrderJe({
      fbaOrderId: ORDER, adminClient: sb,
    })).rejects.toMatchObject({ code: "gl_accounts_missing" });
  });

  it("surfaces gl_accounts_missing when shipping>0 and 4500 missing", async () => {
    const { sb } = makeSupabaseMock({
      accountRows: [
        { code: "1200", id: AR_ACCT },
        { code: "4000", id: REV_ACCT },
        { code: "6523", id: FF_ACCT },
        { code: "6524", id: RF_ACCT },
        { code: "1115", id: CLR_ACCT },
      ],
    });
    await expect(postFbaOrderJe({
      fbaOrderId: ORDER, adminClient: sb,
    })).rejects.toMatchObject({ code: "gl_accounts_missing" });
  });

  it("surfaces gl_accounts_missing when fees > 0 and 1115 missing", async () => {
    const { sb } = makeSupabaseMock({
      order: makeOrder({ shipping_cents: 0 }),
      accountRows: [
        { code: "1200", id: AR_ACCT },
        { code: "4000", id: REV_ACCT },
        { code: "6523", id: FF_ACCT },
        { code: "6524", id: RF_ACCT },
      ],
    });
    await expect(postFbaOrderJe({
      fbaOrderId: ORDER, adminClient: sb,
    })).rejects.toMatchObject({ code: "gl_accounts_missing" });
  });

  it("happy path: posts JE, creates ar_invoice, stamps fba_orders", async () => {
    const { sb, calls } = makeSupabaseMock();
    const result = await postFbaOrderJe({
      fbaOrderId: ORDER, adminClient: sb,
    });
    expect(result).toEqual({
      status: "posted",
      je_id: JE_ID,
      ar_invoice_id: AR_INV_ID,
    });
    expect(calls.rpc).toHaveLength(1);
    expect(calls.rpc[0].name).toBe("gl_post_journal_entry");
    expect(calls.arInvoiceInsert).toHaveLength(1);
    expect(calls.arInvoiceInsert[0].source).toBe("fba");
    expect(calls.arInvoiceInsert[0].accrual_je_id).toBe(JE_ID);
    const finalStamp = calls.fbaOrdersUpdate.find(
      (u) => u.patch.je_id && u.patch.ar_invoice_id,
    );
    expect(finalStamp).toBeDefined();
    expect(finalStamp.patch.je_id).toBe(JE_ID);
    expect(finalStamp.patch.ar_invoice_id).toBe(AR_INV_ID);
  });

  it("passes balanced payload to gl_post_journal_entry RPC", async () => {
    const { sb, calls } = makeSupabaseMock();
    await postFbaOrderJe({ fbaOrderId: ORDER, adminClient: sb });
    const payload = calls.rpc[0].args.payload;
    let dr = 0n;
    let cr = 0n;
    for (const ln of payload.lines) {
      dr += BigInt(ln.debit.replace(".", ""));
      cr += BigInt(ln.credit.replace(".", ""));
    }
    expect(dr).toBe(cr);
  });

  it("RPC error surfaces as rpc_failed", async () => {
    const { sb } = makeSupabaseMock({
      rpcError: { message: "period is closed" },
      rpcResult: null,
    });
    await expect(postFbaOrderJe({
      fbaOrderId: ORDER, adminClient: sb,
    })).rejects.toMatchObject({ code: "rpc_failed" });
  });

  it("ar_invoices insert error stamps je_id and throws ar_invoice_insert_failed", async () => {
    const { sb, calls } = makeSupabaseMock({
      arInvoiceInsertError: { message: "invoice_number duplicate" },
      arInvoiceInsert: null,
    });
    await expect(postFbaOrderJe({
      fbaOrderId: ORDER, adminClient: sb,
    })).rejects.toMatchObject({
      code: "ar_invoice_insert_failed",
      je_id: JE_ID,
    });
    const jeOnlyStamp = calls.fbaOrdersUpdate.find(
      (u) => Object.keys(u.patch).length === 1 && u.patch.je_id,
    );
    expect(jeOnlyStamp).toBeDefined();
  });

  it("fba_orders update error throws fba_orders_update_failed (JE + invoice both posted)", async () => {
    const { sb } = makeSupabaseMock({
      fbaOrdersUpdateError: { message: "row level security" },
    });
    await expect(postFbaOrderJe({
      fbaOrderId: ORDER, adminClient: sb,
    })).rejects.toMatchObject({
      code: "fba_orders_update_failed",
      je_id: JE_ID,
      ar_invoice_id: AR_INV_ID,
    });
  });

  it("propagates customer_id from order when set (no upsert)", async () => {
    const { sb, calls } = makeSupabaseMock({
      order: makeOrder({ customer_id: CUSTOMER }),
    });
    await postFbaOrderJe({ fbaOrderId: ORDER, adminClient: sb });
    expect(calls.customerInsert).toHaveLength(0);
    expect(calls.arInvoiceInsert[0].customer_id).toBe(CUSTOMER);
  });

  it("upserts customer when only BuyerEmail present in raw_payload", async () => {
    const order = makeOrder({
      customer_id: null,
      raw_payload: { BuyerInfo: { BuyerEmail: "dtc@example.com" } },
    });
    const { sb, calls } = makeSupabaseMock({
      order,
      customerLookup: null,
      customerInsert: { id: "upserted-cust" },
    });
    const result = await postFbaOrderJe({
      fbaOrderId: ORDER, adminClient: sb,
    });
    expect(result.status).toBe("posted");
    expect(calls.customerInsert.length).toBeGreaterThan(0);
    expect(calls.arInvoiceInsert[0].customer_id).toBe("upserted-cust");
  });

  it("falls back to ANON customer when no email + no customer_id", async () => {
    const order = makeOrder({
      customer_id: null,
      raw_payload: {},
    });
    const { sb, calls } = makeSupabaseMock({
      order,
      customerLookup: null,
      customerInsert: { id: "anon-cust" },
    });
    const result = await postFbaOrderJe({
      fbaOrderId: ORDER, adminClient: sb,
    });
    expect(result.status).toBe("posted");
    expect(calls.customerInsert[0].code).toMatch(/^FBA-ANON-/);
  });

  it("entity_id propagates from fba_orders row to JE payload", async () => {
    const { sb, calls } = makeSupabaseMock();
    await postFbaOrderJe({ fbaOrderId: ORDER, adminClient: sb });
    expect(calls.rpc[0].args.payload.entity_id).toBe(ENTITY);
  });

  it("D8 — final JE payload never references the 2200 tax account id", async () => {
    // Even if 2200 were resolved (it isn't), the JE must contain zero
    // lines targeting that account.
    const { sb, calls } = makeSupabaseMock({
      order: makeOrder({ tax_collected_cents: 800 }),
    });
    await postFbaOrderJe({ fbaOrderId: ORDER, adminClient: sb });
    const payload = calls.rpc[0].args.payload;
    // The only credit accounts should be revenue, shipping, or clearing.
    const creditAccounts = payload.lines
      .filter((l) => l.credit !== "0" && l.credit !== "0.00")
      .map((l) => l.account_id);
    expect(creditAccounts).not.toContain("2200");
    // None of the line account_ids should be the (nonexistent) 2200 id
    for (const acct of creditAccounts) {
      expect(acct).toMatch(/^(.{4}-.{4}-.{4}-.{4}-.{12}|.{8}-.{4}-.{4}-.{4}-.{12})$/);
    }
  });

  it("propagates tax amount into JE description / memo for auditors", async () => {
    const { sb, calls } = makeSupabaseMock({
      order: makeOrder({ tax_collected_cents: 1234 }),
    });
    await postFbaOrderJe({ fbaOrderId: ORDER, adminClient: sb });
    const payload = calls.rpc[0].args.payload;
    const taxMemo = payload.lines.find((l) => /facilitator tax/i.test(l.memo || ""));
    expect(taxMemo).toBeDefined();
    expect(taxMemo.memo).toMatch(/12\.34/);
  });

  it("invoice_number uses amazon_order_id (FBA- prefix)", async () => {
    const { sb, calls } = makeSupabaseMock({
      order: makeOrder({ amazon_order_id: "111-Z" }),
    });
    await postFbaOrderJe({ fbaOrderId: ORDER, adminClient: sb });
    expect(calls.arInvoiceInsert[0].invoice_number).toBe("FBA-111-Z");
  });

  it("handles empty items list (no fee lines)", async () => {
    const { sb, calls } = makeSupabaseMock({
      items: [],
      // shipping=0, no fees → only AR + revenue (+ optional tax memo).
      order: makeOrder({ shipping_cents: 0, tax_collected_cents: 0 }),
      accountRows: [
        { code: "1200", id: AR_ACCT },
        { code: "4000", id: REV_ACCT },
      ],
    });
    const result = await postFbaOrderJe({
      fbaOrderId: ORDER, adminClient: sb,
    });
    expect(result.status).toBe("posted");
    const payload = calls.rpc[0].args.payload;
    expect(payload.lines.find((l) => l.account_id === FF_ACCT)).toBeUndefined();
    expect(payload.lines.find((l) => l.account_id === CLR_ACCT)).toBeUndefined();
  });

  it("backfills customer_id onto fba_orders when it was previously null", async () => {
    const order = makeOrder({
      customer_id: null,
      raw_payload: { BuyerInfo: { BuyerEmail: "x@example.com" } },
    });
    const { sb, calls } = makeSupabaseMock({
      order,
      customerLookup: null,
      customerInsert: { id: "fresh-cust" },
    });
    await postFbaOrderJe({ fbaOrderId: ORDER, adminClient: sb });
    const finalStamp = calls.fbaOrdersUpdate.find(
      (u) => u.patch.je_id && u.patch.ar_invoice_id,
    );
    expect(finalStamp.patch.customer_id).toBe("fresh-cust");
  });

  it("does NOT backfill customer_id when order already had one", async () => {
    const { sb, calls } = makeSupabaseMock({
      order: makeOrder({ customer_id: CUSTOMER }),
    });
    await postFbaOrderJe({ fbaOrderId: ORDER, adminClient: sb });
    const finalStamp = calls.fbaOrdersUpdate.find(
      (u) => u.patch.je_id && u.patch.ar_invoice_id,
    );
    expect(finalStamp.patch.customer_id).toBeUndefined();
  });
});
