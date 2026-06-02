// Tangerine P11-6 — tests for the Shopify refund processing service.
//
// Coverage:
//   - Pure helpers: toBigInt, centsToDecimal, classifyRefundType,
//     extractRestockedLines
//   - resolveCreditMemoAccounts: 1200/1201/4000/4500/1300/5000 mapping
//   - buildCreditMemoJePayload: balance proof, restocking fee handling,
//     subledger tagging, zero-restock collapse
//   - buildCreditMemoInvoiceRow: source='shopify', invoice_kind, JE link,
//     reverses_invoice_id pointer
//   - processShopifyRefund FULL refund path:
//       * not_found refund
//       * not_found parent order
//       * parent_ar_invoice_missing
//       * happy: reverses accrual + cash JE, flips parent gl_status='void'
//       * already_processed (idempotent re-call)
//       * already-terminal parent (no JE re-reversal, still stamps)
//   - processShopifyRefund PARTIAL refund path:
//       * happy: posts CM JE + inserts ar_invoices CM
//       * missing GL accounts → gl_accounts_missing
//       * restocking fee but no 4500 account → throws via builder
//       * invalid_amounts when fee > refund
//       * customer_resolution_failed
//       * rpc_failed
//       * ar_invoice_insert_failed surfaces je_id
//       * COGS reversal posts a sibling JE + inserts inventory_layers
//       * no restocked lines → no COGS JE
//       * inventory_layers insert error → non-fatal, je still returned

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  processShopifyRefund,
  classifyRefundType,
  buildCreditMemoJePayload,
  buildCreditMemoInvoiceRow,
  resolveCreditMemoAccounts,
  extractRestockedLines,
  toBigInt,
  centsToDecimal,
} from "../process-refund.js";

const ENTITY     = "11111111-1111-1111-1111-111111111111";
const REFUND_ID  = "22222222-2222-2222-2222-222222222222";
const ORDER_ID   = "33333333-3333-3333-3333-333333333333";
const AR_INV_ID  = "44444444-4444-4444-4444-444444444444";
const CM_ID      = "55555555-5555-5555-5555-555555555555";
const ACCR_JE    = "66666666-6666-6666-6666-666666666666";
const CASH_JE    = "77777777-7777-7777-7777-777777777777";
const NEW_JE     = "88888888-8888-8888-8888-888888888888";
const REV_JE     = "99999999-9999-9999-9999-999999999999";
const REV2_JE    = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const AR_ACCT    = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const REV_ACCT   = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const RESTOCK_ACCT = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const INV_ACCT   = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const COGS_ACCT  = "ffffffff-ffff-ffff-ffff-ffffffffffff";
const CUSTOMER   = "12121212-1212-1212-1212-121212121212";
const ITEM       = "13131313-1313-1313-1313-131313131313";
const LAYER_ID_1 = "14141414-1414-1414-1414-141414141414";

function makeRefund(overrides = {}) {
  return {
    id: REFUND_ID,
    entity_id: ENTITY,
    shopify_order_id: ORDER_ID,
    shopify_refund_id: "RR-1",
    refund_type: null,
    refund_amount_cents: "5000",
    restocking_fee_cents: "0",
    processed_at: "2026-05-29T10:00:00Z",
    ar_credit_memo_id: null,
    raw_payload: {},
    ...overrides,
  };
}

