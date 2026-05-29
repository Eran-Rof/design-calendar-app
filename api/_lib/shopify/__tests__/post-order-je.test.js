// Tangerine P11-3 — tests for the Shopify AR JE posting service.
//
// Coverage:
//   - BigInt cents helpers (toBigInt / centsToDecimal)
//   - buildJournalEntryPayload: revenue math, tax, fee, balance, line ordering
//   - resolveGlAccounts: code map, missing codes return null, 1200/1201 fallback
//   - resolveCustomerId: existing customer_id, lookup by code, upsert path,
//     source='shopify' tag, race retry, missing email
//   - buildArInvoiceRow: source='shopify', invoice_number prefix, JE link
//   - postShopifyOrderJe end-to-end:
//       * idempotent already_posted short-circuit
//       * not_found
//       * missing GL accounts → gl_accounts_missing (400)
//       * happy path → posted with je_id + ar_invoice_id stamped back
//       * RPC error → rpc_failed
//       * ar_invoices insert error → ar_invoice_insert_failed (with je_id stamped)
//       * shopify_orders update error → shopify_orders_update_failed
//   - Edge cases: zero tax, zero revenue, fee included from order webhook,
//     negative revenue (subtotal < discount) throws,
//     unbalanced manual payload throws.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  postShopifyOrderJe,
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

const ENTITY      = "11111111-1111-1111-1111-111111111111";
const ORDER       = "22222222-2222-2222-2222-222222222222";
const STORE       = "33333333-3333-3333-3333-333333333333";
const CUSTOMER    = "44444444-4444-4444-4444-444444444444";
const AR_ACCT     = "55555555-5555-5555-5555-555555555555";
const REV_ACCT    = "66666666-6666-6666-6666-666666666666";
const TAX_ACCT    = "77777777-7777-7777-7777-777777777777";
const FEE_ACCT    = "88888888-8888-8888-8888-888888888888";
const CLEAR_ACCT  = "99999999-9999-9999-9999-999999999999";
const JE_ID       = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const AR_INV_ID   = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function makeOrder(overrides = {}) {
  return {
    id: ORDER,
    entity_id: ENTITY,
    shopify_store_id: STORE,
    shopify_order_id: "9001",
    order_number: "#1001",
    financial_status: "paid",
    processed_at: "2026-05-28T12:34:56Z",
    currency: "USD",
    total_amount_cents: 11000,    // $110 = $100 sub + $10 tax
    subtotal_amount_cents: 10000, // $100
    tax_amount_cents: 1000,       // $10
    shipping_amount_cents: 0,
    discount_amount_cents: 0,
    fee_amount_cents: 0,          // Shopify order webhook = no fee
    payment_gateway: "shopify_payments",
    customer_id: CUSTOMER,
    customer_email: "buyer@example.com",
    ar_invoice_id: null,
    je_id: null,
    ...overrides,
  };
}

function makeAccounts(overrides = {}) {
  return {
    arId: AR_ACCT,
    revenueId: REV_ACCT,
    taxId: TAX_ACCT,
    feeId: FEE_ACCT,
    clearingId: CLEAR_ACCT,
    cogsId: null,
    ...overrides,
  };
}

/**
 * Build a flexible chainable Supabase mock that records all calls and
 * lets a test inject specific responses per table+method via the `responses`
 * map.
 */
