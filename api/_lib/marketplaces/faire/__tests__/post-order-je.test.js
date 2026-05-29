// Tangerine P12c-3 — tests for the Faire AR JE posting service.
//
// Coverage:
//   - BigInt cents helpers (toBigInt / centsToDecimal)
//   - formatRate helper
//   - buildJournalEntryPayload: 3-line balance (recv + commission + revenue),
//     2-line zero-commission edge, balance check, shipping flows to revenue
//   - resolveGlAccounts: code map, missing codes return null
//   - resolveCustomerId: existing customer_id, faire_buyers.customer_id,
//     upsert path, source='faire', wholesale type, race retry, missing token
//   - buildArInvoiceRow: source='faire', FAIRE- prefix, total = sub+ship
//   - postFaireOrderJe end-to-end:
//       * idempotent already_posted short-circuit
//       * not_found
//       * missing GL accounts → gl_accounts_missing (400)
//       * happy path → posted with je_id + ar_invoice_id stamped back
//       * RPC error → rpc_failed
//       * ar_invoices insert error → ar_invoice_insert_failed
//       * faire_orders update error → faire_orders_update_failed
//   - First-vs-recurring commission rate (25% vs 15%) propagates to JE memo

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  postFaireOrderJe,
  buildJournalEntryPayload,
  buildArInvoiceRow,
  resolveCustomerId,
  resolveGlAccounts,
  toBigInt,
  centsToDecimal,
  formatRate,
} from "../post-order-je.js";

const ENTITY     = "11111111-1111-1111-1111-111111111111";
const ORDER      = "22222222-2222-2222-2222-222222222222";
const SHOP       = "33333333-3333-3333-3333-333333333333";
const CUSTOMER   = "44444444-4444-4444-4444-444444444444";
const RECV_ACCT  = "55555555-5555-5555-5555-555555555555";
const REV_ACCT   = "66666666-6666-6666-6666-666666666666";
const FEE_ACCT   = "77777777-7777-7777-7777-777777777777";
const BUYER      = "88888888-8888-8888-8888-888888888888";
const JE_ID      = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const AR_INV_ID  = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function makeOrder(overrides = {}) {
  // $100 subtotal, $0 shipping, 25% first-order = $25 commission → $75 net.
  return {
    id: ORDER,
    entity_id: ENTITY,
    faire_shop_id: SHOP,
    faire_order_id: "FAIRE-ORD-9001",
    faire_brand_token: "fb_buyer_xyz",
    faire_buyer_id: BUYER,
    placed_at: "2026-05-28T12:34:56Z",
    order_status: "PROCESSING",
    currency: "USD",
    subtotal_cents: 10000,
    shipping_cents: 0,
    commission_cents: 2500,
    commission_rate: "0.2500",
    net_payout_cents: 7500,
    is_first_order_for_buyer: true,
    customer_id: CUSTOMER,
    ar_invoice_id: null,
    je_id: null,
    ...overrides,
  };
}

function makeAccounts(overrides = {}) {
  return {
    receivableId: RECV_ACCT,
    revenueId: REV_ACCT,
    feeId: FEE_ACCT,
    ...overrides,
  };
}