function makeOrder(overrides = {}) {
  return {
    id: ORDER_ID,
    entity_id: ENTITY,
    shopify_order_id: "9001",
    order_number: "#1001",
    total_amount_cents: "10000",
    customer_id: CUSTOMER,
    processed_at: "2026-05-28T10:00:00Z",
    ar_invoice_id: AR_INV_ID,
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Pure helper tests
// ──────────────────────────────────────────────────────────────────────

describe("toBigInt", () => {
  it("handles null/empty as 0n", () => {
    expect(toBigInt(null)).toBe(0n);
    expect(toBigInt("")).toBe(0n);
  });
  it("accepts integer numbers", () => {
    expect(toBigInt(123)).toBe(123n);
  });
  it("accepts integer-cents strings", () => {
    expect(toBigInt("1000")).toBe(1000n);
    expect(toBigInt("-500")).toBe(-500n);
  });
  it("rejects floats", () => {
    expect(() => toBigInt(12.5)).toThrow();
  });
});

describe("centsToDecimal", () => {
  it("formats positive cents", () => {
    expect(centsToDecimal(1234n)).toBe("12.34");
    expect(centsToDecimal(100n)).toBe("1.00");
    expect(centsToDecimal(1n)).toBe("0.01");
  });
  it("formats negative cents", () => {
    expect(centsToDecimal(-1234n)).toBe("-12.34");
  });
  it("formats zero", () => {
    expect(centsToDecimal(0n)).toBe("0.00");
  });
});

describe("classifyRefundType", () => {
  it("classifies as full when refund_amount >= order total", () => {
    expect(classifyRefundType(makeRefund({ refund_amount_cents: "10000" }), makeOrder())).toBe("full");
    expect(classifyRefundType(makeRefund({ refund_amount_cents: "15000" }), makeOrder())).toBe("full");
  });
  it("classifies as partial when refund_amount < order total", () => {
    expect(classifyRefundType(makeRefund({ refund_amount_cents: "5000" }), makeOrder())).toBe("partial");
  });
  it("respects explicit refund_type when set + valid", () => {
    expect(classifyRefundType(
      makeRefund({ refund_type: "full", refund_amount_cents: "5000" }),
      makeOrder({ total_amount_cents: "10000" }),
    )).toBe("full");
  });
  it("re-verifies a stale 'partial' against parent total", () => {
    // explicit=partial but amount >= total — should override to full
    expect(classifyRefundType(
      makeRefund({ refund_type: "partial", refund_amount_cents: "10000" }),
      makeOrder({ total_amount_cents: "10000" }),
    )).toBe("full");
  });
  it("defaults to partial when no order context", () => {
    expect(classifyRefundType(makeRefund())).toBe("partial");
  });
});

describe("extractRestockedLines", () => {
  it("returns lines with restock_type != no_restock", () => {
    const lines = extractRestockedLines({
      refund_line_items: [
        { line_item_id: 1, quantity: 2, restock_type: "return", subtotal: "20.00" },
        { line_item_id: 2, quantity: 1, restock_type: "no_restock", subtotal: "5.00" },
        { line_item_id: 3, quantity: 1, restock_type: "cancel", subtotal: "10.00" },
        { line_item_id: 4, quantity: 1, restock_type: "legacy_restock", subtotal: "8.00" },
      ],
    });
    expect(lines).toHaveLength(3);
    expect(lines[0].shopify_line_id).toBe("1");
    expect(lines[0].quantity).toBe(2);
    expect(lines[1].shopify_line_id).toBe("3");
  });
  it("returns [] for missing/empty payload", () => {
    expect(extractRestockedLines(null)).toEqual([]);
    expect(extractRestockedLines({})).toEqual([]);
    expect(extractRestockedLines({ refund_line_items: [] })).toEqual([]);
  });
  it("filters zero-quantity lines", () => {
    const lines = extractRestockedLines({
      refund_line_items: [
        { line_item_id: 1, quantity: 0, restock_type: "return" },
      ],
    });
    expect(lines).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Builders
// ──────────────────────────────────────────────────────────────────────

describe("buildCreditMemoJePayload", () => {
  function accounts() {
    return {
      arId: AR_ACCT,
      revenueId: REV_ACCT,
      restockingFeeId: RESTOCK_ACCT,
      inventoryId: INV_ACCT,
      cogsId: COGS_ACCT,
    };
  }

  it("balances debits + credits without a restocking fee", () => {
    const p = buildCreditMemoJePayload({
      order: makeOrder(),
      refund: makeRefund({ refund_amount_cents: "5000", restocking_fee_cents: "0" }),
      accounts: accounts(),
      customerId: CUSTOMER,
      refundCents: 5000n,
      restockFeeCents: 0n,
      revenueReversal: 5000n,
    });
    expect(p.lines).toHaveLength(2);
    expect(p.lines[0]).toMatchObject({ account_id: REV_ACCT, debit: "50.00", credit: "0" });
    expect(p.lines[1]).toMatchObject({ account_id: AR_ACCT, debit: "0", credit: "50.00", subledger_type: "customer", subledger_id: CUSTOMER });
  });

  it("includes restocking fee CR when fee > 0 and balances", () => {
    // refund=5000, fee=500 → DR Rev 5000, CR Restock 500, CR AR 4500
    const p = buildCreditMemoJePayload({
      order: makeOrder(),
      refund: makeRefund({ refund_amount_cents: "5000", restocking_fee_cents: "500" }),
      accounts: accounts(),
      customerId: CUSTOMER,
      refundCents: 5000n,
      restockFeeCents: 500n,
      revenueReversal: 4500n,
    });
    expect(p.lines).toHaveLength(3);
    expect(p.lines[0]).toMatchObject({ account_id: REV_ACCT, debit: "50.00" });
    expect(p.lines[1]).toMatchObject({ account_id: RESTOCK_ACCT, credit: "5.00" });
    expect(p.lines[2]).toMatchObject({ account_id: AR_ACCT, credit: "45.00" });
  });

  it("throws when restocking fee provided but no 4500 account", () => {
    expect(() => buildCreditMemoJePayload({
      order: makeOrder(),
      refund: makeRefund({ restocking_fee_cents: "500" }),
      accounts: { ...accounts(), restockingFeeId: null },
      customerId: CUSTOMER,
      refundCents: 5000n,
      restockFeeCents: 500n,
      revenueReversal: 4500n,
    })).toThrow(/4500/);
  });

  it("sets source_module=shopify and source_table=shopify_refunds", () => {
    const p = buildCreditMemoJePayload({
      order: makeOrder(),
      refund: makeRefund(),
      accounts: accounts(),
      customerId: CUSTOMER,
      refundCents: 5000n,
      restockFeeCents: 0n,
      revenueReversal: 5000n,
    });
    expect(p.source_module).toBe("shopify");
    expect(p.source_table).toBe("shopify_refunds");
    expect(p.journal_type).toBe("ar_credit_memo");
  });
});

describe("buildCreditMemoInvoiceRow", () => {
  it("stamps source='shopify' + invoice_kind='customer_credit_memo' + reverses_invoice_id", () => {
    const row = buildCreditMemoInvoiceRow({
      order: makeOrder(),
      refund: makeRefund(),
      accounts: { arId: AR_ACCT, revenueId: REV_ACCT },
      customerId: CUSTOMER,
      jeId: NEW_JE,
      totalAmountCents: 5000n,
      originalInvoiceId: AR_INV_ID,
    });
    expect(row.source).toBe("shopify");
    expect(row.invoice_kind).toBe("customer_credit_memo");
    expect(row.accrual_je_id).toBe(NEW_JE);
    expect(row.ar_account_id).toBe(AR_ACCT);
    expect(row.revenue_account_id).toBe(REV_ACCT);
    expect(row.invoice_number).toBe("SHOPIFY-CM-RR-1");
    expect(row.total_amount_cents).toBe("5000");
    expect(row.paid_amount_cents).toBe("0");
    expect(row.reverses_invoice_id).toBe(AR_INV_ID);
    expect(row.gl_status).toBe("sent");
  });

  it("omits reverses_invoice_id when not provided", () => {
    const row = buildCreditMemoInvoiceRow({
      order: makeOrder({ ar_invoice_id: null }),
      refund: makeRefund(),
      accounts: { arId: AR_ACCT, revenueId: REV_ACCT },
      customerId: CUSTOMER,
      jeId: NEW_JE,
      totalAmountCents: 5000n,
      originalInvoiceId: null,
    });
    expect(row.reverses_invoice_id).toBeUndefined();
  });
});

describe("resolveCreditMemoAccounts", () => {
  function sb(rows) {
    return {
      from: () => ({
        select: () => ({
          eq: () => ({
            in: () => Promise.resolve({ data: rows, error: null }),
          }),
        }),
      }),
    };
  }
  it("maps codes to account ids", async () => {
    const a = await resolveCreditMemoAccounts(sb([
      { code: "1200", id: AR_ACCT },
      { code: "4000", id: REV_ACCT },
      { code: "4500", id: RESTOCK_ACCT },
      { code: "1300", id: INV_ACCT },
      { code: "5000", id: COGS_ACCT },
    ]), ENTITY);
    expect(a.arId).toBe(AR_ACCT);
    expect(a.revenueId).toBe(REV_ACCT);
    expect(a.restockingFeeId).toBe(RESTOCK_ACCT);
    expect(a.inventoryId).toBe(INV_ACCT);
    expect(a.cogsId).toBe(COGS_ACCT);
  });
  it("falls back to 1201 when 1200 missing", async () => {
    const a = await resolveCreditMemoAccounts(sb([
      { code: "1201", id: AR_ACCT },
      { code: "4000", id: REV_ACCT },
    ]), ENTITY);
    expect(a.arId).toBe(AR_ACCT);
  });
  it("returns null for missing codes", async () => {
    const a = await resolveCreditMemoAccounts(sb([]), ENTITY);
    expect(a.arId).toBeNull();
    expect(a.revenueId).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// processShopifyRefund — FULL path
// ──────────────────────────────────────────────────────────────────────

function makeAdminMockFull({
  refund = makeRefund({ refund_amount_cents: "10000" }), // == order total
  order = makeOrder(),
  parentInv = { id: AR_INV_ID, entity_id: ENTITY, gl_status: "sent", accrual_je_id: ACCR_JE, cash_je_id: CASH_JE, paid_amount_cents: "10000" },
} = {}) {
  const calls = { refundUpdate: [], invoiceUpdate: [] };
  return {
    __calls: calls,
    from(table) {
      if (table === "shopify_refunds") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: refund, error: null }),
            }),
          }),
          update: (patch) => {
            calls.refundUpdate.push(patch);
            return { eq: async () => ({ data: patch, error: null }) };
          },
        };
      }
      if (table === "shopify_orders") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: order, error: null }),
            }),
          }),
        };
      }
      if (table === "ar_invoices") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: parentInv, error: null }),
            }),
          }),
          update: (patch) => {
            calls.invoiceUpdate.push(patch);
            return { eq: async () => ({ data: patch, error: null }) };
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
}

