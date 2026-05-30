// Tangerine P11-5 — tests for the Shopify per-line COGS posting service.
//
// Coverage:
//   - centsToDecimal helper (whole, fractional, padding, negative, zero)
//   - resolveCogsAccounts: 5000/1300 happy path + missing codes
//   - buildCogsJePayload: line ordering, subledger tags, balance, null on zero
//   - postShopifyOrderCogs end-to-end:
//       * idempotent already_posted short-circuit (cogs_je_id set)
//       * not_found (no row)
//       * no_cogs / no_eligible_lines (no lines with ip_item_master_id)
//       * no_cogs / zero_aggregate_cogs (FIFO returned 0 for every line)
//       * gl_accounts_missing (5000 / 1300 absent)
//       * fifo_consume_failed (every line errored from FIFO)
//       * partial post (one line ok, one line errored → still posts ok)
//       * rpc_failed (gl_post_journal_entry RPC error)
//       * shopify_orders_update_failed (cogs_je_id stamp errored)
//       * line cogs_cents back-write best-effort failure absorbed
//       * skips lines without ip_item_master_id
//       * skips lines with quantity=0

import { describe, it, expect, vi } from "vitest";
import {
  postShopifyOrderCogs,
  resolveCogsAccounts,
  buildCogsJePayload,
  centsToDecimal,
} from "../post-order-cogs.js";

// ──────────────────────────────────────────────────────────────────────
// Test fixtures
// ──────────────────────────────────────────────────────────────────────

const ENTITY      = "11111111-1111-1111-1111-111111111111";
const ORDER       = "22222222-2222-2222-2222-222222222222";
const STORE       = "33333333-3333-3333-3333-333333333333";
const COGS_ACCT   = "55555555-5555-5555-5555-555555555555";
const INV_ACCT    = "66666666-6666-6666-6666-666666666666";
const JE_ID       = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ITEM_A      = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const ITEM_B      = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const LINE_A      = "ee111111-ee11-ee11-ee11-ee1111111111";
const LINE_B      = "ee222222-ee22-ee22-ee22-ee2222222222";

function makeOrder(overrides = {}) {
  return {
    id: ORDER,
    entity_id: ENTITY,
    shopify_store_id: STORE,
    shopify_order_id: "9001",
    order_number: "#1001",
    processed_at: "2026-05-28T12:34:56Z",
    je_id: JE_ID,
    cogs_je_id: null,
    ...overrides,
  };
}

function makeAccounts(overrides = {}) {
  return {
    cogsId: COGS_ACCT,
    inventoryId: INV_ACCT,
    ...overrides,
  };
}

function makeLines(overrides) {
  return overrides || [
    {
      id: LINE_A,
      line_number: 1,
      sku: "SKU-A",
      ip_item_master_id: ITEM_A,
      quantity: 2,
    },
    {
      id: LINE_B,
      line_number: 2,
      sku: "SKU-B",
      ip_item_master_id: ITEM_B,
      quantity: 1,
    },
  ];
}

/**
 * Build a flexible chainable Supabase mock parameterized by the test inputs.
 */
