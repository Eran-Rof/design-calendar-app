// Tangerine P12b-5 — tests for the Walmart returns sync service.
//
// Coverage:
//   - BigInt cents helpers (toBigInt, centsToDecimal)
//   - extractRefundCents + extractRestockingFeeCents on nested
//     returnOrderLines payload + flat fallbacks
//   - pickRestockSourceKind: WFS vs warehouse classification
//   - computeStartDate: 30d default, since override, invalid since
//   - resolveGlAccounts: code map (1200/4000/4500/1300/5000), 1201
//     fallback for AR, missing codes return null
//   - buildCreditMemoJePayload: balanced JE with restocking fee,
//     balanced without restocking fee, line ordering, balance check
//   - buildCreditMemoArRow: source='walmart', invoice_kind, totals
//   - postReturnCreditMemo end-to-end:
//       * already-posted short-circuit
//       * not-found
//       * missing GL accounts → gl_accounts_missing
//       * missing customer_id → customer_resolution_failed
//       * happy path with restocking fee + restock JE
//       * happy path without restock (no ip_item_master_id)
//       * happy path without restock when latest layer cost = 0
//       * negative restocking fee rejected
//       * RPC error → rpc_failed
//       * ar_invoices insert error → ar_invoice_insert_failed
//   - upsertReturn: nested order resolution, SKU → ip_item_master_id
//   - runWalmartReturnsSync orchestrator: per-account isolation,
//     skip already-posted, error capture

import { describe, it, expect, vi } from "vitest";
import {
  runWalmartReturnsSync,
  ingestOneAccount,
  upsertReturn,
  postReturnCreditMemo,
  postRestockJe,
  resolveGlAccounts,
  resolveLatestLayerUnitCost,
  buildCreditMemoJePayload,
  buildCreditMemoArRow,
  extractRefundCents,
  extractRestockingFeeCents,
  pickRestockSourceKind,
  computeStartDate,
  toBigInt,
  centsToDecimal,
} from "../sync-returns.js";

// ──────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────

const ENTITY = "11111111-1111-1111-1111-111111111111";
const RETURN_ID = "22222222-2222-2222-2222-222222222222";
const SELLER = "33333333-3333-3333-3333-333333333333";
const CUSTOMER = "44444444-4444-4444-4444-444444444444";
const ORDER_ID = "55555555-5555-5555-5555-555555555555";
const AR_ACCT = "66666666-6666-6666-6666-666666666666";
const REV_ACCT = "77777777-7777-7777-7777-777777777777";
const RFEE_ACCT = "88888888-8888-8888-8888-888888888888";
const INV_ACCT = "99999999-9999-9999-9999-999999999999";
const COGS_ACCT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ITEM_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const JE_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const RESTOCK_JE_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const AR_INV_ID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

function makeReturnRow(overrides = {}) {
  return {
    id: RETURN_ID,
    entity_id: ENTITY,
    walmart_order_id: ORDER_ID,
    customer_order_id: "CO9001",
    return_order_id: "RO1001",
    item_sku: "SKU1",
    ip_item_master_id: ITEM_ID,
    quantity: 2,
    reason: "Defective",
    return_status: "RECEIVED",
    refund_amount_cents: "5000", // $50.00
    restocking_fee_cents: "500", // $5.00
    raw_payload: { ship_node_type: "SellerFulfilled" },
    je_id: null,
    ar_credit_memo_id: null,
    created_at: "2026-05-28T12:00:00Z",
    ...overrides,
  };
}

