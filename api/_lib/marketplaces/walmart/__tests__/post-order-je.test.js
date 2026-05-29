// Tangerine P12b-3 — tests for the Walmart AR JE posting service.
//
// Coverage:
//   - BigInt cents helpers (toBigInt / centsToDecimal)
//   - buildJournalEntryPayload: revenue, shipping, tax-as-memo,
//     per-line fees, balance, line ordering
//   - resolveGlAccounts: code map (1200/4000/4500/6523/6524/1115),
//     missing codes return null, 1201 fallback
//   - resolveCustomerId: existing customer_id, lookup by code, upsert,
//     source='walmart', race retry, missing customer key
//   - extractShippingAddress: handles missing/partial payload
//   - buildArInvoiceRow: source='walmart', invoice_number prefix,
//     AR amount = order_total − tax
//   - postWalmartOrderJe end-to-end:
//       * idempotent already_posted short-circuit
//       * not_found
//       * missing GL accounts → gl_accounts_missing (400)
//       * happy path → posted with je_id + ar_invoice_id stamped back
//       * RPC error → rpc_failed
//       * ar_invoices insert error → ar_invoice_insert_failed
//       * walmart_orders update error → walmart_orders_update_failed
//       * fees > 0 happy path
//       * zero-fee order skips 6524/6523/1115 lines
//       * customer_id auto-stamped onto walmart_orders

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  postWalmartOrderJe,
  buildJournalEntryPayload,
  buildArInvoiceRow,
  resolveCustomerId,
  resolveGlAccounts,
  extractShippingAddress,
  toBigInt,
  centsToDecimal,
} from "../post-order-je.js";

/**
 * Parse either "0" or "123.45" / "-12.34" into BigInt cents. Used by
 * the balance-check tests to tolerate either format the service emits.
 */
function parseDecimalCents(s) {
  if (s == null) return 0n;
  if (s === "0") return 0n;
  const m = String(s).match(/^(-?)(\d+)\.(\d{2})$/);
  if (!m) return 0n;
  const sign = m[1] === "-" ? -1n : 1n;
  return sign * (BigInt(m[2]) * 100n + BigInt(m[3]));
}

// ──────────────────────────────────────────────────────────────────────
// Test fixtures
// ──────────────────────────────────────────────────────────────────────

const ENTITY      = "11111111-1111-1111-1111-111111111111";
const ORDER       = "22222222-2222-2222-2222-222222222222";
const SELLER      = "33333333-3333-3333-3333-333333333333";
const CUSTOMER    = "44444444-4444-4444-4444-444444444444";
const AR_ACCT     = "55555555-5555-5555-5555-555555555555";
const REV_ACCT    = "66666666-6666-6666-6666-666666666666";
const SHIP_ACCT   = "77777777-7777-7777-7777-777777777777";
const REF_ACCT    = "88888888-8888-8888-8888-888888888888"; // 6524 Referral Fees
const FUL_ACCT    = "99999999-9999-9999-9999-999999999999"; // 6523 Fulfillment Fees
const CLEAR_ACCT  = "cccccccc-cccc-cccc-cccc-cccccccccccc"; // 1115 Marketplace clearing
const JE_ID       = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const AR_INV_ID   = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function makeOrder(overrides = {}) {
  return {
    id: ORDER,
    entity_id: ENTITY,
    walmart_seller_account_id: SELLER,
    purchase_order_id: "PO1001",
    customer_order_id: "CO9001",
    order_date: "2026-05-28T12:34:56Z",
    order_status: "Shipped",
    ship_node_type: "SellerFulfilled",
    currency: "USD",
    // $110.00 = $100 sub + $5 ship + $5 tax (no discount)
    order_total_cents: 11000,
    item_subtotal_cents: 10000,
    tax_collected_cents: 500,
    shipping_cents: 500,
    discount_cents: 0,
    customer_id: CUSTOMER,
    ar_invoice_id: null,
    je_id: null,
    raw_payload: {
      shippingInfo: {
        postalAddress: {
          name: "Jane Doe",
          address1: "1 Main St",
          city: "Springfield",
          state: "IL",
          postalCode: "62701",
          country: "US",
        },
      },
    },
    source: "walmart",
    ...overrides,
  };
}