function makeSupabaseMock({
  order = makeOrder(),
  accountRows = [
    { code: "1115", id: RECV_ACCT },
    { code: "4000", id: REV_ACCT },
    { code: "6520", id: FEE_ACCT },
  ],
  buyerRow = null,
  customerLookup = null,
  customerInsert = { id: CUSTOMER },
  customerInsertError = null,
  rpcResult = JE_ID,
  rpcError = null,
  arInvoiceInsert = { id: AR_INV_ID },
  arInvoiceInsertError = null,
  faireOrdersUpdateError = null,
  faireOrdersJeOnlyUpdateError = null,
} = {}) {
  const calls = {
    rpc: [],
    arInvoiceInsert: [],
    faireOrdersUpdate: [],
    customerInsert: [],
    customerLookup: [],
    buyerLookup: [],
    buyerUpdate: [],
  };

  const sb = {
    from(table) {
      if (table === "faire_orders") {
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
                calls.faireOrdersUpdate.push({ patch, col, val });
                // Differentiate je_id-only emergency stamp vs final stamp.
                if (patch.je_id && !patch.ar_invoice_id) {
                  return { error: faireOrdersJeOnlyUpdateError };
                }
                return { error: faireOrdersUpdateError };
              },
            };
          },
        };
      }
      if (table === "faire_buyers") {
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle: async () => {
                    calls.buyerLookup.push(true);
                    return { data: buyerRow, error: null };
                  },
                };
              },
            };
          },
          update(patch) {
            return {
              eq: async (col, val) => {
                calls.buyerUpdate.push({ patch, col, val });
                return { error: null };
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
    expect(toBigInt(7500)).toBe(7500n);
  });
  it("converts integer string", () => {
    expect(toBigInt("7500")).toBe(7500n);
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
});

// ──────────────────────────────────────────────────────────────────────
// formatRate
// ──────────────────────────────────────────────────────────────────────

describe("formatRate", () => {
  it("formats 0.25 as 25%", () => {
    expect(formatRate(0.25)).toBe("25%");
  });
  it("formats 0.15 as 15%", () => {
    expect(formatRate(0.15)).toBe("15%");
  });
  it("formats numeric string", () => {
    expect(formatRate("0.2500")).toBe("25%");
  });
  it("handles null", () => {
    expect(formatRate(null)).toBe("0%");
  });
});

// ──────────────────────────────────────────────────────────────────────
// buildJournalEntryPayload
// ──────────────────────────────────────────────────────────────────────

describe("buildJournalEntryPayload", () => {
  it("builds a balanced 3-line JE (recv + commission + revenue) for first-order 25%", () => {
    const payload = buildJournalEntryPayload({
      order: makeOrder(),
      accounts: makeAccounts(),
      customerId: CUSTOMER,
    });
    expect(payload.lines).toHaveLength(3);
    // DR 1115
    expect(payload.lines[0]).toMatchObject({
      line_number: 1,
      account_id: RECV_ACCT,
      debit: "75.00",
      credit: "0",
      subledger_type: "customer",
      subledger_id: CUSTOMER,
    });
    // DR 6520
    expect(payload.lines[1]).toMatchObject({
      line_number: 2,
      account_id: FEE_ACCT,
      debit: "25.00",
      credit: "0",
    });
    // CR 4000
    expect(payload.lines[2]).toMatchObject({
      line_number: 3,
      account_id: REV_ACCT,
      debit: "0",
      credit: "100.00",
    });
  });

  it("builds a balanced JE for 15% recurring order", () => {
    const order = makeOrder({
      commission_cents: 1500,
      commission_rate: "0.1500",
      net_payout_cents: 8500,
      is_first_order_for_buyer: false,
    });
    const payload = buildJournalEntryPayload({
      order, accounts: makeAccounts(), customerId: CUSTOMER,
    });
    expect(payload.lines[0].debit).toBe("85.00");
    expect(payload.lines[1].debit).toBe("15.00");
    expect(payload.lines[2].credit).toBe("100.00");
  });

  it("includes shipping in revenue line", () => {
    const order = makeOrder({
      subtotal_cents: 10000,
      shipping_cents: 1500,        // $15 shipping
      commission_cents: 2500,      // 25% of subtotal
      net_payout_cents: 9000,      // 100 + 15 - 25 = 90
    });
    const payload = buildJournalEntryPayload({
      order, accounts: makeAccounts(), customerId: CUSTOMER,
    });
    expect(payload.lines[0].debit).toBe("90.00");   // receivable
    expect(payload.lines[1].debit).toBe("25.00");   // commission
    expect(payload.lines[2].credit).toBe("115.00"); // revenue = sub + ship
  });

  it("omits commission line when commission_cents=0", () => {
    const order = makeOrder({
      commission_cents: 0,
      net_payout_cents: 10000,
    });
    const payload = buildJournalEntryPayload({
      order, accounts: makeAccounts(), customerId: CUSTOMER,
    });
    expect(payload.lines).toHaveLength(2);
    expect(payload.lines[0].account_id).toBe(RECV_ACCT);
    expect(payload.lines[1].account_id).toBe(REV_ACCT);
  });

  it("balances debits and credits", () => {
    const payload = buildJournalEntryPayload({
      order: makeOrder(),
      accounts: makeAccounts(),
      customerId: CUSTOMER,
    });
    let dr = 0n, cr = 0n;
    for (const ln of payload.lines) {
      dr += BigInt(ln.debit.replace(".", ""));
      cr += BigInt(ln.credit.replace(".", ""));
    }
    expect(dr).toBe(cr);
  });

  it("throws on negative commission", () => {
    const order = makeOrder({ commission_cents: -100 });
    expect(() => buildJournalEntryPayload({
      order, accounts: makeAccounts(), customerId: CUSTOMER,
    })).toThrow(/commission_cents.*negative/);
  });

  it("throws on negative net_payout", () => {
    const order = makeOrder({ net_payout_cents: -1 });
    expect(() => buildJournalEntryPayload({
      order, accounts: makeAccounts(), customerId: CUSTOMER,
    })).toThrow(/net_payout_cents.*negative/);
  });

  it("throws on unbalanced manual payload", () => {
    const order = makeOrder({
      subtotal_cents: 10000,
      shipping_cents: 0,
      commission_cents: 2500,
      net_payout_cents: 9999,  // wrong — should be 7500
    });
    expect(() => buildJournalEntryPayload({
      order, accounts: makeAccounts(), customerId: CUSTOMER,
    })).toThrow(/unbalanced/);
  });

  it("sets source_module='faire' and source_id=order.id", () => {
    const payload = buildJournalEntryPayload({
      order: makeOrder(), accounts: makeAccounts(), customerId: CUSTOMER,
    });
    expect(payload.source_module).toBe("faire");
    expect(payload.source_table).toBe("faire_orders");
    expect(payload.source_id).toBe(ORDER);
  });

  it("sets journal_type='ar_invoice' and basis='ACCRUAL'", () => {
    const payload = buildJournalEntryPayload({
      order: makeOrder(), accounts: makeAccounts(), customerId: CUSTOMER,
    });
    expect(payload.basis).toBe("ACCRUAL");
    expect(payload.journal_type).toBe("ar_invoice");
  });

  it("derives posting_date from placed_at (date-only)", () => {
    const order = makeOrder({ placed_at: "2026-05-28T23:59:00Z" });
    const payload = buildJournalEntryPayload({
      order, accounts: makeAccounts(), customerId: CUSTOMER,
    });
    expect(payload.posting_date).toBe("2026-05-28");
  });

  it("description encodes the faire_order_id", () => {
    const payload = buildJournalEntryPayload({
      order: makeOrder({ faire_order_id: "ORD-42" }),
      accounts: makeAccounts(),
      customerId: CUSTOMER,
    });
    expect(payload.description).toContain("ORD-42");
  });

  it("commission memo encodes the commission rate", () => {
    const payload = buildJournalEntryPayload({
      order: makeOrder({ commission_rate: 0.25 }),
      accounts: makeAccounts(),
      customerId: CUSTOMER,
    });
    expect(payload.lines[1].memo).toMatch(/25%/);
  });

  it("entity_id propagates to payload", () => {
    const payload = buildJournalEntryPayload({
      order: makeOrder(),
      accounts: makeAccounts(),
      customerId: CUSTOMER,
    });
    expect(payload.entity_id).toBe(ENTITY);
  });

  it("subledger_type='customer' only on receivable line", () => {
    const payload = buildJournalEntryPayload({
      order: makeOrder(),
      accounts: makeAccounts(),
      customerId: CUSTOMER,
    });
    expect(payload.lines[0].subledger_type).toBe("customer");
    expect(payload.lines[1].subledger_type).toBeNull();
    expect(payload.lines[2].subledger_type).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// resolveGlAccounts
// ──────────────────────────────────────────────────────────────────────

describe("resolveGlAccounts", () => {
  it("maps codes 1115/4000/6520 to ids", async () => {
    const sb = {
      from: () => ({
        select: () => ({
          eq: () => ({
            in: () => Promise.resolve({
              data: [
                { code: "1115", id: RECV_ACCT },
                { code: "4000", id: REV_ACCT },
                { code: "6520", id: FEE_ACCT },
              ],
              error: null,
            }),
          }),
        }),
      }),
    };
    const out = await resolveGlAccounts(sb, ENTITY);
    expect(out).toEqual({
      receivableId: RECV_ACCT,
      revenueId: REV_ACCT,
      feeId: FEE_ACCT,
    });
  });

  it("returns null for missing codes", async () => {
    const sb = {
      from: () => ({
        select: () => ({
          eq: () => ({
            in: () => Promise.resolve({
              data: [{ code: "4000", id: REV_ACCT }],
              error: null,
            }),
          }),
        }),
      }),
    };
    const out = await resolveGlAccounts(sb, ENTITY);
    expect(out.receivableId).toBeNull();
    expect(out.revenueId).toBe(REV_ACCT);
    expect(out.feeId).toBeNull();
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

  it("returns faire_buyers.customer_id when set", async () => {
    const order = makeOrder({ customer_id: null });
    const sb = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { id: BUYER, customer_id: "buyer-cust", buyer_name: "Test", faire_brand_token: "fb_xyz" },
              error: null,
            }),
          }),
        }),
      }),
    };
    const id = await resolveCustomerId(sb, order);
    expect(id).toBe("buyer-cust");
  });

  it("throws when no customer_id and no brand_token anywhere", async () => {
    const order = makeOrder({
      customer_id: null,
      faire_buyer_id: null,
      faire_brand_token: null,
    });
    const sb = { from: vi.fn() };
    await expect(resolveCustomerId(sb, order)).rejects.toThrow(/brand_token/);
  });

  it("returns existing customer found by code", async () => {
    const order = makeOrder({ customer_id: null, faire_buyer_id: null });
    let buyerLooked = false;
    const sb = {
      from: (table) => {
        if (table === "faire_buyers") {
          return {
            update: () => ({ eq: async () => ({ error: null }) }),
          };
        }
        if (table === "customers") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: { id: "found-id" }, error: null }),
                }),
              }),
            }),
          };
        }
        throw new Error(`unexpected: ${table}`);
      },
    };
    void buyerLooked;
    const id = await resolveCustomerId(sb, order);
    expect(id).toBe("found-id");
  });

  it("inserts a new wholesale customer with code, source='faire'", async () => {
    const order = makeOrder({ customer_id: null, faire_buyer_id: null });
    const inserts = [];
    const sb = {
      from: (table) => {
        if (table === "customers") {
          return {
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
          };
        }
        if (table === "faire_buyers") {
          return { update: () => ({ eq: async () => ({ error: null }) }) };
        }
        throw new Error(`unexpected: ${table}`);
      },
    };
    const id = await resolveCustomerId(sb, order);
    expect(id).toBe("new-id");
    expect(inserts[0]).toMatchObject({
      entity_id: ENTITY,
      code: "FAIRE-fb_buyer_xyz",
      customer_type: "wholesale",
      status: "active",
      source: "faire",
    });
  });

  it("retries insert without source if column rejected", async () => {
    const order = makeOrder({ customer_id: null, faire_buyer_id: null });
    const inserts = [];
    let firstInsert = true;
    const sb = {
      from: (table) => {
        if (table === "customers") {
          return {
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
                    if (firstInsert) {
                      firstInsert = false;
                      return { data: null, error: { message: "column 'source' does not exist" } };
                    }
                    return { data: { id: "retry-id" }, error: null };
                  },
                }),
              };
            },
          };
        }
        if (table === "faire_buyers") {
          return { update: () => ({ eq: async () => ({ error: null }) }) };
        }
        throw new Error(`unexpected: ${table}`);
      },
    };
    const id = await resolveCustomerId(sb, order);
    expect(id).toBe("retry-id");
    expect(inserts).toHaveLength(2);
    expect(inserts[0]).toHaveProperty("source");
    expect(inserts[1]).not.toHaveProperty("source");
  });

  it("returns race-winner row on conflict during insert", async () => {
    const order = makeOrder({ customer_id: null, faire_buyer_id: null });
    let lookupCount = 0;
    const sb = {
      from: (table) => {
        if (table === "customers") {
          return {
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
          };
        }
        if (table === "faire_buyers") {
          return { update: () => ({ eq: async () => ({ error: null }) }) };
        }
        throw new Error(`unexpected: ${table}`);
      },
    };
    const id = await resolveCustomerId(sb, order);
    expect(id).toBe("race-winner");
  });

  it("back-fills faire_buyers.customer_id when buyer row exists but had no customer", async () => {
    const order = makeOrder({ customer_id: null, faire_buyer_id: BUYER });
    const buyerUpdates = [];
    const sb = {
      from: (table) => {
        if (table === "faire_buyers") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { id: BUYER, customer_id: null, buyer_name: "Buyer Co", faire_brand_token: "fb_xyz" },
                  error: null,
                }),
              }),
            }),
            update: (patch) => ({
              eq: async (col, val) => {
                buyerUpdates.push({ patch, col, val });
                return { error: null };
              },
            }),
          };
        }
        if (table === "customers") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: { id: "existing-cust" }, error: null }),
                }),
              }),
            }),
          };
        }
        throw new Error(`unexpected: ${table}`);
      },
    };
    const id = await resolveCustomerId(sb, order);
    expect(id).toBe("existing-cust");
    expect(buyerUpdates).toHaveLength(1);
    expect(buyerUpdates[0].patch.customer_id).toBe("existing-cust");
  });
});