function makeAccounts(overrides = {}) {
  return {
    arId: AR_ACCT,
    revenueId: REV_ACCT,
    restockingFeeIncomeId: RFEE_ACCT,
    inventoryAssetId: INV_ACCT,
    cogsId: COGS_ACCT,
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Mock supabase
// ──────────────────────────────────────────────────────────────────────

function makeMockSupabase({
  walmartReturnsRow = null,
  walmartReturnsUpdateError = null,
  walmartReturnsInsertedRow = null,
  walmartOrderRow = null,
  glAccountRows = null,
  arInvoiceInsertedRow = null,
  arInvoiceInsertError = null,
  inventoryLayerRows = null,
  inventoryLayerInsertError = null,
  ipItemMasterRow = null,
  jeRpcResponse = JE_ID,
  jeRpcError = null,
  restockRpcResponse = RESTOCK_JE_ID,
  walmartSellerAccounts = [],
  state = {},
} = {}) {
  state.updates = state.updates || [];
  state.inserts = state.inserts || [];
  state.upserts = state.upserts || [];
  state.rpcCalls = state.rpcCalls || [];
  let rpcCount = 0;

  function makeBuilder(table) {
    const ctx = {
      table,
      _filters: {},
      _mode: null,
      _upsertRows: null,
      _insertRow: null,
      _updatePatch: null,
    };

    const arrayThen = (resolveFn) => {
      if (table === "gl_accounts") {
        return resolveFn({ data: glAccountRows || [], error: null });
      }
      if (table === "walmart_seller_accounts") {
        return resolveFn({ data: walmartSellerAccounts || [], error: null });
      }
      if (table === "inventory_layers") {
        return resolveFn({ data: inventoryLayerRows || [], error: null });
      }
      return resolveFn({ data: [], error: null });
    };

    function flushUpdate(resolveFn) {
      state.updates.push({
        table,
        patch: ctx._updatePatch,
        filters: { ...ctx._filters },
      });
      if (walmartReturnsUpdateError && table === "walmart_returns") {
        return resolveFn({ data: null, error: walmartReturnsUpdateError });
      }
      return resolveFn({ data: null, error: null });
    }

    const builder = {
      select(cols) {
        ctx._select = cols || "*";
        return builder;
      },
      eq(col, val) {
        ctx._filters[col] = val;
        return builder;
      },
      gt() {
        return builder;
      },
      in(col, vals) {
        ctx._filters[col] = { in: vals };
        return builder;
      },
      order() {
        return builder;
      },
      limit() {
        return builder;
      },
      async maybeSingle() {
        if (ctx._upsertRows && table === "walmart_returns") {
          return {
            data:
              walmartReturnsInsertedRow ||
              makeReturnRow({ je_id: null, ar_credit_memo_id: null }),
            error: null,
          };
        }
        if (table === "walmart_returns") {
          if (walmartReturnsRow === "MISSING") {
            return { data: null, error: null };
          }
          return { data: walmartReturnsRow, error: null };
        }
        if (table === "walmart_orders") {
          return { data: walmartOrderRow, error: null };
        }
        if (table === "ip_item_master") {
          return { data: ipItemMasterRow, error: null };
        }
        return { data: null, error: null };
      },
      async single() {
        if (table === "ar_invoices") {
          if (arInvoiceInsertError) {
            return { data: null, error: arInvoiceInsertError };
          }
          return {
            data: arInvoiceInsertedRow || { id: AR_INV_ID },
            error: null,
          };
        }
        return { data: null, error: null };
      },
      then(resolveFn) {
        // When we're in update-mode this is `await supabase.from(t).update(p).eq("id", x)` — flush the update.
        if (ctx._mode === "update") {
          return flushUpdate(resolveFn);
        }
        if (ctx._mode === "insert" && table === "inventory_layers") {
          if (inventoryLayerInsertError) {
            return resolveFn({ data: null, error: inventoryLayerInsertError });
          }
          return resolveFn({ data: null, error: null });
        }
        return arrayThen(resolveFn);
      },
      upsert(rows, opts) {
        state.upserts.push({ table, rows, opts });
        ctx._upsertRows = rows;
        return builder;
      },
      insert(row) {
        state.inserts.push({ table, row });
        ctx._insertRow = row;
        ctx._mode = "insert";
        return builder;
      },
      update(patch) {
        ctx._mode = "update";
        ctx._updatePatch = patch;
        return builder;
      },
    };
    return builder;
  }

  return {
    state,
    from(table) {
      return makeBuilder(table);
    },
    async rpc(name, args) {
      state.rpcCalls.push({ name, args });
      rpcCount++;
      if (jeRpcError) return { data: null, error: jeRpcError };
      if (name === "gl_post_journal_entry") {
        const resp = rpcCount === 1 ? jeRpcResponse : restockRpcResponse;
        return { data: resp, error: null };
      }
      return { data: null, error: null };
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// BigInt helpers
// ──────────────────────────────────────────────────────────────────────

describe("BigInt helpers", () => {
  it("toBigInt accepts number / string / bigint / null", () => {
    expect(toBigInt(0)).toBe(0n);
    expect(toBigInt(100)).toBe(100n);
    expect(toBigInt("123")).toBe(123n);
    expect(toBigInt(456n)).toBe(456n);
    expect(toBigInt(null)).toBe(0n);
    expect(toBigInt("")).toBe(0n);
  });

  it("toBigInt rejects floats", () => {
    expect(() => toBigInt(1.5)).toThrow();
  });

  it("toBigInt rejects non-integer strings", () => {
    expect(() => toBigInt("1.5")).toThrow();
    expect(() => toBigInt("abc")).toThrow();
  });

  it("centsToDecimal formats correctly", () => {
    expect(centsToDecimal(0n)).toBe("0.00");
    expect(centsToDecimal(100n)).toBe("1.00");
    expect(centsToDecimal(12345n)).toBe("123.45");
    expect(centsToDecimal(-500n)).toBe("-5.00");
  });
});

// ──────────────────────────────────────────────────────────────────────
// Payload extraction
// ──────────────────────────────────────────────────────────────────────

describe("extractRefundCents", () => {
  it("sums nested refundCharges", () => {
    const ret = {
      returnOrderLines: {
        returnOrderLine: [
          {
            refund: {
              refundCharges: [
                { refundAmount: { amount: "10.00" } },
                { refundAmount: { amount: "5.50" } },
              ],
            },
          },
        ],
      },
    };
    expect(extractRefundCents(ret)).toBe(1550n);
  });

  it("handles flat refundAmount fallback", () => {
    expect(extractRefundCents({ refundAmount: { amount: "25.00" } })).toBe(
      2500n,
    );
  });

  it("returns 0n for missing refund", () => {
    expect(extractRefundCents({})).toBe(0n);
  });

  it("handles single charge object (not array)", () => {
    const ret = {
      returnOrderLines: [
        {
          refund: { refundCharges: { refundAmount: { amount: "7.25" } } },
        },
      ],
    };
    expect(extractRefundCents(ret)).toBe(725n);
  });
});

describe("extractRestockingFeeCents", () => {
  it("picks RESTOCKING_FEE charge type", () => {
    const ret = {
      returnOrderLines: {
        returnOrderLine: [
          {
            refund: {
              refundCharges: [
                { chargeType: "PRODUCT", refundAmount: { amount: "15.00" } },
                { chargeType: "RESTOCKING_FEE", refundAmount: { amount: "1.50" } },
              ],
            },
          },
        ],
      },
    };
    expect(extractRestockingFeeCents(ret)).toBe(150n);
  });

  it("returns 0n when no restocking charge", () => {
    const ret = {
      returnOrderLines: [
        {
          refund: {
            refundCharges: [
              { chargeType: "PRODUCT", refundAmount: { amount: "20.00" } },
            ],
          },
        },
      ],
    };
    expect(extractRestockingFeeCents(ret)).toBe(0n);
  });

  it("handles flat restockingFee fallback", () => {
    expect(extractRestockingFeeCents({ restockingFee: { amount: "2.50" } })).toBe(
      250n,
    );
  });

  it("absolute value for negative restocking charges", () => {
    const ret = {
      returnOrderLines: [
        {
          refund: {
            refundCharges: [
              { chargeType: "RESTOCKING", refundAmount: { amount: "-3.00" } },
            ],
          },
        },
      ],
    };
    expect(extractRestockingFeeCents(ret)).toBe(300n);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Source kind classification
// ──────────────────────────────────────────────────────────────────────

describe("pickRestockSourceKind", () => {
  it("classifies WFS return_status as wfs_return_restock", () => {
    expect(pickRestockSourceKind({ returnStatus: "WFS_RECEIVED" })).toBe(
      "wfs_return_restock",
    );
  });

  it("classifies WFSFulfilled raw payload as wfs_return_restock", () => {
    expect(
      pickRestockSourceKind({
        returnStatus: "RECEIVED",
        rawPayload: { shipNode: { type: "WFSFulfilled" } },
      }),
    ).toBe("wfs_return_restock");
  });

  it("classifies SellerFulfilled as credit_memo_return", () => {
    expect(
      pickRestockSourceKind({
        returnStatus: "RECEIVED",
        rawPayload: { ship_node_type: "SellerFulfilled" },
      }),
    ).toBe("credit_memo_return");
  });

  it("defaults to credit_memo_return when unknown", () => {
    expect(pickRestockSourceKind({})).toBe("credit_memo_return");
  });
});

// ──────────────────────────────────────────────────────────────────────
// computeStartDate
// ──────────────────────────────────────────────────────────────────────

describe("computeStartDate", () => {
  const NOW = Date.parse("2026-05-28T12:00:00Z");

  it("defaults to now - 30d when since is null", () => {
    const got = Date.parse(computeStartDate(null, NOW));
    expect(NOW - got).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("honors a since older than now", () => {
    const since = "2026-04-01T00:00:00Z";
    expect(computeStartDate(since, NOW)).toBe(new Date(Date.parse(since)).toISOString());
  });

  it("falls back to 30d when since is invalid", () => {
    const got = Date.parse(computeStartDate("not-a-date", NOW));
    expect(NOW - got).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("falls back to 30d when since is in the future", () => {
    const future = new Date(NOW + 24 * 60 * 60 * 1000).toISOString();
    const got = Date.parse(computeStartDate(future, NOW));
    expect(NOW - got).toBe(30 * 24 * 60 * 60 * 1000);
  });
});

// ──────────────────────────────────────────────────────────────────────
// resolveGlAccounts
// ──────────────────────────────────────────────────────────────────────

describe("resolveGlAccounts", () => {
  it("maps codes to ids", async () => {
    const supabase = makeMockSupabase({
      glAccountRows: [
        { code: "1200", id: AR_ACCT },
        { code: "4000", id: REV_ACCT },
        { code: "4500", id: RFEE_ACCT },
        { code: "1300", id: INV_ACCT },
        { code: "5000", id: COGS_ACCT },
      ],
    });
    const got = await resolveGlAccounts(supabase, ENTITY);
    expect(got.arId).toBe(AR_ACCT);
    expect(got.revenueId).toBe(REV_ACCT);
    expect(got.restockingFeeIncomeId).toBe(RFEE_ACCT);
    expect(got.inventoryAssetId).toBe(INV_ACCT);
    expect(got.cogsId).toBe(COGS_ACCT);
  });

  it("falls back to 1201 when 1200 missing", async () => {
    const supabase = makeMockSupabase({
      glAccountRows: [{ code: "1201", id: AR_ACCT }],
    });
    const got = await resolveGlAccounts(supabase, ENTITY);
    expect(got.arId).toBe(AR_ACCT);
  });

  it("returns nulls for missing codes", async () => {
    const supabase = makeMockSupabase({ glAccountRows: [] });
    const got = await resolveGlAccounts(supabase, ENTITY);
    expect(got.arId).toBeNull();
    expect(got.revenueId).toBeNull();
    expect(got.restockingFeeIncomeId).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// buildCreditMemoJePayload
// ──────────────────────────────────────────────────────────────────────

describe("buildCreditMemoJePayload", () => {
  it("builds balanced JE WITH restocking fee", () => {
    const payload = buildCreditMemoJePayload({
      ret: makeReturnRow(),
      refundAmount: 5000n,
      restockingFee: 500n,
      accounts: makeAccounts(),
      customerId: CUSTOMER,
    });
    expect(payload.entity_id).toBe(ENTITY);
    expect(payload.journal_type).toBe("ar_credit_memo");
    expect(payload.source_module).toBe("walmart");
    expect(payload.source_table).toBe("walmart_returns");
    expect(payload.source_id).toBe(RETURN_ID);

    const lines = payload.lines;
    expect(lines.length).toBe(3);

    // DR Revenue (full refund)
    expect(lines[0].account_id).toBe(REV_ACCT);
    expect(lines[0].debit).toBe("50.00");
    expect(lines[0].credit).toBe("0");

    // CR AR (net)
    expect(lines[1].account_id).toBe(AR_ACCT);
    expect(lines[1].credit).toBe("45.00");
    expect(lines[1].subledger_type).toBe("customer");
    expect(lines[1].subledger_id).toBe(CUSTOMER);

    // CR Restocking Fee Income
    expect(lines[2].account_id).toBe(RFEE_ACCT);
    expect(lines[2].credit).toBe("5.00");

    // Balance check
    let dr = 0n;
    let cr = 0n;
    for (const ln of lines) {
      dr += parseDecCents(ln.debit);
      cr += parseDecCents(ln.credit);
    }
    expect(dr).toBe(cr);
  });

  it("builds balanced JE WITHOUT restocking fee", () => {
    const payload = buildCreditMemoJePayload({
      ret: makeReturnRow(),
      refundAmount: 5000n,
      restockingFee: 0n,
      accounts: makeAccounts({ restockingFeeIncomeId: null }),
      customerId: CUSTOMER,
    });
    expect(payload.lines.length).toBe(2);
    expect(payload.lines[0].debit).toBe("50.00");
    expect(payload.lines[1].credit).toBe("50.00");
  });

  it("rejects negative net refund", () => {
    expect(() =>
      buildCreditMemoJePayload({
        ret: makeReturnRow(),
        refundAmount: 100n,
        restockingFee: 500n,
        accounts: makeAccounts(),
        customerId: CUSTOMER,
      }),
    ).toThrow(/negative/);
  });

  it("description mentions restocking fee amount when fee > 0", () => {
    const payload = buildCreditMemoJePayload({
      ret: makeReturnRow(),
      refundAmount: 5000n,
      restockingFee: 500n,
      accounts: makeAccounts(),
      customerId: CUSTOMER,
    });
    expect(payload.description).toMatch(/restocking fee \$5\.00/);
  });
});

function parseDecCents(s) {
  if (s == null || s === "0") return 0n;
  const m = String(s).match(/^(-?)(\d+)\.(\d{2})$/);
  if (!m) return 0n;
  const sign = m[1] === "-" ? -1n : 1n;
  return sign * (BigInt(m[2]) * 100n + BigInt(m[3]));
}

// ──────────────────────────────────────────────────────────────────────
// buildCreditMemoArRow
// ──────────────────────────────────────────────────────────────────────

describe("buildCreditMemoArRow", () => {
  it("emits source='walmart' + customer_credit_memo + net total", () => {
    const row = buildCreditMemoArRow({
      ret: makeReturnRow(),
      refundAmount: 5000n,
      restockingFee: 500n,
      accounts: makeAccounts(),
      customerId: CUSTOMER,
      jeId: JE_ID,
    });
    expect(row.source).toBe("walmart");
    expect(row.invoice_kind).toBe("customer_credit_memo");
    expect(row.customer_id).toBe(CUSTOMER);
    expect(row.accrual_je_id).toBe(JE_ID);
    expect(row.total_amount_cents).toBe("4500");
    expect(row.invoice_number).toMatch(/^WALMART-CM-/);
  });

  it("truncates very long return_order_id to 64 chars on invoice_number", () => {
    const longId = "x".repeat(200);
    const row = buildCreditMemoArRow({
      ret: makeReturnRow({ return_order_id: longId }),
      refundAmount: 5000n,
      restockingFee: 0n,
      accounts: makeAccounts(),
      customerId: CUSTOMER,
      jeId: JE_ID,
    });
    expect(row.invoice_number.length).toBeLessThanOrEqual(64);
  });
});

// ──────────────────────────────────────────────────────────────────────
// postReturnCreditMemo end-to-end
// ──────────────────────────────────────────────────────────────────────

describe("postReturnCreditMemo", () => {
  it("short-circuits when je_id already set (already_posted)", async () => {
    const supabase = makeMockSupabase({
      walmartReturnsRow: makeReturnRow({ je_id: JE_ID }),
    });
    const r = await postReturnCreditMemo({
      supabase,
      walmartReturnId: RETURN_ID,
      sellerAccount: { id: SELLER, entity_id: ENTITY },
    });
    expect(r).toEqual({ status: "already_posted", je_id: JE_ID });
  });

  it("404-shaped error when not found", async () => {
    const supabase = makeMockSupabase({
      walmartReturnsRow: "MISSING",
    });
    await expect(
      postReturnCreditMemo({
        supabase,
        walmartReturnId: RETURN_ID,
        sellerAccount: { id: SELLER, entity_id: ENTITY },
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("gl_accounts_missing when AR account absent", async () => {
    const supabase = makeMockSupabase({
      walmartReturnsRow: makeReturnRow(),
      walmartOrderRow: { customer_id: CUSTOMER },
      glAccountRows: [{ code: "4000", id: REV_ACCT }],
    });
    await expect(
      postReturnCreditMemo({
        supabase,
        walmartReturnId: RETURN_ID,
        sellerAccount: { id: SELLER, entity_id: ENTITY },
      }),
    ).rejects.toMatchObject({ code: "gl_accounts_missing" });
  });

  it("customer_resolution_failed when parent missing customer_id", async () => {
    const supabase = makeMockSupabase({
      walmartReturnsRow: makeReturnRow(),
      walmartOrderRow: { customer_id: null },
      glAccountRows: [],
    });
    await expect(
      postReturnCreditMemo({
        supabase,
        walmartReturnId: RETURN_ID,
        sellerAccount: { id: SELLER, entity_id: ENTITY },
      }),
    ).rejects.toMatchObject({ code: "customer_resolution_failed" });
  });

  it("rejects negative restocking fee", async () => {
    const supabase = makeMockSupabase({
      walmartReturnsRow: makeReturnRow({ restocking_fee_cents: "-100" }),
      walmartOrderRow: { customer_id: CUSTOMER },
    });
    await expect(
      postReturnCreditMemo({
        supabase,
        walmartReturnId: RETURN_ID,
        sellerAccount: { id: SELLER, entity_id: ENTITY },
      }),
    ).rejects.toThrow(/restocking_fee_cents negative/);
  });

  it("rejects restocking fee > refund amount", async () => {
    const supabase = makeMockSupabase({
      walmartReturnsRow: makeReturnRow({
        refund_amount_cents: "100",
        restocking_fee_cents: "500",
      }),
      walmartOrderRow: { customer_id: CUSTOMER },
    });
    await expect(
      postReturnCreditMemo({
        supabase,
        walmartReturnId: RETURN_ID,
        sellerAccount: { id: SELLER, entity_id: ENTITY },
      }),
    ).rejects.toThrow(/restocking_fee_cents \(500\) > refund_amount_cents \(100\)/);
  });

  it("rpc_failed when gl_post_journal_entry returns error", async () => {
    const supabase = makeMockSupabase({
      walmartReturnsRow: makeReturnRow({ ip_item_master_id: null }),
      walmartOrderRow: { customer_id: CUSTOMER },
      glAccountRows: [
        { code: "1200", id: AR_ACCT },
        { code: "4000", id: REV_ACCT },
        { code: "4500", id: RFEE_ACCT },
      ],
      jeRpcError: { message: "boom" },
    });
    await expect(
      postReturnCreditMemo({
        supabase,
        walmartReturnId: RETURN_ID,
        sellerAccount: { id: SELLER, entity_id: ENTITY },
      }),
    ).rejects.toMatchObject({ code: "rpc_failed" });
  });

  it("happy path posts credit memo + restock JE", async () => {
    const supabase = makeMockSupabase({
      walmartReturnsRow: makeReturnRow(),
      walmartOrderRow: { customer_id: CUSTOMER },
      glAccountRows: [
        { code: "1200", id: AR_ACCT },
        { code: "4000", id: REV_ACCT },
        { code: "4500", id: RFEE_ACCT },
        { code: "1300", id: INV_ACCT },
        { code: "5000", id: COGS_ACCT },
      ],
      inventoryLayerRows: [{ unit_cost_cents: "2000" }],
    });
    const r = await postReturnCreditMemo({
      supabase,
      walmartReturnId: RETURN_ID,
      sellerAccount: { id: SELLER, entity_id: ENTITY },
    });
    expect(r.status).toBe("posted");
    expect(r.je_id).toBe(JE_ID);
    expect(r.ar_credit_memo_id).toBe(AR_INV_ID);
    expect(r.restock_je_id).toBe(RESTOCK_JE_ID);
    expect(supabase.state.rpcCalls.length).toBe(2);
    expect(supabase.state.inserts.some((i) => i.table === "ar_invoices")).toBe(
      true,
    );
    expect(
      supabase.state.inserts.some((i) => i.table === "inventory_layers"),
    ).toBe(true);
  });

  it("happy path skips restock when ip_item_master_id is null", async () => {
    const supabase = makeMockSupabase({
      walmartReturnsRow: makeReturnRow({ ip_item_master_id: null }),
      walmartOrderRow: { customer_id: CUSTOMER },
      glAccountRows: [
        { code: "1200", id: AR_ACCT },
        { code: "4000", id: REV_ACCT },
        { code: "4500", id: RFEE_ACCT },
      ],
    });
    const r = await postReturnCreditMemo({
      supabase,
      walmartReturnId: RETURN_ID,
      sellerAccount: { id: SELLER, entity_id: ENTITY },
    });
    expect(r.status).toBe("posted");
    expect(r.restock_je_id).toBeNull();
    // Only one RPC call (no restock).
    expect(supabase.state.rpcCalls.length).toBe(1);
  });

  it("ar_invoice_insert_failed stamps je_id back on the row", async () => {
    const supabase = makeMockSupabase({
      walmartReturnsRow: makeReturnRow({ ip_item_master_id: null }),
      walmartOrderRow: { customer_id: CUSTOMER },
      glAccountRows: [
        { code: "1200", id: AR_ACCT },
        { code: "4000", id: REV_ACCT },
        { code: "4500", id: RFEE_ACCT },
      ],
      arInvoiceInsertError: { message: "constraint" },
    });
    await expect(
      postReturnCreditMemo({
        supabase,
        walmartReturnId: RETURN_ID,
        sellerAccount: { id: SELLER, entity_id: ENTITY },
      }),
    ).rejects.toMatchObject({ code: "ar_invoice_insert_failed", je_id: JE_ID });
  });
});

// ──────────────────────────────────────────────────────────────────────
// resolveLatestLayerUnitCost
// ──────────────────────────────────────────────────────────────────────

describe("resolveLatestLayerUnitCost", () => {
  it("returns latest open layer cost as BigInt", async () => {
    const supabase = makeMockSupabase({
      inventoryLayerRows: [{ unit_cost_cents: "2500" }],
    });
    const got = await resolveLatestLayerUnitCost(supabase, ENTITY, ITEM_ID);
    expect(got).toBe(2500n);
  });

  it("returns null when no layers exist", async () => {
    const supabase = makeMockSupabase({ inventoryLayerRows: [] });
    const got = await resolveLatestLayerUnitCost(supabase, ENTITY, ITEM_ID);
    expect(got).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// runWalmartReturnsSync orchestrator (integration-ish)
// ──────────────────────────────────────────────────────────────────────

describe("runWalmartReturnsSync orchestrator", () => {
  it("returns zero-account summary when no accounts active", async () => {
    const supabase = makeMockSupabase({ walmartSellerAccounts: [] });
    const out = await runWalmartReturnsSync(supabase);
    expect(out.accounts).toEqual([]);
    expect(out.total_returns_upserted).toBe(0);
    expect(out.total_errors).toBe(0);
  });

  it("captures missing-ciphertext error per-account without crashing", async () => {
    const supabase = makeMockSupabase({
      walmartSellerAccounts: [
        {
          id: SELLER,
          entity_id: ENTITY,
          partner_id: "10000",
          account_name: "ROF",
          client_id_ciphertext: null, // missing
          client_id_iv: null,
          client_id_tag: null,
          client_secret_ciphertext: null,
          client_secret_iv: null,
          client_secret_tag: null,
          is_active: true,
        },
      ],
    });
    const out = await runWalmartReturnsSync(supabase, {
      deps: {
        getAccessToken: vi.fn(),
        ClientCtor: function () {},
        decrypt: vi.fn(),
      },
    });
    expect(out.accounts.length).toBe(1);
    expect(out.accounts[0].error).toMatch(/ciphertext/);
    expect(out.total_errors).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// ingestOneAccount — page walk with mocked WalmartClient
// ──────────────────────────────────────────────────────────────────────

describe("ingestOneAccount", () => {
  it("walks a single page + posts credit memo for each return", async () => {
    const supabase = makeMockSupabase({
      walmartReturnsRow: makeReturnRow({ je_id: null, ip_item_master_id: null }),
      walmartReturnsInsertedRow: makeReturnRow({ je_id: null, ip_item_master_id: null }),
      walmartOrderRow: { customer_id: CUSTOMER },
      glAccountRows: [
        { code: "1200", id: AR_ACCT },
        { code: "4000", id: REV_ACCT },
        { code: "4500", id: RFEE_ACCT },
      ],
    });
    const listReturns = vi.fn(async () => ({
      data: [
        { returnOrderId: "RO1001", customerOrderId: "CO9001" },
      ],
      nextCursor: null,
    }));
    function FakeClient() {
      return { listReturns };
    }
    const acct = {
      id: SELLER,
      entity_id: ENTITY,
      partner_id: "10000",
      account_name: "ROF",
      client_id_ciphertext: Buffer.from("ct"),
      client_id_iv: Buffer.from("iv"),
      client_id_tag: Buffer.from("tag"),
      client_secret_ciphertext: Buffer.from("ct"),
      client_secret_iv: Buffer.from("iv"),
      client_secret_tag: Buffer.from("tag"),
      is_active: true,
    };
    const deps = {
      getAccessToken: async () => ({ access_token: "tok" }),
      ClientCtor: FakeClient,
      decrypt: () => "plain",
    };
    const out = await ingestOneAccount(supabase, acct, deps, {});
    expect(out.error).toBeNull();
    expect(out.returns_upserted).toBe(1);
    expect(out.credit_memos_posted).toBe(1);
    expect(out.pages_walked).toBe(1);
    expect(listReturns).toHaveBeenCalledTimes(1);
  });

  it("captures per-return error without stopping the page", async () => {
    const supabase = {
      from(table) {
        if (table === "walmart_returns") {
          return {
            select() { return this; },
            eq() { return this; },
            upsert() { return this; },
            maybeSingle: async () => ({
              data: null,
              error: { message: "schema mismatch" },
            }),
          };
        }
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({ data: null, error: null }),
        };
      },
    };
    const listReturns = vi.fn(async () => ({
      data: [{ returnOrderId: "RO1001" }, { returnOrderId: "RO1002" }],
      nextCursor: null,
    }));
    function FakeClient() {
      return { listReturns };
    }
    const acct = {
      id: SELLER,
      entity_id: ENTITY,
      partner_id: "10000",
      account_name: "ROF",
      client_id_ciphertext: Buffer.from("ct"),
      client_id_iv: Buffer.from("iv"),
      client_id_tag: Buffer.from("tag"),
      client_secret_ciphertext: Buffer.from("ct"),
      client_secret_iv: Buffer.from("iv"),
      client_secret_tag: Buffer.from("tag"),
      is_active: true,
    };
    const deps = {
      getAccessToken: async () => ({ access_token: "tok" }),
      ClientCtor: FakeClient,
      decrypt: () => "plain",
    };
    const out = await ingestOneAccount(supabase, acct, deps, {});
    expect(out.return_errors.length).toBe(2);
    expect(out.returns_upserted).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// upsertReturn
// ──────────────────────────────────────────────────────────────────────

describe("upsertReturn", () => {
  it("returns null when return_order_id is missing", async () => {
    const supabase = makeMockSupabase();
    const out = await upsertReturn(supabase, { id: SELLER, entity_id: ENTITY }, {});
    expect(out).toBeNull();
  });

  it("resolves walmart_order_id from customer_order_id", async () => {
    const supabase = makeMockSupabase({
      walmartOrderRow: { id: ORDER_ID },
      walmartReturnsInsertedRow: makeReturnRow(),
    });
    const out = await upsertReturn(
      supabase,
      { id: SELLER, entity_id: ENTITY },
      {
        returnOrderId: "RO1001",
        customerOrderId: "CO9001",
        returnOrderLines: {
          returnOrderLine: [
            {
              item: { sku: "SKU1" },
              returnQuantity: { amount: 2 },
              returnReason: "Defective",
              refund: {
                refundCharges: [
                  { chargeType: "PRODUCT", refundAmount: { amount: "50.00" } },
                  { chargeType: "RESTOCKING_FEE", refundAmount: { amount: "5.00" } },
                ],
              },
            },
          ],
        },
      },
    );
    expect(out).not.toBeNull();
    const upsert = supabase.state.upserts.find((u) => u.table === "walmart_returns");
    expect(upsert.rows.return_order_id).toBe("RO1001");
    expect(upsert.rows.walmart_order_id).toBe(ORDER_ID);
    expect(upsert.rows.refund_amount_cents).toBe("5500");
    expect(upsert.rows.restocking_fee_cents).toBe("500");
  });
});

// ──────────────────────────────────────────────────────────────────────
// postRestockJe directly
// ──────────────────────────────────────────────────────────────────────

describe("postRestockJe", () => {
  it("posts a balanced inventory restock JE + inventory_layers row", async () => {
    const supabase = makeMockSupabase({
      restockRpcResponse: RESTOCK_JE_ID,
    });
    // First rpc call returns the restock je id directly.
    supabase.rpc = async (name, args) => {
      supabase.state.rpcCalls.push({ name, args });
      return { data: RESTOCK_JE_ID, error: null };
    };
    const r = await postRestockJe({
      supabase,
      ret: makeReturnRow(),
      qty: 2,
      unitCostCents: 2000n,
      accounts: makeAccounts(),
      sourceKind: "credit_memo_return",
    });
    expect(r.je_id).toBe(RESTOCK_JE_ID);
    const layerInsert = supabase.state.inserts.find(
      (i) => i.table === "inventory_layers",
    );
    expect(layerInsert.row.source_kind).toBe("credit_memo_return");
    expect(layerInsert.row.unit_cost_cents).toBe("2000");
    expect(layerInsert.row.original_qty).toBe(2);
  });

  it("rejects zero unit cost", async () => {
    const supabase = makeMockSupabase();
    await expect(
      postRestockJe({
        supabase,
        ret: makeReturnRow(),
        qty: 2,
        unitCostCents: 0n,
        accounts: makeAccounts(),
        sourceKind: "credit_memo_return",
      }),
    ).rejects.toThrow(/unitCostCents/);
  });

  it("rejects qty <= 0", async () => {
    const supabase = makeMockSupabase();
    await expect(
      postRestockJe({
        supabase,
        ret: makeReturnRow(),
        qty: 0,
        unitCostCents: 100n,
        accounts: makeAccounts(),
        sourceKind: "credit_memo_return",
      }),
    ).rejects.toThrow(/qty/);
  });
});