function makeSupabaseMock({
  order = makeOrder(),
  accountRows = [
    { code: "1200", id: AR_ACCT },
    { code: "4000", id: REV_ACCT },
    { code: "2200", id: TAX_ACCT },
    { code: "6510", id: FEE_ACCT },
    { code: "1110", id: CLEAR_ACCT },
  ],
  customerLookup = null,         // {data:{id}} or null when not found
  customerInsert = { id: CUSTOMER },
  customerInsertError = null,
  rpcResult = JE_ID,
  rpcError = null,
  arInvoiceInsert = { id: AR_INV_ID },
  arInvoiceInsertError = null,
  shopifyOrdersUpdateError = null,
  shopifyOrdersJeOnlyUpdateError = null,
} = {}) {
  const calls = {
    rpc: [],
    arInvoiceInsert: [],
    shopifyOrdersUpdate: [],
    customerInsert: [],
    customerLookup: [],
  };

  function chain(rows, error = null) {
    const obj = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: rows?.[0] ?? null, error }),
      single: vi.fn().mockResolvedValue({ data: rows?.[0] ?? null, error }),
      then: undefined,
    };
    // make it await-able as array-ish result
    obj.then = (resolve) => resolve({ data: rows, error });
    return obj;
  }

  const sb = {
    from(table) {
      if (table === "shopify_orders") {
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
                calls.shopifyOrdersUpdate.push({ patch, col, val });
                // Differentiate between the "je_id only" emergency stamp
                // (from ar_invoices insert failure) and the final stamp.
                if (Object.keys(patch).length === 1 && patch.je_id != null) {
                  return { error: shopifyOrdersJeOnlyUpdateError };
                }
                return { error: shopifyOrdersUpdateError };
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
  it("returns 0n for null/undefined/empty", () => {
    expect(toBigInt(null)).toBe(0n);
    expect(toBigInt(undefined)).toBe(0n);
    expect(toBigInt("")).toBe(0n);
  });
  it("passes through bigint unchanged", () => {
    expect(toBigInt(123n)).toBe(123n);
  });
  it("converts safe integer", () => {
    expect(toBigInt(11000)).toBe(11000n);
  });
  it("converts integer string", () => {
    expect(toBigInt("11000")).toBe(11000n);
  });
  it("converts negative string", () => {
    expect(toBigInt("-500")).toBe(-500n);
  });
  it("throws on float", () => {
    expect(() => toBigInt(1.5)).toThrow(/integer/);
  });
  it("throws on non-integer string", () => {
    expect(() => toBigInt("12.34")).toThrow(/integer-cents/);
  });
  it("throws on unsupported type", () => {
    expect(() => toBigInt({})).toThrow();
    expect(() => toBigInt(true)).toThrow();
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
  it("handles negative cents", () => {
    expect(centsToDecimal(-12345n)).toBe("-123.45");
  });
  it("accepts number input", () => {
    expect(centsToDecimal(11000)).toBe("110.00");
  });
});

// ──────────────────────────────────────────────────────────────────────
// buildJournalEntryPayload
// ──────────────────────────────────────────────────────────────────────

describe("buildJournalEntryPayload", () => {
  it("builds a balanced 3-line JE for AR + revenue + tax (no fee)", () => {
    const order = makeOrder(); // total=110, sub=100, tax=10, no discount
    const payload = buildJournalEntryPayload({
      order,
      accounts: makeAccounts(),
      customerId: CUSTOMER,
    });
    expect(payload.lines).toHaveLength(3);
    // DR AR
    expect(payload.lines[0]).toMatchObject({
      line_number: 1,
      account_id: AR_ACCT,
      debit: "110.00",
      credit: "0",
      subledger_type: "customer",
      subledger_id: CUSTOMER,
    });
    // CR Revenue
    expect(payload.lines[1]).toMatchObject({
      line_number: 2,
      account_id: REV_ACCT,
      debit: "0",
      credit: "100.00",
    });
    // CR Tax
    expect(payload.lines[2]).toMatchObject({
      line_number: 3,
      account_id: TAX_ACCT,
      debit: "0",
      credit: "10.00",
    });
  });

  it("omits revenue line when subtotal-discount = 0", () => {
    const order = makeOrder({
      total_amount_cents: 0,
      subtotal_amount_cents: 0,
      tax_amount_cents: 0,
    });
    const payload = buildJournalEntryPayload({
      order, accounts: makeAccounts(), customerId: CUSTOMER,
    });
    // Only DR AR for $0 — but DR AR is always emitted
    expect(payload.lines).toHaveLength(1);
    expect(payload.lines[0].debit).toBe("0.00");
  });

  it("omits tax line when tax=0", () => {
    const order = makeOrder({
      total_amount_cents: 10000,
      subtotal_amount_cents: 10000,
      tax_amount_cents: 0,
    });
    const payload = buildJournalEntryPayload({
      order, accounts: makeAccounts(), customerId: CUSTOMER,
    });
    expect(payload.lines).toHaveLength(2);
    expect(payload.lines[0].account_id).toBe(AR_ACCT);
    expect(payload.lines[1].account_id).toBe(REV_ACCT);
  });

  it("subtracts discount from revenue", () => {
    const order = makeOrder({
      total_amount_cents: 9000,       // $90 = $100 sub - $20 disc + $10 tax
      subtotal_amount_cents: 10000,
      discount_amount_cents: 2000,
      tax_amount_cents: 1000,
    });
    const payload = buildJournalEntryPayload({
      order, accounts: makeAccounts(), customerId: CUSTOMER,
    });
    // Revenue line should be 100 - 20 = 80
    const rev = payload.lines.find((l) => l.account_id === REV_ACCT);
    expect(rev.credit).toBe("80.00");
  });

  it("emits 5 lines when fee > 0 (DR Fee + CR Clearing)", () => {
    const order = makeOrder({
      total_amount_cents: 11000,
      subtotal_amount_cents: 10000,
      tax_amount_cents: 1000,
      fee_amount_cents: 350,
    });
    const payload = buildJournalEntryPayload({
      order, accounts: makeAccounts(), customerId: CUSTOMER,
    });
    expect(payload.lines).toHaveLength(5);
    const fee = payload.lines.find((l) => l.account_id === FEE_ACCT);
    const clearing = payload.lines.find((l) => l.account_id === CLEAR_ACCT);
    expect(fee.debit).toBe("3.50");
    expect(clearing.credit).toBe("3.50");
  });

  it("throws when discount exceeds subtotal (negative revenue)", () => {
    const order = makeOrder({
      subtotal_amount_cents: 1000,
      discount_amount_cents: 2000,
    });
    expect(() => buildJournalEntryPayload({
      order, accounts: makeAccounts(), customerId: CUSTOMER,
    })).toThrow(/negative/);
  });

  it("throws on unbalanced math (manual corruption)", () => {
    const order = makeOrder({
      total_amount_cents: 100,       // wrong total
      subtotal_amount_cents: 10000,
      tax_amount_cents: 1000,
    });
    expect(() => buildJournalEntryPayload({
      order, accounts: makeAccounts(), customerId: CUSTOMER,
    })).toThrow(/unbalanced/);
  });

  it("throws when tax>0 but no tax account", () => {
    const order = makeOrder();
    const accts = makeAccounts({ taxId: null });
    expect(() => buildJournalEntryPayload({
      order, accounts: accts, customerId: CUSTOMER,
    })).toThrow(/2200/);
  });

  it("throws when fee>0 but no fee/clearing account", () => {
    const order = makeOrder({
      total_amount_cents: 11000,
      subtotal_amount_cents: 10000,
      tax_amount_cents: 1000,
      fee_amount_cents: 350,
    });
    const accts = makeAccounts({ feeId: null });
    expect(() => buildJournalEntryPayload({
      order, accounts: accts, customerId: CUSTOMER,
    })).toThrow(/6510/);
  });

  it("sets source_module='shopify' and source_id=order.id", () => {
    const payload = buildJournalEntryPayload({
      order: makeOrder(), accounts: makeAccounts(), customerId: CUSTOMER,
    });
    expect(payload.source_module).toBe("shopify");
    expect(payload.source_table).toBe("shopify_orders");
    expect(payload.source_id).toBe(ORDER);
  });

  it("sets journal_type='ar_invoice' and basis='ACCRUAL'", () => {
    const payload = buildJournalEntryPayload({
      order: makeOrder(), accounts: makeAccounts(), customerId: CUSTOMER,
    });
    expect(payload.basis).toBe("ACCRUAL");
    expect(payload.journal_type).toBe("ar_invoice");
  });

  it("derives posting_date from processed_at (date-only)", () => {
    const order = makeOrder({ processed_at: "2026-05-28T23:59:00Z" });
    const payload = buildJournalEntryPayload({
      order, accounts: makeAccounts(), customerId: CUSTOMER,
    });
    expect(payload.posting_date).toBe("2026-05-28");
  });

  it("uses centsToDecimal for all amount strings (no float drift)", () => {
    const order = makeOrder({
      total_amount_cents: 13337,
      subtotal_amount_cents: 12337,
      tax_amount_cents: 1000,
    });
    const payload = buildJournalEntryPayload({
      order, accounts: makeAccounts(), customerId: CUSTOMER,
    });
    expect(payload.lines[0].debit).toBe("133.37");
    expect(payload.lines[1].credit).toBe("123.37");
    expect(payload.lines[2].credit).toBe("10.00");
  });

  it("description encodes the order_number", () => {
    const payload = buildJournalEntryPayload({
      order: makeOrder({ order_number: "#42" }),
      accounts: makeAccounts(),
      customerId: CUSTOMER,
    });
    expect(payload.description).toContain("#42");
  });

  it("falls back to shopify_order_id when order_number missing", () => {
    const payload = buildJournalEntryPayload({
      order: makeOrder({ order_number: null, shopify_order_id: "G123" }),
      accounts: makeAccounts(),
      customerId: CUSTOMER,
    });
    expect(payload.description).toContain("G123");
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
                { code: "2200", id: TAX_ACCT },
                { code: "6510", id: FEE_ACCT },
                { code: "1110", id: CLEAR_ACCT },
                { code: "5000", id: "cogs-id" },
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
      taxId: TAX_ACCT,
      feeId: FEE_ACCT,
      clearingId: CLEAR_ACCT,
      cogsId: "cogs-id",
    });
  });

  it("returns null for missing codes", async () => {
    const sb = {
      from: () => ({
        select: () => ({
          eq: () => ({
            in: () => Promise.resolve({
              data: [{ code: "1200", id: AR_ACCT }],
              error: null,
            }),
          }),
        }),
      }),
    };
    const out = await resolveGlAccounts(sb, ENTITY);
    expect(out.arId).toBe(AR_ACCT);
    expect(out.revenueId).toBeNull();
    expect(out.taxId).toBeNull();
    expect(out.feeId).toBeNull();
    expect(out.clearingId).toBeNull();
    expect(out.cogsId).toBeNull();
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

  it("throws when no customer_id and no email", async () => {
    const order = makeOrder({ customer_id: null, customer_email: null });
    const sb = { from: vi.fn() };
    await expect(resolveCustomerId(sb, order)).rejects.toThrow(/customer_email/);
  });

  it("returns existing customer found by code", async () => {
    const order = makeOrder({ customer_id: null, customer_email: "BUYER@example.com" });
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

  it("inserts a new customer with code, name, source='shopify'", async () => {
    const order = makeOrder({ customer_id: null, customer_email: "new@example.com" });
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
      code: "SHOPIFY-new@example.com",
      name: "new",
      customer_type: "ecom",
      status: "active",
      source: "shopify",
    });
  });

  it("retries insert without source if column rejected", async () => {
    const order = makeOrder({ customer_id: null, customer_email: "x@example.com" });
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

  it("returns race-winner row on conflict during insert", async () => {
    const order = makeOrder({ customer_id: null, customer_email: "race@example.com" });
    let lookupCount = 0;
    const sb = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => {
                lookupCount++;
                // First lookup → not found; retry lookup → found (race winner).
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
  it("stamps source='shopify'", () => {
    const row = buildArInvoiceRow({
      order: makeOrder(),
      customerId: CUSTOMER,
      accounts: makeAccounts(),
      jeId: JE_ID,
    });
    expect(row.source).toBe("shopify");
  });

  it("uses SHOPIFY- prefix in invoice_number", () => {
    const row = buildArInvoiceRow({
      order: makeOrder({ order_number: "#1001" }),
      customerId: CUSTOMER,
      accounts: makeAccounts(),
      jeId: JE_ID,
    });
    expect(row.invoice_number).toBe("SHOPIFY-#1001");
  });

  it("sets gl_status='sent' (skips the draft → pending_approval flow)", () => {
    const row = buildArInvoiceRow({
      order: makeOrder(),
      customerId: CUSTOMER,
      accounts: makeAccounts(),
      jeId: JE_ID,
    });
    expect(row.gl_status).toBe("sent");
  });

  it("links accrual_je_id", () => {
    const row = buildArInvoiceRow({
      order: makeOrder(),
      customerId: CUSTOMER,
      accounts: makeAccounts(),
      jeId: JE_ID,
    });
    expect(row.accrual_je_id).toBe(JE_ID);
  });

  it("propagates total_amount_cents as string", () => {
    const row = buildArInvoiceRow({
      order: makeOrder({ total_amount_cents: 11000 }),
      customerId: CUSTOMER,
      accounts: makeAccounts(),
      jeId: JE_ID,
    });
    expect(row.total_amount_cents).toBe("11000");
  });

  it("sets paid_amount_cents='0'", () => {
    const row = buildArInvoiceRow({
      order: makeOrder(),
      customerId: CUSTOMER,
      accounts: makeAccounts(),
      jeId: JE_ID,
    });
    expect(row.paid_amount_cents).toBe("0");
  });
});

// ──────────────────────────────────────────────────────────────────────
// postShopifyOrderJe — end-to-end
// ──────────────────────────────────────────────────────────────────────

describe("postShopifyOrderJe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects an invalid uuid", async () => {
    await expect(postShopifyOrderJe({
      shopifyOrderId: "not-a-uuid",
      adminClient: { from: () => ({}) },
    })).rejects.toThrow(/uuid/);
  });

  it("rejects when adminClient is invalid", async () => {
    await expect(postShopifyOrderJe({
      shopifyOrderId: ORDER,
      adminClient: null,
    })).rejects.toThrow(/Supabase/);
  });

  it("returns already_posted when je_id already set (idempotent)", async () => {
    const { sb, calls } = makeSupabaseMock({
      order: makeOrder({ je_id: "existing-je-id" }),
    });
    const result = await postShopifyOrderJe({
      shopifyOrderId: ORDER,
      adminClient: sb,
    });
    expect(result).toEqual({
      status: "already_posted",
      je_id: "existing-je-id",
    });
    expect(calls.rpc).toHaveLength(0);
    expect(calls.arInvoiceInsert).toHaveLength(0);
  });

  it("returns 404 when shopify_orders row missing", async () => {
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
    await expect(postShopifyOrderJe({
      shopifyOrderId: ORDER,
      adminClient: sb,
    })).rejects.toMatchObject({ code: "not_found" });
  });

  it("surfaces gl_accounts_missing when AR account not configured", async () => {
    const { sb } = makeSupabaseMock({
      accountRows: [{ code: "4000", id: REV_ACCT }], // no 1200/1201
    });
    await expect(postShopifyOrderJe({
      shopifyOrderId: ORDER,
      adminClient: sb,
    })).rejects.toMatchObject({ code: "gl_accounts_missing" });
  });

  it("surfaces gl_accounts_missing when revenue account not configured", async () => {
    const { sb } = makeSupabaseMock({
      accountRows: [{ code: "1200", id: AR_ACCT }], // no 4000
    });
    await expect(postShopifyOrderJe({
      shopifyOrderId: ORDER,
      adminClient: sb,
    })).rejects.toMatchObject({ code: "gl_accounts_missing" });
  });

  it("surfaces gl_accounts_missing when tax>0 but no 2200 account", async () => {
    const { sb } = makeSupabaseMock({
      accountRows: [
        { code: "1200", id: AR_ACCT },
        { code: "4000", id: REV_ACCT },
      ],
      // order has tax_amount_cents=1000 by default
    });
    await expect(postShopifyOrderJe({
      shopifyOrderId: ORDER,
      adminClient: sb,
    })).rejects.toMatchObject({ code: "gl_accounts_missing" });
  });

  it("happy path: posts JE, creates ar_invoice, stamps shopify_orders", async () => {
    const { sb, calls } = makeSupabaseMock();
    const result = await postShopifyOrderJe({
      shopifyOrderId: ORDER,
      adminClient: sb,
      // P11-5: stub the best-effort COGS follow-up so this happy-path test
      // stays focused on the AR JE (COGS is covered in post-order-cogs tests).
      deps: { postShopifyOrderCogs: async () => null },
    });
    expect(result).toEqual({
      status: "posted",
      je_id: JE_ID,
      ar_invoice_id: AR_INV_ID,
      cogs: null,
    });
    expect(calls.rpc).toHaveLength(1);
    expect(calls.rpc[0].name).toBe("gl_post_journal_entry");
    expect(calls.arInvoiceInsert).toHaveLength(1);
    expect(calls.arInvoiceInsert[0].source).toBe("shopify");
    expect(calls.arInvoiceInsert[0].accrual_je_id).toBe(JE_ID);
    // Final stamp carries both pointers
    const finalStamp = calls.shopifyOrdersUpdate.find(
      (u) => u.patch.je_id && u.patch.ar_invoice_id,
    );
    expect(finalStamp).toBeDefined();
    expect(finalStamp.patch.je_id).toBe(JE_ID);
    expect(finalStamp.patch.ar_invoice_id).toBe(AR_INV_ID);
  });

  it("passes balanced payload to gl_post_journal_entry RPC", async () => {
    const { sb, calls } = makeSupabaseMock();
    await postShopifyOrderJe({ shopifyOrderId: ORDER, adminClient: sb });
    const payload = calls.rpc[0].args.payload;
    // Sum debits / credits as cents-strings → BigInt
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
    await expect(postShopifyOrderJe({
      shopifyOrderId: ORDER,
      adminClient: sb,
    })).rejects.toMatchObject({ code: "rpc_failed" });
  });

  it("ar_invoices insert error stamps je_id and throws ar_invoice_insert_failed", async () => {
    const { sb, calls } = makeSupabaseMock({
      arInvoiceInsertError: { message: "invoice_number duplicate" },
      arInvoiceInsert: null,
    });
    await expect(postShopifyOrderJe({
      shopifyOrderId: ORDER,
      adminClient: sb,
    })).rejects.toMatchObject({
      code: "ar_invoice_insert_failed",
      je_id: JE_ID,
    });
    // Emergency je_id stamp ran before the throw
    const jeOnlyStamp = calls.shopifyOrdersUpdate.find(
      (u) => Object.keys(u.patch).length === 1 && u.patch.je_id,
    );
    expect(jeOnlyStamp).toBeDefined();
  });

  it("shopify_orders update error throws shopify_orders_update_failed (JE + invoice both posted)", async () => {
    const { sb } = makeSupabaseMock({
      shopifyOrdersUpdateError: { message: "row level security" },
    });
    await expect(postShopifyOrderJe({
      shopifyOrderId: ORDER,
      adminClient: sb,
    })).rejects.toMatchObject({
      code: "shopify_orders_update_failed",
      je_id: JE_ID,
      ar_invoice_id: AR_INV_ID,
    });
  });

  it("propagates customer_id from order when set (no upsert)", async () => {
    const { sb, calls } = makeSupabaseMock({
      order: makeOrder({ customer_id: CUSTOMER }),
    });
    await postShopifyOrderJe({ shopifyOrderId: ORDER, adminClient: sb });
    expect(calls.customerInsert).toHaveLength(0);
    expect(calls.arInvoiceInsert[0].customer_id).toBe(CUSTOMER);
  });

  it("upserts customer when only email is provided", async () => {
    const order = makeOrder({ customer_id: null, customer_email: "dtc@example.com" });
    const { sb, calls } = makeSupabaseMock({
      order,
      customerLookup: null,
      customerInsert: { id: "upserted-cust" },
    });
    const result = await postShopifyOrderJe({
      shopifyOrderId: ORDER,
      adminClient: sb,
    });
    expect(result.status).toBe("posted");
    expect(calls.customerInsert.length).toBeGreaterThan(0);
    expect(calls.arInvoiceInsert[0].customer_id).toBe("upserted-cust");
  });

  it("throws customer_resolution_failed when no customer_id and no email", async () => {
    const { sb } = makeSupabaseMock({
      order: makeOrder({ customer_id: null, customer_email: null }),
    });
    await expect(postShopifyOrderJe({
      shopifyOrderId: ORDER,
      adminClient: sb,
    })).rejects.toMatchObject({ code: "customer_resolution_failed" });
  });

  it("posts a fee-bearing order with 5 JE lines when fee_amount_cents > 0", async () => {
    const order = makeOrder({
      total_amount_cents: 11000,
      subtotal_amount_cents: 10000,
      tax_amount_cents: 1000,
      fee_amount_cents: 350,
    });
    const { sb, calls } = makeSupabaseMock({ order });
    await postShopifyOrderJe({ shopifyOrderId: ORDER, adminClient: sb });
    const payload = calls.rpc[0].args.payload;
    expect(payload.lines).toHaveLength(5);
  });

  it("zero-tax order results in a 2-line balanced JE", async () => {
    const order = makeOrder({
      total_amount_cents: 10000,
      subtotal_amount_cents: 10000,
      tax_amount_cents: 0,
    });
    const { sb, calls } = makeSupabaseMock({ order });
    await postShopifyOrderJe({ shopifyOrderId: ORDER, adminClient: sb });
    const payload = calls.rpc[0].args.payload;
    expect(payload.lines).toHaveLength(2);
  });

  it("entity_id propagates from shopify_orders row to JE payload", async () => {
    const { sb, calls } = makeSupabaseMock();
    await postShopifyOrderJe({ shopifyOrderId: ORDER, adminClient: sb });
    expect(calls.rpc[0].args.payload.entity_id).toBe(ENTITY);
  });

  it("invoice number uses shopify_order_id when order_number absent", async () => {
    const order = makeOrder({ order_number: null, shopify_order_id: "G9001" });
    const { sb, calls } = makeSupabaseMock({ order });
    await postShopifyOrderJe({ shopifyOrderId: ORDER, adminClient: sb });
    expect(calls.arInvoiceInsert[0].invoice_number).toContain("G9001");
  });

  it("does NOT include cogs in this JE (P11-3 defers per-line COGS)", async () => {
    const { sb, calls } = makeSupabaseMock();
    await postShopifyOrderJe({ shopifyOrderId: ORDER, adminClient: sb });
    const payload = calls.rpc[0].args.payload;
    const cogsLine = payload.lines.find((l) => /cogs/i.test(l.memo || ""));
    expect(cogsLine).toBeUndefined();
  });
});