function makeSupabaseMock({
  order = makeOrder(),
  lines = makeLines(),
  linesError = null,
  accountRows = [
    { code: "5000", id: COGS_ACCT },
    { code: "1300", id: INV_ACCT },
  ],
  rpcResult = JE_ID,
  rpcError = null,
  shopifyOrdersUpdateError = null,
  linesUpdateError = null,
} = {}) {
  const calls = {
    rpc: [],
    shopifyOrdersUpdate: [],
    linesUpdate: [],
  };

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
                return { error: shopifyOrdersUpdateError };
              },
            };
          },
        };
      }
      if (table === "shopify_order_lines") {
        return {
          select() {
            return {
              eq: async () => ({ data: lines, error: linesError }),
            };
          },
          update(patch) {
            return {
              eq: async (col, val) => {
                calls.linesUpdate.push({ patch, col, val });
                return { error: linesUpdateError };
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
// resolveCogsAccounts
// ──────────────────────────────────────────────────────────────────────

describe("resolveCogsAccounts", () => {
  it("returns the 5000 + 1300 ids when both exist", async () => {
    const { sb } = makeSupabaseMock();
    const r = await resolveCogsAccounts(sb, ENTITY);
    expect(r).toEqual({ cogsId: COGS_ACCT, inventoryId: INV_ACCT });
  });
  it("returns null when 5000 is missing", async () => {
    const { sb } = makeSupabaseMock({
      accountRows: [{ code: "1300", id: INV_ACCT }],
    });
    const r = await resolveCogsAccounts(sb, ENTITY);
    expect(r.cogsId).toBeNull();
    expect(r.inventoryId).toBe(INV_ACCT);
  });
  it("returns null when 1300 is missing", async () => {
    const { sb } = makeSupabaseMock({
      accountRows: [{ code: "5000", id: COGS_ACCT }],
    });
    const r = await resolveCogsAccounts(sb, ENTITY);
    expect(r.cogsId).toBe(COGS_ACCT);
    expect(r.inventoryId).toBeNull();
  });
  it("returns nulls when neither exists", async () => {
    const { sb } = makeSupabaseMock({ accountRows: [] });
    const r = await resolveCogsAccounts(sb, ENTITY);
    expect(r).toEqual({ cogsId: null, inventoryId: null });
  });
  it("throws when the supabase query errors", async () => {
    const sb = {
      from() {
        return {
          select() {
            return {
              eq() {
                return {
                  in: () =>
                    Promise.resolve({ data: null, error: { message: "db down" } }),
                };
              },
            };
          },
        };
      },
    };
    await expect(resolveCogsAccounts(sb, ENTITY)).rejects.toThrow(/db down/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// buildCogsJePayload
// ──────────────────────────────────────────────────────────────────────

describe("buildCogsJePayload", () => {
  it("builds a balanced JE with per-line DR + aggregated CR", () => {
    const payload = buildCogsJePayload({
      order: makeOrder(),
      accounts: makeAccounts(),
      consumed: [
        { line_id: LINE_A, ip_item_master_id: ITEM_A, sku: "SKU-A", quantity: 2, cogs_cents: 2500n },
        { line_id: LINE_B, ip_item_master_id: ITEM_B, sku: "SKU-B", quantity: 1, cogs_cents: 1500n },
      ],
    });
    expect(payload).not.toBeNull();
    expect(payload.lines).toHaveLength(3); // 2 DR + 1 aggregated CR
    // First DR
    expect(payload.lines[0]).toMatchObject({
      account_id: COGS_ACCT,
      debit: "25.00",
      credit: "0",
      subledger_type: "item",
      subledger_id: ITEM_A,
    });
    // Second DR
    expect(payload.lines[1]).toMatchObject({
      account_id: COGS_ACCT,
      debit: "15.00",
      credit: "0",
      subledger_type: "item",
      subledger_id: ITEM_B,
    });
    // Aggregated CR (total = 40.00)
    expect(payload.lines[2]).toMatchObject({
      account_id: INV_ACCT,
      debit: "0",
      credit: "40.00",
      subledger_type: null,
      subledger_id: null,
    });
  });

  it("returns null when total cogs_cents is zero", () => {
    const payload = buildCogsJePayload({
      order: makeOrder(),
      accounts: makeAccounts(),
      consumed: [
        { line_id: LINE_A, ip_item_master_id: ITEM_A, sku: "SKU-A", quantity: 2, cogs_cents: 0n },
        { line_id: LINE_B, ip_item_master_id: ITEM_B, sku: "SKU-B", quantity: 1, cogs_cents: 0n },
      ],
    });
    expect(payload).toBeNull();
  });

  it("excludes lines with zero cogs from the DR side", () => {
    const payload = buildCogsJePayload({
      order: makeOrder(),
      accounts: makeAccounts(),
      consumed: [
        { line_id: LINE_A, ip_item_master_id: ITEM_A, sku: "SKU-A", quantity: 2, cogs_cents: 2500n },
        { line_id: LINE_B, ip_item_master_id: ITEM_B, sku: "SKU-B", quantity: 1, cogs_cents: 0n },
      ],
    });
    expect(payload.lines).toHaveLength(2); // 1 DR + 1 CR
    expect(payload.lines[0].debit).toBe("25.00");
    expect(payload.lines[1].credit).toBe("25.00");
  });

  it("stamps source_module/table/id correctly", () => {
    const payload = buildCogsJePayload({
      order: makeOrder({ shopify_order_id: "9999", order_number: "#2002" }),
      accounts: makeAccounts(),
      consumed: [
        { line_id: LINE_A, ip_item_master_id: ITEM_A, sku: "SKU-A", quantity: 1, cogs_cents: 100n },
      ],
    });
    expect(payload.source_module).toBe("shopify");
    expect(payload.source_table).toBe("shopify_orders");
    expect(payload.source_id).toBe(ORDER);
    expect(payload.journal_type).toBe("ar_invoice_cogs");
    expect(payload.description).toMatch(/#2002/);
  });

  it("links sibling_je_id to the AR JE", () => {
    const payload = buildCogsJePayload({
      order: makeOrder({ je_id: JE_ID }),
      accounts: makeAccounts(),
      consumed: [
        { line_id: LINE_A, ip_item_master_id: ITEM_A, sku: "SKU-A", quantity: 1, cogs_cents: 100n },
      ],
    });
    expect(payload.sibling_je_id).toBe(JE_ID);
  });

  it("omits SKU from memo when sku is null", () => {
    const payload = buildCogsJePayload({
      order: makeOrder(),
      accounts: makeAccounts(),
      consumed: [
        { line_id: LINE_A, ip_item_master_id: ITEM_A, sku: null, quantity: 1, cogs_cents: 100n },
      ],
    });
    expect(payload.lines[0].memo).not.toMatch(/—/);
  });

  it("uses processed_at for posting_date", () => {
    const payload = buildCogsJePayload({
      order: makeOrder({ processed_at: "2026-04-15T08:00:00Z" }),
      accounts: makeAccounts(),
      consumed: [
        { line_id: LINE_A, ip_item_master_id: ITEM_A, sku: "SKU-A", quantity: 1, cogs_cents: 100n },
      ],
    });
    expect(payload.posting_date).toBe("2026-04-15");
  });

  it("balances DR sum = CR sum exactly", () => {
    const payload = buildCogsJePayload({
      order: makeOrder(),
      accounts: makeAccounts(),
      consumed: [
        { line_id: LINE_A, ip_item_master_id: ITEM_A, sku: "SKU-A", quantity: 2, cogs_cents: 1234n },
        { line_id: LINE_B, ip_item_master_id: ITEM_B, sku: "SKU-B", quantity: 1, cogs_cents: 5678n },
      ],
    });
    let drSum = 0n;
    let crSum = 0n;
    for (const l of payload.lines) {
      const dr = BigInt(Math.round(Number(l.debit) * 100));
      const cr = BigInt(Math.round(Number(l.credit) * 100));
      drSum += dr;
      crSum += cr;
    }
    expect(drSum).toBe(crSum);
    expect(drSum).toBe(1234n + 5678n);
  });
});

// ──────────────────────────────────────────────────────────────────────
// postShopifyOrderCogs — end-to-end
// ──────────────────────────────────────────────────────────────────────

describe("postShopifyOrderCogs", () => {
  it("rejects bad uuid", async () => {
    await expect(
      postShopifyOrderCogs({ shopifyOrderId: "not-uuid", adminClient: {} }),
    ).rejects.toThrow(/uuid/);
  });

  it("rejects when adminClient is missing", async () => {
    await expect(
      postShopifyOrderCogs({ shopifyOrderId: ORDER, adminClient: null }),
    ).rejects.toThrow(/Supabase/);
  });

  it("short-circuits with already_posted when cogs_je_id is set", async () => {
    const { sb } = makeSupabaseMock({
      order: makeOrder({ cogs_je_id: JE_ID }),
    });
    const r = await postShopifyOrderCogs({
      shopifyOrderId: ORDER,
      adminClient: sb,
      deps: { consumeFifo: vi.fn() },
    });
    expect(r).toEqual({ status: "already_posted", je_id: JE_ID });
  });

  it("throws not_found when shopify_orders row is missing", async () => {
    const sb = {
      from(table) {
        if (table === "shopify_orders") {
          return {
            select() {
              return {
                eq() {
                  return {
                    maybeSingle: async () => ({ data: null, error: null }),
                  };
                },
              };
            },
          };
        }
        throw new Error("unexpected");
      },
    };
    await expect(
      postShopifyOrderCogs({
        shopifyOrderId: ORDER,
        adminClient: sb,
        deps: { consumeFifo: vi.fn() },
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("returns no_cogs / no_eligible_lines when no lines have ip_item_master_id", async () => {
    const { sb } = makeSupabaseMock({
      lines: [
        { id: LINE_A, line_number: 1, sku: "SKU-A", ip_item_master_id: null, quantity: 2 },
        { id: LINE_B, line_number: 2, sku: "SKU-B", ip_item_master_id: null, quantity: 1 },
      ],
    });
    const consumeFifo = vi.fn();
    const r = await postShopifyOrderCogs({
      shopifyOrderId: ORDER,
      adminClient: sb,
      deps: { consumeFifo },
    });
    expect(r.status).toBe("no_cogs");
    expect(r.reason).toBe("no_eligible_lines");
    expect(consumeFifo).not.toHaveBeenCalled();
  });

  it("returns no_cogs / no_eligible_lines when all lines have quantity=0", async () => {
    const { sb } = makeSupabaseMock({
      lines: [
        { id: LINE_A, line_number: 1, sku: "SKU-A", ip_item_master_id: ITEM_A, quantity: 0 },
      ],
    });
    const consumeFifo = vi.fn();
    const r = await postShopifyOrderCogs({
      shopifyOrderId: ORDER,
      adminClient: sb,
      deps: { consumeFifo },
    });
    expect(r.status).toBe("no_cogs");
    expect(consumeFifo).not.toHaveBeenCalled();
  });

  it("throws gl_accounts_missing when 5000 is absent", async () => {
    const { sb } = makeSupabaseMock({
      accountRows: [{ code: "1300", id: INV_ACCT }],
    });
    await expect(
      postShopifyOrderCogs({
        shopifyOrderId: ORDER,
        adminClient: sb,
        deps: { consumeFifo: vi.fn() },
      }),
    ).rejects.toMatchObject({ code: "gl_accounts_missing" });
  });

  it("throws gl_accounts_missing when 1300 is absent", async () => {
    const { sb } = makeSupabaseMock({
      accountRows: [{ code: "5000", id: COGS_ACCT }],
    });
    await expect(
      postShopifyOrderCogs({
        shopifyOrderId: ORDER,
        adminClient: sb,
        deps: { consumeFifo: vi.fn() },
      }),
    ).rejects.toMatchObject({ code: "gl_accounts_missing" });
  });

  it("throws fifo_consume_failed when every line errored", async () => {
    const { sb } = makeSupabaseMock();
    const consumeFifo = vi.fn().mockRejectedValue(
      Object.assign(new Error("insufficient inventory"), { code: "insufficient_inventory" }),
    );
    await expect(
      postShopifyOrderCogs({
        shopifyOrderId: ORDER,
        adminClient: sb,
        deps: { consumeFifo },
      }),
    ).rejects.toMatchObject({
      code: "fifo_consume_failed",
    });
  });

  it("posts a partial JE when one line succeeds and one errors", async () => {
    const { sb, calls } = makeSupabaseMock();
    let n = 0;
    const consumeFifo = vi.fn().mockImplementation(async (_c, args) => {
      n += 1;
      if (n === 1) return { cogs_cents: 2500n };
      throw Object.assign(new Error("insufficient inventory"), {
        code: "insufficient_inventory",
      });
    });
    const r = await postShopifyOrderCogs({
      shopifyOrderId: ORDER,
      adminClient: sb,
      deps: { consumeFifo },
    });
    expect(r.status).toBe("posted");
    expect(r.je_id).toBe(JE_ID);
    expect(r.lines).toBe(1);
    expect(r.line_errors).toHaveLength(1);
    expect(r.line_errors[0]).toMatchObject({ sku: "SKU-B" });
    // RPC called once with the partial payload
    expect(calls.rpc).toHaveLength(1);
    expect(calls.rpc[0].name).toBe("gl_post_journal_entry");
  });

  it("returns no_cogs / zero_aggregate_cogs when every line returns 0n", async () => {
    const { sb, calls } = makeSupabaseMock();
    const consumeFifo = vi.fn().mockResolvedValue({ cogs_cents: 0n });
    const r = await postShopifyOrderCogs({
      shopifyOrderId: ORDER,
      adminClient: sb,
      deps: { consumeFifo },
    });
    expect(r.status).toBe("no_cogs");
    expect(r.reason).toBe("zero_aggregate_cogs");
    expect(calls.rpc).toHaveLength(0);
    // shopify_orders.cogs_je_id should NOT be stamped on this path
    expect(calls.shopifyOrdersUpdate).toHaveLength(0);
  });

  it("posts and stamps cogs_je_id on the happy path", async () => {
    const { sb, calls } = makeSupabaseMock();
    const consumeFifo = vi.fn().mockResolvedValue({ cogs_cents: 1500n });
    const r = await postShopifyOrderCogs({
      shopifyOrderId: ORDER,
      adminClient: sb,
      deps: { consumeFifo },
    });
    expect(r.status).toBe("posted");
    expect(r.je_id).toBe(JE_ID);
    expect(r.cogs_cents).toBe("3000"); // 1500 * 2 lines
    expect(r.lines).toBe(2);
    expect(consumeFifo).toHaveBeenCalledTimes(2);
    expect(calls.shopifyOrdersUpdate.length).toBeGreaterThanOrEqual(1);
    expect(calls.shopifyOrdersUpdate[0].patch).toEqual({ cogs_je_id: JE_ID });
  });

  it("passes the correct consumer_kind + consumer_ref_id to consume()", async () => {
    const { sb } = makeSupabaseMock();
    const consumeFifo = vi.fn().mockResolvedValue({ cogs_cents: 100n });
    await postShopifyOrderCogs({
      shopifyOrderId: ORDER,
      adminClient: sb,
      deps: { consumeFifo },
    });
    expect(consumeFifo).toHaveBeenCalledWith(
      sb,
      expect.objectContaining({
        entity_id: ENTITY,
        item_id: ITEM_A,
        qty: 2,
        consumer_kind: "ar_invoice",
        consumer_ref_id: LINE_A,
      }),
    );
  });

  it("throws rpc_failed when gl_post_journal_entry errors", async () => {
    const { sb } = makeSupabaseMock({
      rpcResult: null,
      rpcError: { message: "period locked" },
    });
    const consumeFifo = vi.fn().mockResolvedValue({ cogs_cents: 100n });
    await expect(
      postShopifyOrderCogs({
        shopifyOrderId: ORDER,
        adminClient: sb,
        deps: { consumeFifo },
      }),
    ).rejects.toMatchObject({ code: "rpc_failed" });
  });

  it("throws shopify_orders_update_failed when cogs_je_id stamp errors", async () => {
    const { sb } = makeSupabaseMock({
      shopifyOrdersUpdateError: { message: "constraint x" },
    });
    const consumeFifo = vi.fn().mockResolvedValue({ cogs_cents: 100n });
    await expect(
      postShopifyOrderCogs({
        shopifyOrderId: ORDER,
        adminClient: sb,
        deps: { consumeFifo },
      }),
    ).rejects.toMatchObject({
      code: "shopify_orders_update_failed",
      je_id: JE_ID,
    });
  });

  it("absorbs back-write failure on shopify_order_lines.cogs_cents", async () => {
    const { sb } = makeSupabaseMock({
      linesUpdateError: { message: "column does not exist" },
    });
    const consumeFifo = vi.fn().mockResolvedValue({ cogs_cents: 100n });
    const r = await postShopifyOrderCogs({
      shopifyOrderId: ORDER,
      adminClient: sb,
      deps: { consumeFifo },
    });
    expect(r.status).toBe("posted");
    expect(r.line_cogs_backwrite_skipped).toBe(true);
  });

  it("throws on lines lookup error", async () => {
    const { sb } = makeSupabaseMock({
      linesError: { message: "db error" },
    });
    const consumeFifo = vi.fn();
    await expect(
      postShopifyOrderCogs({
        shopifyOrderId: ORDER,
        adminClient: sb,
        deps: { consumeFifo },
      }),
    ).rejects.toThrow(/db error/);
  });

  it("uses the default fifo consume when no dep injected", async () => {
    // We can't run the real consume against a mock RPC without exposing it.
    // Just assert the function still completes the early no_cogs path
    // without ever calling the real consume.
    const { sb } = makeSupabaseMock({
      lines: [],
    });
    const r = await postShopifyOrderCogs({
      shopifyOrderId: ORDER,
      adminClient: sb,
    });
    expect(r.status).toBe("no_cogs");
  });

  it("skips lines with null ip_item_master_id and only consumes resolved ones", async () => {
    const { sb } = makeSupabaseMock({
      lines: [
        { id: LINE_A, line_number: 1, sku: "SKU-A", ip_item_master_id: null,  quantity: 2 },
        { id: LINE_B, line_number: 2, sku: "SKU-B", ip_item_master_id: ITEM_B, quantity: 1 },
      ],
    });
    const consumeFifo = vi.fn().mockResolvedValue({ cogs_cents: 100n });
    const r = await postShopifyOrderCogs({
      shopifyOrderId: ORDER,
      adminClient: sb,
      deps: { consumeFifo },
    });
    expect(r.status).toBe("posted");
    expect(r.lines).toBe(1);
    expect(consumeFifo).toHaveBeenCalledTimes(1);
    expect(consumeFifo.mock.calls[0][1].item_id).toBe(ITEM_B);
  });

  it("uses sibling_je_id from the order's AR je_id", async () => {
    const { sb, calls } = makeSupabaseMock({
      order: makeOrder({ je_id: JE_ID }),
    });
    const consumeFifo = vi.fn().mockResolvedValue({ cogs_cents: 100n });
    await postShopifyOrderCogs({
      shopifyOrderId: ORDER,
      adminClient: sb,
      deps: { consumeFifo },
    });
    expect(calls.rpc[0].args.payload.sibling_je_id).toBe(JE_ID);
  });

  it("idempotency: short-circuits with existing cogs_je_id even when other inputs change", async () => {
    const { sb, calls } = makeSupabaseMock({
      order: makeOrder({ cogs_je_id: JE_ID }),
    });
    const consumeFifo = vi.fn();
    const r = await postShopifyOrderCogs({
      shopifyOrderId: ORDER,
      adminClient: sb,
      deps: { consumeFifo },
    });
    expect(r).toEqual({ status: "already_posted", je_id: JE_ID });
    expect(consumeFifo).not.toHaveBeenCalled();
    expect(calls.rpc).toHaveLength(0);
    expect(calls.shopifyOrdersUpdate).toHaveLength(0);
  });

  it("produces a balanced JE payload (drSum === crSum)", async () => {
    const { sb, calls } = makeSupabaseMock();
    let n = 0;
    const consumeFifo = vi.fn().mockImplementation(async () => {
      n += 1;
      return { cogs_cents: n === 1 ? 1234n : 5678n };
    });
    await postShopifyOrderCogs({
      shopifyOrderId: ORDER,
      adminClient: sb,
      deps: { consumeFifo },
    });
    const payload = calls.rpc[0].args.payload;
    let drSum = 0n;
    let crSum = 0n;
    for (const l of payload.lines) {
      const dr = BigInt(Math.round(Number(l.debit) * 100));
      const cr = BigInt(Math.round(Number(l.credit) * 100));
      drSum += dr;
      crSum += cr;
    }
    expect(drSum).toBe(crSum);
    expect(drSum).toBe(1234n + 5678n);
  });

  it("aggregates the CR Inventory line into a single line", async () => {
    const { sb, calls } = makeSupabaseMock();
    const consumeFifo = vi.fn().mockResolvedValue({ cogs_cents: 100n });
    await postShopifyOrderCogs({
      shopifyOrderId: ORDER,
      adminClient: sb,
      deps: { consumeFifo },
    });
    const payload = calls.rpc[0].args.payload;
    const crLines = payload.lines.filter(
      (l) => Number(l.credit) > 0 && l.account_id === INV_ACCT,
    );
    expect(crLines).toHaveLength(1);
    expect(crLines[0].credit).toBe("2.00"); // 100 + 100 cents
  });

  it("tags subledger_type='item' on each DR COGS line", async () => {
    const { sb, calls } = makeSupabaseMock();
    const consumeFifo = vi.fn().mockResolvedValue({ cogs_cents: 100n });
    await postShopifyOrderCogs({
      shopifyOrderId: ORDER,
      adminClient: sb,
      deps: { consumeFifo },
    });
    const payload = calls.rpc[0].args.payload;
    const drLines = payload.lines.filter((l) => Number(l.debit) > 0);
    expect(drLines.length).toBe(2);
    for (const l of drLines) {
      expect(l.subledger_type).toBe("item");
      expect(l.subledger_id).toMatch(/^[0-9a-f-]+$/);
    }
  });
});