describe("processShopifyRefund — FULL refund path", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects bad uuid", async () => {
    await expect(processShopifyRefund({ shopifyRefundId: "no", adminClient: {} })).rejects.toThrow();
  });

  it("rejects missing admin client", async () => {
    await expect(processShopifyRefund({ shopifyRefundId: REFUND_ID })).rejects.toThrow();
  });

  it("returns not_found when refund missing", async () => {
    const sb = makeAdminMockFull({ refund: null });
    await expect(processShopifyRefund({ shopifyRefundId: REFUND_ID, adminClient: sb }))
      .rejects.toMatchObject({ code: "not_found" });
  });

  it("returns not_found when parent order missing", async () => {
    const sb = makeAdminMockFull({ order: null });
    await expect(processShopifyRefund({ shopifyRefundId: REFUND_ID, adminClient: sb }))
      .rejects.toMatchObject({ code: "not_found" });
  });

  it("short-circuits when refund already has ar_credit_memo_id", async () => {
    const sb = makeAdminMockFull({
      refund: makeRefund({ ar_credit_memo_id: AR_INV_ID, refund_type: "full" }),
    });
    const result = await processShopifyRefund({ shopifyRefundId: REFUND_ID, adminClient: sb });
    expect(result.status).toBe("already_processed");
    expect(result.refund_type).toBe("full");
    expect(result.ar_credit_memo_id).toBe(AR_INV_ID);
  });

  it("rejects when parent ar_invoice_id missing (full path)", async () => {
    const sb = makeAdminMockFull({
      order: makeOrder({ ar_invoice_id: null }),
      refund: makeRefund({ refund_amount_cents: "10000" }),
    });
    await expect(processShopifyRefund({ shopifyRefundId: REFUND_ID, adminClient: sb }))
      .rejects.toMatchObject({ code: "parent_ar_invoice_missing" });
  });

  it("reverses accrual + cash JEs + flips parent to void + stamps refund", async () => {
    const sb = makeAdminMockFull();
    const reverseFn = vi.fn()
      .mockResolvedValueOnce(REV_JE)
      .mockResolvedValueOnce(REV2_JE);
    const result = await processShopifyRefund({
      shopifyRefundId: REFUND_ID,
      adminClient: sb,
      deps: { reverseJournalEntry: reverseFn },
    });
    expect(result.status).toBe("voided");
    expect(result.refund_type).toBe("full");
    expect(result.reversed_je_ids).toEqual([REV_JE, REV2_JE]);
    expect(reverseFn).toHaveBeenCalledTimes(2);
    // parent invoice flipped void
    expect(sb.__calls.invoiceUpdate[0].gl_status).toBe("void");
    // refund stamped
    expect(sb.__calls.refundUpdate[0].refund_type).toBe("full");
    expect(sb.__calls.refundUpdate[0].ar_credit_memo_id).toBe(AR_INV_ID);
  });

  it("skips reversal when parent is already void/reversed", async () => {
    const sb = makeAdminMockFull({
      parentInv: { id: AR_INV_ID, entity_id: ENTITY, gl_status: "void", accrual_je_id: ACCR_JE, cash_je_id: null, paid_amount_cents: "10000" },
    });
    const reverseFn = vi.fn();
    const result = await processShopifyRefund({
      shopifyRefundId: REFUND_ID,
      adminClient: sb,
      deps: { reverseJournalEntry: reverseFn },
    });
    expect(reverseFn).not.toHaveBeenCalled();
    expect(result.status).toBe("voided");
    // still stamps the refund
    expect(sb.__calls.refundUpdate[0].ar_credit_memo_id).toBe(AR_INV_ID);
  });

  it("reverses only accrual JE when cash_je_id is null", async () => {
    const sb = makeAdminMockFull({
      parentInv: { id: AR_INV_ID, entity_id: ENTITY, gl_status: "sent", accrual_je_id: ACCR_JE, cash_je_id: null, paid_amount_cents: "0" },
    });
    const reverseFn = vi.fn().mockResolvedValueOnce(REV_JE);
    const result = await processShopifyRefund({
      shopifyRefundId: REFUND_ID,
      adminClient: sb,
      deps: { reverseJournalEntry: reverseFn },
    });
    expect(reverseFn).toHaveBeenCalledTimes(1);
    expect(result.reversed_je_ids).toEqual([REV_JE]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// processShopifyRefund — PARTIAL path
// ──────────────────────────────────────────────────────────────────────

function makeAdminMockPartial({
  refund = makeRefund({ refund_amount_cents: "5000", restocking_fee_cents: "500" }),
  order = makeOrder(),
  accountRows = [
    { code: "1200", id: AR_ACCT },
    { code: "4000", id: REV_ACCT },
    { code: "4500", id: RESTOCK_ACCT },
    { code: "1300", id: INV_ACCT },
    { code: "5000", id: COGS_ACCT },
  ],
  parentInvCustomerLookup = { customer_id: CUSTOMER },
  rpcQueue = [NEW_JE],
  rpcError = null,
  arInsert = { id: CM_ID },
  arInsertError = null,
  shopifyLineRows = [],
  arInvoiceLineRows = [],
  layerInsertReturn = [{ id: LAYER_ID_1 }],
  layerInsertError = null,
} = {}) {
  const calls = {
    rpc: [], arInsert: [], refundStamp: [], layerInserts: [], layerUpdates: [],
  };
  return {
    __calls: calls,
    rpc: (name, payload) => {
      calls.rpc.push({ name, payload });
      if (rpcError) return Promise.resolve({ data: null, error: rpcError });
      const next = rpcQueue.shift();
      if (next == null) return Promise.resolve({ data: null, error: { message: "no more rpc results" } });
      return Promise.resolve({ data: next, error: null });
    },
    from(table) {
      if (table === "shopify_refunds") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: refund, error: null }),
            }),
          }),
          update: (patch) => {
            calls.refundStamp.push(patch);
            return { eq: async () => ({ data: patch, error: null }) };
          },
        };
      }
      if (table === "shopify_orders") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: order, error: null }),
            }),
          }),
        };
      }
      if (table === "gl_accounts") {
        return {
          select: () => ({
            eq: () => ({
              in: () => Promise.resolve({ data: accountRows, error: null }),
            }),
          }),
        };
      }
      if (table === "ar_invoices") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: parentInvCustomerLookup, error: null }),
            }),
          }),
          insert: (row) => {
            calls.arInsert.push(row);
            return {
              select: () => ({
                single: async () => ({ data: arInsertError ? null : arInsert, error: arInsertError }),
              }),
            };
          },
        };
      }
      if (table === "shopify_order_lines") {
        return {
          select: () => ({
            eq: () => ({
              in: () => Promise.resolve({ data: shopifyLineRows, error: null }),
            }),
          }),
        };
      }
      if (table === "ar_invoice_lines") {
        return {
          select: () => ({
            eq: () => Promise.resolve({ data: arInvoiceLineRows, error: null }),
          }),
        };
      }
      if (table === "inventory_layers") {
        return {
          insert: (rows) => {
            calls.layerInserts.push(rows);
            return {
              select: () => Promise.resolve({
                data: layerInsertError ? null : layerInsertReturn,
                error: layerInsertError,
              }),
            };
          },
          update: (patch) => {
            calls.layerUpdates.push(patch);
            return { in: async () => ({ data: patch, error: null }) };
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
}

describe("processShopifyRefund — PARTIAL refund path", () => {
  beforeEach(() => vi.clearAllMocks());

  it("happy path: posts CM JE + inserts ar_invoices + stamps refund", async () => {
    const sb = makeAdminMockPartial();
    const result = await processShopifyRefund({ shopifyRefundId: REFUND_ID, adminClient: sb });
    expect(result.status).toBe("credit_memo_posted");
    expect(result.refund_type).toBe("partial");
    expect(result.ar_credit_memo_id).toBe(CM_ID);
    expect(result.je_id).toBe(NEW_JE);
    expect(sb.__calls.rpc).toHaveLength(1);
    // adminClient.rpc("gl_post_journal_entry", { payload: cmJePayload })
    // → call.payload === { payload: cmJePayload }
    expect(sb.__calls.rpc[0].payload.payload.source_module).toBe("shopify");
    expect(sb.__calls.arInsert[0].source).toBe("shopify");
    expect(sb.__calls.arInsert[0].invoice_kind).toBe("customer_credit_memo");
    expect(sb.__calls.refundStamp[0].refund_type).toBe("partial");
    expect(sb.__calls.refundStamp[0].ar_credit_memo_id).toBe(CM_ID);
  });

  it("rejects gl_accounts_missing when 4000 absent", async () => {
    const sb = makeAdminMockPartial({
      accountRows: [{ code: "1200", id: AR_ACCT }],
    });
    await expect(processShopifyRefund({ shopifyRefundId: REFUND_ID, adminClient: sb }))
      .rejects.toMatchObject({ code: "gl_accounts_missing" });
  });

  it("rejects gl_accounts_missing when restocking fee > 0 but 4500 absent", async () => {
    const sb = makeAdminMockPartial({
      accountRows: [
        { code: "1200", id: AR_ACCT },
        { code: "4000", id: REV_ACCT },
      ],
      refund: makeRefund({ refund_amount_cents: "5000", restocking_fee_cents: "500" }),
    });
    await expect(processShopifyRefund({ shopifyRefundId: REFUND_ID, adminClient: sb }))
      .rejects.toMatchObject({ code: "gl_accounts_missing" });
  });

  it("rejects invalid_amounts when fee > refund", async () => {
    const sb = makeAdminMockPartial({
      refund: makeRefund({ refund_amount_cents: "100", restocking_fee_cents: "500" }),
    });
    await expect(processShopifyRefund({ shopifyRefundId: REFUND_ID, adminClient: sb }))
      .rejects.toMatchObject({ code: "invalid_amounts" });
  });

  it("rejects customer_resolution_failed when no customer found", async () => {
    const sb = makeAdminMockPartial({
      order: makeOrder({ customer_id: null, ar_invoice_id: null }),
      parentInvCustomerLookup: null,
    });
    await expect(processShopifyRefund({ shopifyRefundId: REFUND_ID, adminClient: sb }))
      .rejects.toMatchObject({ code: "customer_resolution_failed" });
  });

  it("falls back to order.customer_id when ar_invoice missing customer_id", async () => {
    const sb = makeAdminMockPartial({
      order: makeOrder({ ar_invoice_id: null }),
      parentInvCustomerLookup: null,
    });
    const result = await processShopifyRefund({ shopifyRefundId: REFUND_ID, adminClient: sb });
    expect(result.status).toBe("credit_memo_posted");
  });

  it("rejects rpc_failed on RPC error", async () => {
    const sb = makeAdminMockPartial({ rpcError: { message: "period closed" } });
    await expect(processShopifyRefund({ shopifyRefundId: REFUND_ID, adminClient: sb }))
      .rejects.toMatchObject({ code: "rpc_failed" });
  });

  it("surfaces ar_invoice_insert_failed with je_id when CM insert breaks", async () => {
    const sb = makeAdminMockPartial({
      arInsertError: { message: "constraint violation" },
    });
    await expect(processShopifyRefund({ shopifyRefundId: REFUND_ID, adminClient: sb }))
      .rejects.toMatchObject({ code: "ar_invoice_insert_failed", je_id: NEW_JE });
  });

  it("posts a sibling COGS reversal JE + inserts inventory_layers when lines are restocked", async () => {
    const refund = makeRefund({
      refund_amount_cents: "5000",
      restocking_fee_cents: "0",
      raw_payload: {
        refund_line_items: [
          { line_item_id: 9001, quantity: 1, restock_type: "return", subtotal: "50.00" },
        ],
      },
    });
    const sb = makeAdminMockPartial({
      refund,
      rpcQueue: [NEW_JE, REV_JE], // CM JE + COGS reversal JE
      shopifyLineRows: [
        { id: "sol-1", shopify_line_id: "9001", sku: "ROF-1", quantity: 1 },
      ],
      arInvoiceLineRows: [
        { id: "ail-1", inventory_item_id: ITEM, quantity: 1, cogs_cents: "2500" },
      ],
    });
    const result = await processShopifyRefund({ shopifyRefundId: REFUND_ID, adminClient: sb });
    expect(result.status).toBe("credit_memo_posted");
    expect(result.cogs_je_id).toBe(REV_JE);
    expect(result.inventory_layer_ids).toEqual([LAYER_ID_1]);
    expect(sb.__calls.rpc).toHaveLength(2);
    expect(sb.__calls.rpc[1].payload.payload.journal_type).toBe("inventory_adjustment");
    expect(sb.__calls.layerInserts[0][0].source_kind).toBe("shopify_refund_restock");
  });

  it("skips COGS reversal when no restocked lines", async () => {
    const sb = makeAdminMockPartial();
    const result = await processShopifyRefund({ shopifyRefundId: REFUND_ID, adminClient: sb });
    expect(result.cogs_je_id).toBeNull();
    expect(result.inventory_layer_ids).toEqual([]);
  });

  it("returns cogs_je_id=null when no ar_invoice_lines match the restock SKU", async () => {
    const sb = makeAdminMockPartial({
      refund: makeRefund({
        refund_amount_cents: "5000",
        restocking_fee_cents: "0",
        raw_payload: {
          refund_line_items: [
            { line_item_id: 9001, quantity: 1, restock_type: "return", subtotal: "50.00" },
          ],
        },
      }),
      shopifyLineRows: [
        { id: "sol-1", shopify_line_id: "9001", sku: "ROF-1", quantity: 1 },
      ],
      arInvoiceLineRows: [], // no parent lines stamped
    });
    const result = await processShopifyRefund({ shopifyRefundId: REFUND_ID, adminClient: sb });
    expect(result.cogs_je_id).toBeNull();
  });

  it("treats inventory_layers insert error as non-fatal (cogs JE still posted)", async () => {
    const sb = makeAdminMockPartial({
      refund: makeRefund({
        refund_amount_cents: "5000",
        restocking_fee_cents: "0",
        raw_payload: {
          refund_line_items: [
            { line_item_id: 9001, quantity: 1, restock_type: "return", subtotal: "50.00" },
          ],
        },
      }),
      rpcQueue: [NEW_JE, REV_JE],
      shopifyLineRows: [{ id: "sol-1", shopify_line_id: "9001", sku: "ROF-1", quantity: 1 }],
      arInvoiceLineRows: [{ id: "ail-1", inventory_item_id: ITEM, quantity: 1, cogs_cents: "2500" }],
      layerInsertError: { message: "layer constraint" },
    });
    const result = await processShopifyRefund({ shopifyRefundId: REFUND_ID, adminClient: sb });
    expect(result.cogs_je_id).toBe(REV_JE);
    expect(result.inventory_layer_ids).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Combined: idempotent short-circuit on partial path too
// ──────────────────────────────────────────────────────────────────────

describe("processShopifyRefund — idempotency", () => {
  it("short-circuits already-processed partial refund without RPC", async () => {
    const sb = makeAdminMockPartial({
      refund: makeRefund({
        refund_amount_cents: "5000",
        ar_credit_memo_id: CM_ID,
        refund_type: "partial",
      }),
    });
    const result = await processShopifyRefund({ shopifyRefundId: REFUND_ID, adminClient: sb });
    expect(result.status).toBe("already_processed");
    expect(result.ar_credit_memo_id).toBe(CM_ID);
    expect(sb.__calls.rpc).toHaveLength(0);
  });
});