function makeItems(overrides = []) {
  if (overrides.length > 0) return overrides;
  return [
    {
      walmart_order_id: ORDER,
      line_number: 1,
      item_sku: "SKU-A",
      product_name: "Widget A",
      quantity: 1,
      unit_price_cents: 5000,
      line_total_cents: 5000,
      tax_cents: 250,
      commission_cents: 0,
      wfs_fulfillment_fee_cents: 0,
    },
    {
      walmart_order_id: ORDER,
      line_number: 2,
      item_sku: "SKU-B",
      product_name: "Widget B",
      quantity: 1,
      unit_price_cents: 5000,
      line_total_cents: 5000,
      tax_cents: 250,
      commission_cents: 0,
      wfs_fulfillment_fee_cents: 0,
    },
  ];
}

function makeAccounts(overrides = {}) {
  return {
    arId: AR_ACCT,
    revenueId: REV_ACCT,
    shippingRevenueId: SHIP_ACCT,
    referralFeeId: REF_ACCT,
    fulfillmentFeeId: FUL_ACCT,
    clearingId: CLEAR_ACCT,
    ...overrides,
  };
}

/**
 * Flexible chainable Supabase mock. Records all calls + lets per-table
 * responses be injected.
 */
function makeSupabaseMock({
  order = makeOrder(),
  items = makeItems(),
  itemsError = null,
  accountRows = [
    { code: "1200", id: AR_ACCT },
    { code: "4000", id: REV_ACCT },
    { code: "4500", id: SHIP_ACCT },
    { code: "6524", id: REF_ACCT },
    { code: "6523", id: FUL_ACCT },
    { code: "1115", id: CLEAR_ACCT },
  ],
  customerLookup = null,
  customerInsert = { id: CUSTOMER },
  customerInsertError = null,
  rpcResult = JE_ID,
  rpcError = null,
  arInvoiceInsert = { id: AR_INV_ID },
  arInvoiceInsertError = null,
  walmartOrdersUpdateError = null,
  walmartOrdersJeOnlyUpdateError = null,
} = {}) {
  const calls = {
    rpc: [],
    arInvoiceInsert: [],
    walmartOrdersUpdate: [],
    customerInsert: [],
    customerLookup: [],
    walmartOrderItemsSelect: [],
  };

  const sb = {
    from(table) {
      if (table === "walmart_orders") {
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
                calls.walmartOrdersUpdate.push({ patch, col, val });
                if (Object.keys(patch).length === 1 && patch.je_id != null) {
                  return { error: walmartOrdersJeOnlyUpdateError };
                }
                return { error: walmartOrdersUpdateError };
              },
            };
          },
        };
      }
      if (table === "walmart_order_items") {
        return {
          select() {
            return {
              eq: async (col, val) => {
                calls.walmartOrderItemsSelect.push({ col, val });
                return { data: items, error: itemsError };
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
// toBigInt / centsToDecimal
// ──────────────────────────────────────────────────────────────────────

describe("toBigInt", () => {
  it("returns 0n for null/undefined/empty", () => {
    expect(toBigInt(null)).toBe(0n);
    expect(toBigInt(undefined)).toBe(0n);
    expect(toBigInt("")).toBe(0n);
  });
  it("passes through bigint unchanged", () => {
    expect(toBigInt(7n)).toBe(7n);
  });
  it("converts integer + string", () => {
    expect(toBigInt(11000)).toBe(11000n);
    expect(toBigInt("11000")).toBe(11000n);
  });
  it("throws on float", () => {
    expect(() => toBigInt(1.5)).toThrow(/integer/);
  });
  it("throws on garbage string", () => {
    expect(() => toBigInt("oops")).toThrow();
  });
});

describe("centsToDecimal", () => {
  it("formats whole dollars", () => {
    expect(centsToDecimal(10000n)).toBe("100.00");
  });
  it("pads cents", () => {
    expect(centsToDecimal(10005n)).toBe("100.05");
  });
  it("zero", () => {
    expect(centsToDecimal(0n)).toBe("0.00");
  });
  it("negative", () => {
    expect(centsToDecimal(-12345n)).toBe("-123.45");
  });
});

// ──────────────────────────────────────────────────────────────────────
// extractShippingAddress
// ──────────────────────────────────────────────────────────────────────

describe("extractShippingAddress", () => {
  it("returns null on missing payload", () => {
    expect(extractShippingAddress(null)).toBeNull();
    expect(extractShippingAddress({})).toBeNull();
  });
  it("reads name + address from shippingInfo.postalAddress", () => {
    const out = extractShippingAddress({
      shippingInfo: {
        postalAddress: {
          name: "John Smith",
          address1: "2 Oak Ave",
          city: "Boston",
          state: "MA",
          postalCode: "02101",
          country: "US",
        },
      },
    });
    expect(out.name).toBe("John Smith");
    expect(out.city).toBe("Boston");
    expect(out.country).toBe("US");
  });
  it("tolerates snake_case alternative payload shape", () => {
    const out = extractShippingAddress({
      shipping_info: { postal_address: { name: "X", line1: "Y", postal_code: "11111" } },
    });
    expect(out.name).toBe("X");
    expect(out.address1).toBe("Y");
    expect(out.postalCode).toBe("11111");
  });
});

// ──────────────────────────────────────────────────────────────────────
// buildJournalEntryPayload
// ──────────────────────────────────────────────────────────────────────

describe("buildJournalEntryPayload", () => {
  it("builds DR AR + CR Revenue + CR Shipping (tax memo only)", () => {
    const payload = buildJournalEntryPayload({
      order: makeOrder(),
      items: makeItems(),
      accounts: makeAccounts(),
      customerId: CUSTOMER,
    });
    // DR AR = order_total − tax = 11000 − 500 = 10500 = $105.00
    expect(payload.lines).toHaveLength(3);
    expect(payload.lines[0]).toMatchObject({
      account_id: AR_ACCT,
      debit: "105.00",
      credit: "0",
      subledger_type: "customer",
      subledger_id: CUSTOMER,
    });
    expect(payload.lines[1]).toMatchObject({
      account_id: REV_ACCT,
      debit: "0",
      credit: "100.00",
    });
    expect(payload.lines[2]).toMatchObject({
      account_id: SHIP_ACCT,
      debit: "0",
      credit: "5.00",
    });
  });

  it("emits per-line referral fee + fulfillment fee + clearing", () => {
    const items = [
      { ...makeItems()[0], commission_cents: 800, wfs_fulfillment_fee_cents: 300 },
      { ...makeItems()[1], commission_cents: 800, wfs_fulfillment_fee_cents: 300 },
    ];
    const payload = buildJournalEntryPayload({
      order: makeOrder(),
      items,
      accounts: makeAccounts(),
      customerId: CUSTOMER,
    });
    // 3 header lines + (2 fees * 2 items) + 1 clearing = 8
    expect(payload.lines).toHaveLength(8);
    const referralLines = payload.lines.filter((l) => l.account_id === REF_ACCT);
    const wfsLines = payload.lines.filter((l) => l.account_id === FUL_ACCT);
    const clearingLines = payload.lines.filter((l) => l.account_id === CLEAR_ACCT);
    expect(referralLines).toHaveLength(2);
    expect(wfsLines).toHaveLength(2);
    expect(clearingLines).toHaveLength(1);
    expect(clearingLines[0].credit).toBe("22.00"); // (800+300)*2 = 2200c
  });

  it("skips fee lines when fees == 0", () => {
    const payload = buildJournalEntryPayload({
      order: makeOrder(),
      items: makeItems(),
      accounts: makeAccounts(),
      customerId: CUSTOMER,
    });
    expect(payload.lines.find((l) => l.account_id === REF_ACCT)).toBeUndefined();
    expect(payload.lines.find((l) => l.account_id === FUL_ACCT)).toBeUndefined();
    expect(payload.lines.find((l) => l.account_id === CLEAR_ACCT)).toBeUndefined();
  });

  it("only emits referral fee line when wfs=0 on a line", () => {
    const items = [
      { ...makeItems()[0], commission_cents: 500, wfs_fulfillment_fee_cents: 0 },
    ];
    const payload = buildJournalEntryPayload({
      order: makeOrder(),
      items,
      accounts: makeAccounts(),
      customerId: CUSTOMER,
    });
    expect(payload.lines.filter((l) => l.account_id === REF_ACCT)).toHaveLength(1);
    expect(payload.lines.filter((l) => l.account_id === FUL_ACCT)).toHaveLength(0);
    expect(payload.lines.filter((l) => l.account_id === CLEAR_ACCT)).toHaveLength(1);
  });

  it("only emits wfs line when commission=0 on a line", () => {
    const items = [
      { ...makeItems()[0], commission_cents: 0, wfs_fulfillment_fee_cents: 250 },
    ];
    const payload = buildJournalEntryPayload({
      order: makeOrder(),
      items,
      accounts: makeAccounts(),
      customerId: CUSTOMER,
    });
    expect(payload.lines.filter((l) => l.account_id === REF_ACCT)).toHaveLength(0);
    expect(payload.lines.filter((l) => l.account_id === FUL_ACCT)).toHaveLength(1);
    expect(payload.lines.filter((l) => l.account_id === CLEAR_ACCT)).toHaveLength(1);
  });

  it("subtracts discount from revenue", () => {
    const order = makeOrder({
      item_subtotal_cents: 10000,
      discount_cents: 2000,
      shipping_cents: 0,
      tax_collected_cents: 0,
      order_total_cents: 8000,
    });
    const payload = buildJournalEntryPayload({
      order, items: [], accounts: makeAccounts(), customerId: CUSTOMER,
    });
    const rev = payload.lines.find((l) => l.account_id === REV_ACCT);
    expect(rev.credit).toBe("80.00");
  });

  it("throws when discount exceeds subtotal", () => {
    const order = makeOrder({
      item_subtotal_cents: 1000,
      discount_cents: 2000,
      shipping_cents: 0,
      tax_collected_cents: 0,
      order_total_cents: -1000,
    });
    expect(() => buildJournalEntryPayload({
      order, items: [], accounts: makeAccounts(), customerId: CUSTOMER,
    })).toThrow(/negative/);
  });

  it("balances every JE (sum debits == sum credits)", () => {
    const items = [
      { ...makeItems()[0], commission_cents: 800, wfs_fulfillment_fee_cents: 300 },
      { ...makeItems()[1], commission_cents: 500, wfs_fulfillment_fee_cents: 0 },
    ];
    const payload = buildJournalEntryPayload({
      order: makeOrder(),
      items,
      accounts: makeAccounts(),
      customerId: CUSTOMER,
    });
    let dr = 0n, cr = 0n;
    for (const ln of payload.lines) {
      dr += parseDecimalCents(ln.debit);
      cr += parseDecimalCents(ln.credit);
    }
    expect(dr).toBe(cr);
  });

  it("throws when shipping>0 but no 4500 account", () => {
    expect(() => buildJournalEntryPayload({
      order: makeOrder(),
      items: makeItems(),
      accounts: makeAccounts({ shippingRevenueId: null }),
      customerId: CUSTOMER,
    })).toThrow(/4500/);
  });

  it("throws when commission>0 but no 6524", () => {
    const items = [{ ...makeItems()[0], commission_cents: 500 }];
    expect(() => buildJournalEntryPayload({
      order: makeOrder(),
      items,
      accounts: makeAccounts({ referralFeeId: null }),
      customerId: CUSTOMER,
    })).toThrow(/6524/);
  });

  it("throws when wfs fee>0 but no 6523", () => {
    const items = [{ ...makeItems()[0], wfs_fulfillment_fee_cents: 500 }];
    expect(() => buildJournalEntryPayload({
      order: makeOrder(),
      items,
      accounts: makeAccounts({ fulfillmentFeeId: null }),
      customerId: CUSTOMER,
    })).toThrow(/6523/);
  });

  it("throws when fees>0 but no 1115 clearing", () => {
    const items = [{ ...makeItems()[0], commission_cents: 500 }];
    expect(() => buildJournalEntryPayload({
      order: makeOrder(),
      items,
      accounts: makeAccounts({ clearingId: null }),
      customerId: CUSTOMER,
    })).toThrow(/1115/);
  });

  it("sets source_module='walmart' and source_table='walmart_orders'", () => {
    const payload = buildJournalEntryPayload({
      order: makeOrder(), items: [], accounts: makeAccounts(), customerId: CUSTOMER,
    });
    expect(payload.source_module).toBe("walmart");
    expect(payload.source_table).toBe("walmart_orders");
    expect(payload.source_id).toBe(ORDER);
  });

  it("journal_type='ar_invoice' and basis='ACCRUAL'", () => {
    const payload = buildJournalEntryPayload({
      order: makeOrder(), items: [], accounts: makeAccounts(), customerId: CUSTOMER,
    });
    expect(payload.journal_type).toBe("ar_invoice");
    expect(payload.basis).toBe("ACCRUAL");
  });

  it("description encodes facilitator tax memo per D8", () => {
    const payload = buildJournalEntryPayload({
      order: makeOrder({ tax_collected_cents: 500 }),
      items: [],
      accounts: makeAccounts(),
      customerId: CUSTOMER,
    });
    expect(payload.description).toMatch(/facilitator tax memo \$5\.00/);
    expect(payload.description).toMatch(/D8/);
  });

  it("description omits tax memo when tax=0", () => {
    const order = makeOrder({
      tax_collected_cents: 0,
      order_total_cents: 10500,
    });
    const payload = buildJournalEntryPayload({
      order, items: [], accounts: makeAccounts(), customerId: CUSTOMER,
    });
    expect(payload.description).not.toMatch(/facilitator tax/);
  });

  it("does NOT credit 2200 Sales Tax Payable (memo only per D8)", () => {
    const payload = buildJournalEntryPayload({
      // order_total = item_subtotal + tax + shipping - discount = 10000 + 1000 + 500 = 11500
      order: makeOrder({ tax_collected_cents: 1000, order_total_cents: 11500 }),
      items: [],
      accounts: makeAccounts(),
      customerId: CUSTOMER,
    });
    for (const ln of payload.lines) {
      expect(ln.memo || "").not.toMatch(/sales tax payable/i);
    }
  });

  it("derives posting_date from order_date", () => {
    const payload = buildJournalEntryPayload({
      order: makeOrder({ order_date: "2026-05-28T23:59:00Z" }),
      items: [],
      accounts: makeAccounts(),
      customerId: CUSTOMER,
    });
    expect(payload.posting_date).toBe("2026-05-28");
  });

  it("derives AR amount from components when order_total_cents missing", () => {
    const order = makeOrder({
      order_total_cents: 0,
      item_subtotal_cents: 10000,
      discount_cents: 1000,
      shipping_cents: 500,
      tax_collected_cents: 500,
    });
    const payload = buildJournalEntryPayload({
      order, items: [], accounts: makeAccounts(), customerId: CUSTOMER,
    });
    expect(payload.lines[0].debit).toBe("95.00"); // (10000 - 1000 + 500) / 100
  });

  it("throws on negative line fees", () => {
    const items = [{ ...makeItems()[0], commission_cents: -100 }];
    expect(() => buildJournalEntryPayload({
      order: makeOrder(), items, accounts: makeAccounts(), customerId: CUSTOMER,
    })).toThrow(/negative/);
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
                { code: "6524", id: REF_ACCT },
                { code: "6523", id: FUL_ACCT },
                { code: "1115", id: CLEAR_ACCT },
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
      referralFeeId: REF_ACCT,
      fulfillmentFeeId: FUL_ACCT,
      clearingId: CLEAR_ACCT,
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

  it("returns nulls when codes missing", async () => {
    const sb = {
      from: () => ({
        select: () => ({
          eq: () => ({
            in: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
      }),
    };
    const out = await resolveGlAccounts(sb, ENTITY);
    expect(out.arId).toBeNull();
    expect(out.revenueId).toBeNull();
    expect(out.referralFeeId).toBeNull();
    expect(out.fulfillmentFeeId).toBeNull();
    expect(out.clearingId).toBeNull();
  });

  it("surfaces query errors", async () => {
    const sb = {
      from: () => ({
        select: () => ({
          eq: () => ({
            in: () => Promise.resolve({ data: null, error: { message: "boom" } }),
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

  it("looks up by code first when no customer_id", async () => {
    const order = makeOrder({ customer_id: null });
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

  it("inserts a new customer with code, name from shippingInfo, source='walmart'", async () => {
    const order = makeOrder({ customer_id: null });
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
      code: "WALMART-CO9001",
      name: "Jane Doe",
      customer_type: "ecom",
      status: "active",
      source: "walmart",
    });
  });

  it("falls back to purchase_order_id when customer_order_id missing", async () => {
    const order = makeOrder({
      customer_id: null,
      customer_order_id: null,
      purchase_order_id: "PO1234",
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
              single: async () => ({ data: { id: "z" }, error: null }),
            }),
          };
        },
      }),
    };
    await resolveCustomerId(sb, order);
    expect(inserts[0].code).toBe("WALMART-PO1234");
  });

  it("uses a synthetic name when shippingInfo missing", async () => {
    const order = makeOrder({
      customer_id: null,
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
              single: async () => ({ data: { id: "z" }, error: null }),
            }),
          };
        },
      }),
    };
    await resolveCustomerId(sb, order);
    expect(inserts[0].name).toMatch(/Walmart Buyer/);
  });

  it("retries insert without source if column rejected", async () => {
    const order = makeOrder({ customer_id: null });
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
    expect(inserts).toHaveLength(2);
    expect(inserts[0]).toHaveProperty("source");
    expect(inserts[1]).not.toHaveProperty("source");
  });

  it("returns race winner on duplicate-key insert race", async () => {
    const order = makeOrder({ customer_id: null });
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
            single: async () => ({ data: null, error: { message: "duplicate key" } }),
          }),
        }),
      }),
    };
    const id = await resolveCustomerId(sb, order);
    expect(id).toBe("race-winner");
  });

  it("throws when no customer_id, no customer_order_id, no purchase_order_id", async () => {
    const order = makeOrder({
      customer_id: null,
      customer_order_id: null,
      purchase_order_id: null,
    });
    const sb = { from: vi.fn() };
    await expect(resolveCustomerId(sb, order)).rejects.toThrow(/customer_order_id/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// buildArInvoiceRow
// ──────────────────────────────────────────────────────────────────────

describe("buildArInvoiceRow", () => {
  it("stamps source='walmart'", () => {
    const row = buildArInvoiceRow({
      order: makeOrder(),
      customerId: CUSTOMER,
      accounts: makeAccounts(),
      jeId: JE_ID,
    });
    expect(row.source).toBe("walmart");
  });

  it("uses WALMART- prefix on invoice_number", () => {
    const row = buildArInvoiceRow({
      order: makeOrder({ purchase_order_id: "PO9999" }),
      customerId: CUSTOMER,
      accounts: makeAccounts(),
      jeId: JE_ID,
    });
    expect(row.invoice_number).toBe("WALMART-PO9999");
  });

  it("sets gl_status='sent'", () => {
    const row = buildArInvoiceRow({
      order: makeOrder(), customerId: CUSTOMER,
      accounts: makeAccounts(), jeId: JE_ID,
    });
    expect(row.gl_status).toBe("sent");
  });

  it("links accrual_je_id", () => {
    const row = buildArInvoiceRow({
      order: makeOrder(), customerId: CUSTOMER,
      accounts: makeAccounts(), jeId: JE_ID,
    });
    expect(row.accrual_je_id).toBe(JE_ID);
  });

  it("total_amount_cents = order_total − tax (memo per D8)", () => {
    const row = buildArInvoiceRow({
      order: makeOrder({ order_total_cents: 11000, tax_collected_cents: 500 }),
      customerId: CUSTOMER,
      accounts: makeAccounts(),
      jeId: JE_ID,
    });
    expect(row.total_amount_cents).toBe("10500");
  });

  it("sets paid_amount_cents='0'", () => {
    const row = buildArInvoiceRow({
      order: makeOrder(), customerId: CUSTOMER,
      accounts: makeAccounts(), jeId: JE_ID,
    });
    expect(row.paid_amount_cents).toBe("0");
  });
});

// ──────────────────────────────────────────────────────────────────────
// postWalmartOrderJe — end-to-end
// ──────────────────────────────────────────────────────────────────────

describe("postWalmartOrderJe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects an invalid uuid", async () => {
    await expect(postWalmartOrderJe({
      walmartOrderId: "not-a-uuid",
      adminClient: { from: () => ({}) },
    })).rejects.toThrow(/uuid/);
  });

  it("rejects null adminClient", async () => {
    await expect(postWalmartOrderJe({
      walmartOrderId: ORDER,
      adminClient: null,
    })).rejects.toThrow(/Supabase/);
  });

  it("returns already_posted when je_id already set", async () => {
    const { sb, calls } = makeSupabaseMock({
      order: makeOrder({ je_id: "existing-je-id" }),
    });
    const result = await postWalmartOrderJe({
      walmartOrderId: ORDER, adminClient: sb,
    });
    expect(result).toEqual({ status: "already_posted", je_id: "existing-je-id" });
    expect(calls.rpc).toHaveLength(0);
    expect(calls.arInvoiceInsert).toHaveLength(0);
  });

  it("throws not_found when row missing", async () => {
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
    await expect(postWalmartOrderJe({
      walmartOrderId: ORDER, adminClient: sb,
    })).rejects.toMatchObject({ code: "not_found" });
  });

  it("happy path: posts JE, creates ar_invoice, stamps walmart_orders", async () => {
    const { sb, calls } = makeSupabaseMock();
    const result = await postWalmartOrderJe({
      walmartOrderId: ORDER, adminClient: sb,
    });
    expect(result).toEqual({
      status: "posted",
      je_id: JE_ID,
      ar_invoice_id: AR_INV_ID,
    });
    expect(calls.rpc).toHaveLength(1);
    expect(calls.rpc[0].name).toBe("gl_post_journal_entry");
    expect(calls.arInvoiceInsert).toHaveLength(1);
    expect(calls.arInvoiceInsert[0].source).toBe("walmart");
    const finalStamp = calls.walmartOrdersUpdate.find(
      (u) => u.patch.je_id && u.patch.ar_invoice_id,
    );
    expect(finalStamp).toBeDefined();
    expect(finalStamp.patch.je_id).toBe(JE_ID);
    expect(finalStamp.patch.ar_invoice_id).toBe(AR_INV_ID);
    expect(finalStamp.patch.source).toBe("walmart");
    expect(finalStamp.patch.customer_id).toBe(CUSTOMER);
  });

  it("posts balanced JE payload to gl_post_journal_entry", async () => {
    const { sb, calls } = makeSupabaseMock();
    await postWalmartOrderJe({ walmartOrderId: ORDER, adminClient: sb });
    const payload = calls.rpc[0].args.payload;
    let dr = 0n, cr = 0n;
    for (const ln of payload.lines) {
      dr += parseDecimalCents(ln.debit);
      cr += parseDecimalCents(ln.credit);
    }
    expect(dr).toBe(cr);
  });

  it("posts a fees-bearing order with per-line referral + wfs + 1115", async () => {
    const items = [
      { ...makeItems()[0], commission_cents: 800, wfs_fulfillment_fee_cents: 300 },
      { ...makeItems()[1], commission_cents: 800, wfs_fulfillment_fee_cents: 300 },
    ];
    const { sb, calls } = makeSupabaseMock({ items });
    const result = await postWalmartOrderJe({
      walmartOrderId: ORDER, adminClient: sb,
    });
    expect(result.status).toBe("posted");
    const payload = calls.rpc[0].args.payload;
    expect(payload.lines.length).toBeGreaterThanOrEqual(8);
  });

  it("zero-fee order has just header lines", async () => {
    const { sb, calls } = makeSupabaseMock();
    await postWalmartOrderJe({ walmartOrderId: ORDER, adminClient: sb });
    const payload = calls.rpc[0].args.payload;
    expect(payload.lines).toHaveLength(3);
  });

  it("surfaces gl_accounts_missing when AR account not configured", async () => {
    const { sb } = makeSupabaseMock({
      accountRows: [{ code: "4000", id: REV_ACCT }],
    });
    await expect(postWalmartOrderJe({
      walmartOrderId: ORDER, adminClient: sb,
    })).rejects.toMatchObject({ code: "gl_accounts_missing" });
  });

  it("surfaces gl_accounts_missing when revenue account not configured", async () => {
    const { sb } = makeSupabaseMock({
      accountRows: [{ code: "1200", id: AR_ACCT }],
    });
    await expect(postWalmartOrderJe({
      walmartOrderId: ORDER, adminClient: sb,
    })).rejects.toMatchObject({ code: "gl_accounts_missing" });
  });

  it("surfaces gl_accounts_missing when shipping>0 but no 4500", async () => {
    const { sb } = makeSupabaseMock({
      accountRows: [
        { code: "1200", id: AR_ACCT },
        { code: "4000", id: REV_ACCT },
      ],
    });
    await expect(postWalmartOrderJe({
      walmartOrderId: ORDER, adminClient: sb,
    })).rejects.toMatchObject({ code: "gl_accounts_missing" });
  });

  it("surfaces gl_accounts_missing when fees>0 but no 6524/6523/1115", async () => {
    const items = [
      { ...makeItems()[0], commission_cents: 500 },
    ];
    const { sb } = makeSupabaseMock({
      items,
      accountRows: [
        { code: "1200", id: AR_ACCT },
        { code: "4000", id: REV_ACCT },
        { code: "4500", id: SHIP_ACCT },
      ],
    });
    await expect(postWalmartOrderJe({
      walmartOrderId: ORDER, adminClient: sb,
    })).rejects.toMatchObject({ code: "gl_accounts_missing" });
  });

  it("RPC error surfaces as rpc_failed", async () => {
    const { sb } = makeSupabaseMock({
      rpcError: { message: "period is closed" }, rpcResult: null,
    });
    await expect(postWalmartOrderJe({
      walmartOrderId: ORDER, adminClient: sb,
    })).rejects.toMatchObject({ code: "rpc_failed" });
  });

  it("ar_invoices insert error stamps je_id and throws ar_invoice_insert_failed", async () => {
    const { sb, calls } = makeSupabaseMock({
      arInvoiceInsertError: { message: "invoice_number duplicate" },
      arInvoiceInsert: null,
    });
    await expect(postWalmartOrderJe({
      walmartOrderId: ORDER, adminClient: sb,
    })).rejects.toMatchObject({ code: "ar_invoice_insert_failed", je_id: JE_ID });
    const jeOnlyStamp = calls.walmartOrdersUpdate.find(
      (u) => Object.keys(u.patch).length === 1 && u.patch.je_id,
    );
    expect(jeOnlyStamp).toBeDefined();
  });

  it("walmart_orders update error throws walmart_orders_update_failed", async () => {
    const { sb } = makeSupabaseMock({
      walmartOrdersUpdateError: { message: "row level security" },
    });
    await expect(postWalmartOrderJe({
      walmartOrderId: ORDER, adminClient: sb,
    })).rejects.toMatchObject({
      code: "walmart_orders_update_failed",
      je_id: JE_ID,
      ar_invoice_id: AR_INV_ID,
    });
  });

  it("propagates customer_id from order when set (no upsert)", async () => {
    const { sb, calls } = makeSupabaseMock({
      order: makeOrder({ customer_id: CUSTOMER }),
    });
    await postWalmartOrderJe({ walmartOrderId: ORDER, adminClient: sb });
    expect(calls.customerInsert).toHaveLength(0);
    expect(calls.arInvoiceInsert[0].customer_id).toBe(CUSTOMER);
  });

  it("upserts customer from raw_payload.shippingInfo when no customer_id", async () => {
    const order = makeOrder({ customer_id: null });
    const { sb, calls } = makeSupabaseMock({
      order,
      customerLookup: null,
      customerInsert: { id: "upserted-walmart-cust" },
    });
    const result = await postWalmartOrderJe({
      walmartOrderId: ORDER, adminClient: sb,
    });
    expect(result.status).toBe("posted");
    expect(calls.customerInsert.length).toBeGreaterThan(0);
    expect(calls.arInvoiceInsert[0].customer_id).toBe("upserted-walmart-cust");
  });

  it("throws customer_resolution_failed when missing every key", async () => {
    const { sb } = makeSupabaseMock({
      order: makeOrder({
        customer_id: null,
        customer_order_id: null,
        purchase_order_id: null,
      }),
    });
    await expect(postWalmartOrderJe({
      walmartOrderId: ORDER, adminClient: sb,
    })).rejects.toMatchObject({ code: "customer_resolution_failed" });
  });

  it("entity_id propagates from walmart_orders row to JE payload", async () => {
    const { sb, calls } = makeSupabaseMock();
    await postWalmartOrderJe({ walmartOrderId: ORDER, adminClient: sb });
    expect(calls.rpc[0].args.payload.entity_id).toBe(ENTITY);
  });

  it("invoice_number uses customer_order_id when purchase_order_id absent", async () => {
    const order = makeOrder({
      purchase_order_id: null,
      customer_order_id: "CO123",
    });
    const { sb, calls } = makeSupabaseMock({ order });
    await postWalmartOrderJe({ walmartOrderId: ORDER, adminClient: sb });
    expect(calls.arInvoiceInsert[0].invoice_number).toBe("WALMART-CO123");
  });

  it("walmart_order_items lookup is filtered by walmart_order_id", async () => {
    const { sb, calls } = makeSupabaseMock();
    await postWalmartOrderJe({ walmartOrderId: ORDER, adminClient: sb });
    expect(calls.walmartOrderItemsSelect).toHaveLength(1);
    expect(calls.walmartOrderItemsSelect[0]).toMatchObject({
      col: "walmart_order_id",
      val: ORDER,
    });
  });

  it("does NOT credit 2200 Sales Tax Payable", async () => {
    const { sb, calls } = makeSupabaseMock({
      // tax_collected=1500 → order_total must be 10000+1500+500 = 12000
      order: makeOrder({ tax_collected_cents: 1500, order_total_cents: 12000 }),
    });
    await postWalmartOrderJe({ walmartOrderId: ORDER, adminClient: sb });
    const payload = calls.rpc[0].args.payload;
    // No line memo should mention 2200/sales tax payable
    for (const ln of payload.lines) {
      expect(ln.memo || "").not.toMatch(/sales tax payable/i);
    }
  });
});