// ──────────────────────────────────────────────────────────────────────
// buildArInvoiceRow
// ──────────────────────────────────────────────────────────────────────

describe("buildArInvoiceRow", () => {
  it("stamps source='faire'", () => {
    const row = buildArInvoiceRow({
      order: makeOrder(),
      customerId: CUSTOMER,
      accounts: makeAccounts(),
      jeId: JE_ID,
    });
    expect(row.source).toBe("faire");
  });

  it("uses FAIRE- prefix in invoice_number", () => {
    const row = buildArInvoiceRow({
      order: makeOrder({ faire_order_id: "ORD-1001" }),
      customerId: CUSTOMER,
      accounts: makeAccounts(),
      jeId: JE_ID,
    });
    expect(row.invoice_number).toBe("FAIRE-ORD-1001");
  });

  it("sets gl_status='sent'", () => {
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

  it("ar_account_id points to 1115 receivable", () => {
    const row = buildArInvoiceRow({
      order: makeOrder(),
      customerId: CUSTOMER,
      accounts: makeAccounts(),
      jeId: JE_ID,
    });
    expect(row.ar_account_id).toBe(RECV_ACCT);
  });

  it("total = subtotal + shipping", () => {
    const row = buildArInvoiceRow({
      order: makeOrder({ subtotal_cents: 10000, shipping_cents: 1500 }),
      customerId: CUSTOMER,
      accounts: makeAccounts(),
      jeId: JE_ID,
    });
    expect(row.total_amount_cents).toBe("11500");
  });

  it("paid_amount_cents='0'", () => {
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
// postFaireOrderJe — end-to-end
// ──────────────────────────────────────────────────────────────────────

describe("postFaireOrderJe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects an invalid uuid", async () => {
    await expect(postFaireOrderJe({
      faireOrderId: "not-a-uuid",
      adminClient: { from: () => ({}) },
    })).rejects.toThrow(/uuid/);
  });

  it("rejects when adminClient is invalid", async () => {
    await expect(postFaireOrderJe({
      faireOrderId: ORDER,
      adminClient: null,
    })).rejects.toThrow(/Supabase/);
  });

  it("returns already_posted when je_id already set (idempotent)", async () => {
    const { sb, calls } = makeSupabaseMock({
      order: makeOrder({ je_id: "existing-je-id" }),
    });
    const result = await postFaireOrderJe({
      faireOrderId: ORDER,
      adminClient: sb,
    });
    expect(result).toEqual({
      status: "already_posted",
      je_id: "existing-je-id",
    });
    expect(calls.rpc).toHaveLength(0);
    expect(calls.arInvoiceInsert).toHaveLength(0);
  });

  it("returns 404 when faire_orders row missing", async () => {
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
    await expect(postFaireOrderJe({
      faireOrderId: ORDER,
      adminClient: sb,
    })).rejects.toMatchObject({ code: "not_found" });
  });

  it("surfaces gl_accounts_missing when 1115 not configured", async () => {
    const { sb } = makeSupabaseMock({
      accountRows: [
        { code: "4000", id: REV_ACCT },
        { code: "6520", id: FEE_ACCT },
      ],
    });
    await expect(postFaireOrderJe({
      faireOrderId: ORDER,
      adminClient: sb,
    })).rejects.toMatchObject({ code: "gl_accounts_missing" });
  });

  it("surfaces gl_accounts_missing when 4000 not configured", async () => {
    const { sb } = makeSupabaseMock({
      accountRows: [
        { code: "1115", id: RECV_ACCT },
        { code: "6520", id: FEE_ACCT },
      ],
    });
    await expect(postFaireOrderJe({
      faireOrderId: ORDER,
      adminClient: sb,
    })).rejects.toMatchObject({ code: "gl_accounts_missing" });
  });

  it("surfaces gl_accounts_missing when commission>0 but 6520 missing", async () => {
    const { sb } = makeSupabaseMock({
      accountRows: [
        { code: "1115", id: RECV_ACCT },
        { code: "4000", id: REV_ACCT },
      ],
    });
    await expect(postFaireOrderJe({
      faireOrderId: ORDER,
      adminClient: sb,
    })).rejects.toMatchObject({ code: "gl_accounts_missing" });
  });

  it("happy path: posts JE, creates ar_invoice, stamps faire_orders", async () => {
    const { sb, calls } = makeSupabaseMock();
    const result = await postFaireOrderJe({
      faireOrderId: ORDER,
      adminClient: sb,
    });
    expect(result).toEqual({
      status: "posted",
      je_id: JE_ID,
      ar_invoice_id: AR_INV_ID,
    });
    expect(calls.rpc).toHaveLength(1);
    expect(calls.rpc[0].name).toBe("gl_post_journal_entry");
    expect(calls.arInvoiceInsert).toHaveLength(1);
    expect(calls.arInvoiceInsert[0].source).toBe("faire");
    expect(calls.arInvoiceInsert[0].accrual_je_id).toBe(JE_ID);
    // Final stamp carries both pointers
    const finalStamp = calls.faireOrdersUpdate.find(
      (u) => u.patch.je_id && u.patch.ar_invoice_id,
    );
    expect(finalStamp).toBeDefined();
    expect(finalStamp.patch.je_id).toBe(JE_ID);
    expect(finalStamp.patch.ar_invoice_id).toBe(AR_INV_ID);
  });

  it("passes balanced payload to gl_post_journal_entry RPC", async () => {
    const { sb, calls } = makeSupabaseMock();
    await postFaireOrderJe({ faireOrderId: ORDER, adminClient: sb });
    const payload = calls.rpc[0].args.payload;
    let dr = 0n, cr = 0n;
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
    await expect(postFaireOrderJe({
      faireOrderId: ORDER,
      adminClient: sb,
    })).rejects.toMatchObject({ code: "rpc_failed" });
  });

  it("ar_invoices insert error stamps je_id and throws ar_invoice_insert_failed", async () => {
    const { sb, calls } = makeSupabaseMock({
      arInvoiceInsertError: { message: "invoice_number duplicate" },
      arInvoiceInsert: null,
    });
    await expect(postFaireOrderJe({
      faireOrderId: ORDER,
      adminClient: sb,
    })).rejects.toMatchObject({
      code: "ar_invoice_insert_failed",
      je_id: JE_ID,
    });
    const jeOnlyStamp = calls.faireOrdersUpdate.find(
      (u) => u.patch.je_id && !u.patch.ar_invoice_id,
    );
    expect(jeOnlyStamp).toBeDefined();
  });

  it("faire_orders update error throws faire_orders_update_failed", async () => {
    const { sb } = makeSupabaseMock({
      faireOrdersUpdateError: { message: "row level security" },
    });
    await expect(postFaireOrderJe({
      faireOrderId: ORDER,
      adminClient: sb,
    })).rejects.toMatchObject({
      code: "faire_orders_update_failed",
      je_id: JE_ID,
      ar_invoice_id: AR_INV_ID,
    });
  });

  it("propagates customer_id from order when set (no buyer lookup)", async () => {
    const { sb, calls } = makeSupabaseMock({
      order: makeOrder({ customer_id: CUSTOMER }),
    });
    await postFaireOrderJe({ faireOrderId: ORDER, adminClient: sb });
    expect(calls.buyerLookup).toHaveLength(0);
    expect(calls.customerInsert).toHaveLength(0);
    expect(calls.arInvoiceInsert[0].customer_id).toBe(CUSTOMER);
  });

  it("looks up buyer when customer_id missing", async () => {
    const { sb, calls } = makeSupabaseMock({
      order: makeOrder({ customer_id: null }),
      buyerRow: {
        id: BUYER,
        customer_id: "buyer-cust",
        buyer_name: "Test Buyer",
        faire_brand_token: "fb_buyer_xyz",
      },
    });
    await postFaireOrderJe({ faireOrderId: ORDER, adminClient: sb });
    expect(calls.buyerLookup.length).toBeGreaterThan(0);
    expect(calls.arInvoiceInsert[0].customer_id).toBe("buyer-cust");
  });

  it("entity_id propagates from faire_orders row to JE payload", async () => {
    const { sb, calls } = makeSupabaseMock();
    await postFaireOrderJe({ faireOrderId: ORDER, adminClient: sb });
    expect(calls.rpc[0].args.payload.entity_id).toBe(ENTITY);
  });

  it("invoice_number uses faire_order_id", async () => {
    const order = makeOrder({ faire_order_id: "ORD-9001" });
    const { sb, calls } = makeSupabaseMock({ order });
    await postFaireOrderJe({ faireOrderId: ORDER, adminClient: sb });
    expect(calls.arInvoiceInsert[0].invoice_number).toBe("FAIRE-ORD-9001");
  });

  it("first-order at 25% produces commission line with 25% memo", async () => {
    const order = makeOrder({
      commission_rate: 0.25,
      commission_cents: 2500,
      net_payout_cents: 7500,
      is_first_order_for_buyer: true,
    });
    const { sb, calls } = makeSupabaseMock({ order });
    await postFaireOrderJe({ faireOrderId: ORDER, adminClient: sb });
    const payload = calls.rpc[0].args.payload;
    const commLine = payload.lines.find((l) => /commission/i.test(l.memo));
    expect(commLine).toBeDefined();
    expect(commLine.memo).toMatch(/25%/);
    expect(commLine.debit).toBe("25.00");
  });

  it("recurring-order at 15% produces commission line with 15% memo", async () => {
    const order = makeOrder({
      commission_rate: 0.15,
      commission_cents: 1500,
      net_payout_cents: 8500,
      is_first_order_for_buyer: false,
    });
    const { sb, calls } = makeSupabaseMock({ order });
    await postFaireOrderJe({ faireOrderId: ORDER, adminClient: sb });
    const payload = calls.rpc[0].args.payload;
    const commLine = payload.lines.find((l) => /commission/i.test(l.memo));
    expect(commLine.memo).toMatch(/15%/);
    expect(commLine.debit).toBe("15.00");
  });

  it("zero-commission order yields 2-line JE", async () => {
    const order = makeOrder({
      commission_cents: 0,
      commission_rate: 0,
      net_payout_cents: 10000,
    });
    const { sb, calls } = makeSupabaseMock({ order });
    await postFaireOrderJe({ faireOrderId: ORDER, adminClient: sb });
    const payload = calls.rpc[0].args.payload;
    expect(payload.lines).toHaveLength(2);
  });

  it("stamps customer_id on faire_orders when freshly resolved", async () => {
    const { sb, calls } = makeSupabaseMock();
    await postFaireOrderJe({ faireOrderId: ORDER, adminClient: sb });
    const finalStamp = calls.faireOrdersUpdate.find(
      (u) => u.patch.je_id && u.patch.ar_invoice_id,
    );
    expect(finalStamp.patch.customer_id).toBe(CUSTOMER);
  });
});
