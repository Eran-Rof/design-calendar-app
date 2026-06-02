// Tests for Tangerine P4-3 — FIFO ↔ AR integration at send time.
//
// The wiring lives in:
//   1. api/_lib/accounting/posting/index.js — postEvent's consumePlan drain
//      now supports INDEXED mode (multi-line candidates with dr_line_ix /
//      cr_line_ix on each plan entry). Zero-cogs entries drop their sentinel
//      lines cleanly.
//   2. api/_lib/inventory/fifo.js — the consume() wrapper now documents
//      consumer_kind='ar_invoice' with consumer_ref_id pointing at
//      ar_invoice_lines.id, and carries a TODO for P4-8's layer_cutoff_date.
//
// The arInvoiceSent.js rule body itself is owned by P4-2 (parallel chunk).
// These tests use a synthetic stand-in rule registered into the dispatcher
// so we exercise the integration layer without coupling to P4-2's choices.
//
// Test count target: 15+ covering happy path, multi-line, insufficient
// inventory, no-inventory short-circuit, zero-cogs sentinel drop, bypass
// pass-through, mode detection, and edge cases.

import { describe, it, expect, vi, afterEach } from "vitest";

// Hoisted state shared between the mocked rule module and the tests.
// Each test sets `__syntheticOutput` to the desired ruleOutput shape; the
// mocked arInvoiceSent rule returns it directly. This lets us exercise the
// indexed consumePlan drain WITHOUT depending on P4-2's actual rule body.
const { __syntheticState } = vi.hoisted(() => ({
  __syntheticState: { output: null },
}));

vi.mock("../accounting/posting/rules/arInvoiceSent.js", () => ({
  arInvoiceSent: (_event) => {
    if (__syntheticState.output == null) {
      throw new Error("test mock: __syntheticState.output not set");
    }
    return __syntheticState.output;
  },
}));

import { postEvent } from "../accounting/posting/index.js";

const ENTITY    = "00000000-0000-0000-0000-000000000001";
const CUSTOMER  = "11111111-1111-1111-1111-111111111111";
const INVOICE   = "22222222-2222-2222-2222-222222222222";
const LINE_A_ID = "33333333-3333-3333-3333-333333333333";
const LINE_B_ID = "44444444-4444-4444-4444-444444444444";
const AR_ACC    = "55555555-5555-5555-5555-555555555555";
const REV_ACC   = "66666666-6666-6666-6666-666666666666";
const COGS_ACC  = "77777777-7777-7777-7777-777777777777";
const INV_ACC   = "88888888-8888-8888-8888-888888888888";
const ITEM_A    = "99999999-9999-9999-9999-999999999999";
const ITEM_B    = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER      = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const accounts = [
  { id: AR_ACC,   entity_id: ENTITY, status: "active", is_postable: true, is_control: true,  code: "1200", name: "Accounts Receivable" },
  { id: REV_ACC,  entity_id: ENTITY, status: "active", is_postable: true, is_control: false, code: "4000", name: "Revenue" },
  { id: COGS_ACC, entity_id: ENTITY, status: "active", is_postable: true, is_control: false, code: "5000", name: "COGS" },
  { id: INV_ACC,  entity_id: ENTITY, status: "active", is_postable: true, is_control: true,  code: "1300", name: "Inventory" },
];

// ════════════════════════════════════════════════════════════════════════════
// Synthetic rule registration — exercises the integration layer without
// depending on P4-2's arInvoiceSent.js body shape.
//
// Pattern: import the RULE_BY_KIND map indirectly by intercepting the kind
// dispatch. We can't mutate the imported map without a tiny test seam, so
// instead we author event payloads that already match what the rule WILL
// produce (a pre-built ruleOutput in event.data) and use a thin wrapper
// kind 'test_ar_invoice_sent' that produces the candidate directly.
//
// To do that without a code change we register a runtime kind via the
// module's exported helper... since the index.js doesn't expose that, we
// instead patch in a different way: we use vi.doMock on the rules module.
// But since module patching in vitest is fiddly here, we take the simpler
// route — call postEvent with the real 'ar_invoice_sent' kind and pass
// event data that the existing stub will fail to validate. THEN we use a
// secondary harness that bypasses the rule entirely by intercepting the
// internal consumePlan-drain via a freshly-built supabase mock and a
// synthetic event whose rule output we control.
//
// In practice the cleanest approach is to verify the drain behavior via the
// inventoryAdjustment kind (negative qty_delta is the existing
// consumer-kind='adjustment_decrease' path), AND to add a separate set of
// tests that drive the drain logic via a new test-only kind. Below we use
// the published API surface and verify the AR-relevant behaviors by:
//   - registering a synthetic rule using vi.mock on the rules dispatcher
//   - then calling postEvent on a custom event kind
// ════════════════════════════════════════════════════════════════════════════

// Build a "synthetic AR send" candidate that matches what the P4-2 rule
// WILL emit (per arch §4.1). Keep separate from production so this test
// remains immune to P4-2 wording changes.
function buildArSendOutput({
  inventoryLines = [],   // [{ ar_line_id, item_id, qty, revenue_amount }]
  nonInventoryLines = [], // [{ revenue_amount, revenue_account_id }]
  invoiceNumber = "AR-9001",
  invoiceDate = "2026-05-27",
} = {}) {
  const lines = [];
  let lineNumber = 1;
  const consumePlan = [];

  // Compute AR total = sum of all revenue line amounts (cents math via
  // numeric strings — keep it simple by using floats in test only).
  const totalRevenue = [
    ...inventoryLines.map((l) => Number(l.revenue_amount)),
    ...nonInventoryLines.map((l) => Number(l.revenue_amount)),
  ].reduce((a, b) => a + b, 0);

  // DR AR (the rule prepends, then renumbers — but the wire-shape after
  // renumber is line 1 = AR; lines 2..N = revenue + COGS sentinels)
  lines.push({
    line_number: lineNumber++,
    account_id: AR_ACC,
    debit: totalRevenue.toFixed(2),
    credit: "0",
    memo: `AR invoice ${invoiceNumber}`,
    subledger_type: "customer",
    subledger_id: CUSTOMER,
  });

  // Per-line revenue credits + per-inventory-line COGS sentinel pair.
  for (const ln of inventoryLines) {
    lines.push({
      line_number: lineNumber++,
      account_id: REV_ACC,
      debit: "0",
      credit: Number(ln.revenue_amount).toFixed(2),
      memo: `AR invoice ${invoiceNumber}`,
      subledger_type: null,
      subledger_id: null,
    });
    const drIx = lines.length;   // position AFTER push (becomes index drIx)
    lines.push({
      line_number: lineNumber++,
      account_id: COGS_ACC,
      debit: "0",        // sentinel
      credit: "0",
      memo: `COGS ${invoiceNumber}`,
      subledger_type: "item",
      subledger_id: ln.item_id,
    });
    const crIx = lines.length;
    lines.push({
      line_number: lineNumber++,
      account_id: INV_ACC,
      debit: "0",
      credit: "0",       // sentinel
      memo: `COGS ${invoiceNumber}`,
      subledger_type: "item",
      subledger_id: ln.item_id,
    });
    consumePlan.push({
      item_id: ln.item_id,
      qty: ln.qty,
      consumer_kind: "ar_invoice",
      consumer_ref_id: ln.ar_line_id,
      dr_line_ix: drIx,
      cr_line_ix: crIx,
      target_line_id: ln.ar_line_id,
    });
  }
  for (const ln of nonInventoryLines) {
    lines.push({
      line_number: lineNumber++,
      account_id: ln.revenue_account_id || REV_ACC,
      debit: "0",
      credit: Number(ln.revenue_amount).toFixed(2),
      memo: `AR invoice ${invoiceNumber}`,
      subledger_type: null,
      subledger_id: null,
    });
  }

  const base = {
    entity_id: ENTITY,
    journal_type: "ar_invoice",
    posting_date: invoiceDate,
    source_module: "ar",
    source_table: "ar_invoices",
    source_id: INVOICE,
    description: `AR invoice ${invoiceNumber}`,
    created_by_user_id: USER,
    lines,
  };

  return {
    accrual: { ...base, basis: "ACCRUAL", lines: lines.map((l) => ({ ...l })) },
    cash: null,
    consumePlan,
  };
}

// The synthetic ruleOutput is injected via __syntheticState (vi.hoisted'd at
// the top of the file). Each test sets it; the vi.mock'd rule returns it.
afterEach(() => {
  __syntheticState.output = null;
});

/**
 * Mock supabase capturing FIFO consume calls + JE persist payloads.
 */
function mockSupabase({
  // Map of item_id → cogs_cents (bigint) returned by consume RPC.
  consumeReturnsByItem = {},
  // Fallback when item not in the map.
  consumeDefault = 0n,
  consumeImpl = null,
  glAccounts = accounts,
  period = { id: "p1", status: "open", starts_on: "2026-05-01", ends_on: "2026-05-31" },
  entity = { posting_locked_through: null },
} = {}) {
  const persistedPayloads = [];
  const consumeCalls = [];
  let jeSeq = 0;

  const rpc = vi.fn().mockImplementation(async (fnName, args) => {
    if (fnName === "gl_post_journal_entry") {
      persistedPayloads.push(args?.payload);
      return { data: `je-${++jeSeq}`, error: null };
    }
    if (fnName === "gl_link_sibling_je") {
      return { data: null, error: null };
    }
    if (fnName === "inventory_fifo_consume") {
      consumeCalls.push(args);
      if (consumeImpl) {
        const out = await consumeImpl(args);
        if (out) return out;
      }
      const cogs = consumeReturnsByItem[args.p_item_id] ?? consumeDefault;
      return { data: cogs.toString(), error: null };
    }
    return { data: null, error: { message: `unexpected rpc ${fnName}` } };
  });

  const from = (table) => {
    if (table === "gl_accounts") {
      const filter = { ids: null };
      const builder = {
        select() { return this; },
        in(_col, ids) { filter.ids = ids; return this; },
      };
      return new Proxy(builder, {
        get(target, prop) {
          if (prop === "then") {
            return (resolve) => resolve({
              data: glAccounts.filter((a) => filter.ids == null || filter.ids.includes(a.id)),
              error: null,
            });
          }
          return target[prop];
        },
      });
    }
    if (table === "gl_periods") {
      return {
        select() { return this; },
        eq() { return this; },
        lte() { return this; },
        gte() { return this; },
        limit() { return this; },
        async maybeSingle() { return { data: period, error: null }; },
      };
    }
    if (table === "entities") {
      return {
        select() { return this; },
        eq() { return this; },
        async maybeSingle() { return { data: entity, error: null }; },
      };
    }
    if (table === "inventory_layers") {
      let rowsToInsert = null;
      return {
        insert(rows) { rowsToInsert = Array.isArray(rows) ? rows : [rows]; return this; },
        select() { return this; },
        async single() {
          return { data: { id: "layer-unused", ...rowsToInsert[0] }, error: null };
        },
      };
    }
    throw new Error(`unexpected table ${table}`);
  };

  return { from, rpc, persistedPayloads, consumeCalls };
}

function arSendEvent(syntheticOutput) {
  __syntheticState.output = syntheticOutput;
  return {
    kind: "ar_invoice_sent",
    entity_id: ENTITY,
    created_by_user_id: USER,
    data: {},
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Indexed consumePlan drain — happy paths
// ════════════════════════════════════════════════════════════════════════════
describe("postEvent ar_invoice_sent — indexed consumePlan drain", () => {
  it("single inventory line: consume() called once with consumer_kind=ar_invoice + per-line ref id", async () => {
    const supabase = mockSupabase({ consumeReturnsByItem: { [ITEM_A]: 1500n } });
    const out = buildArSendOutput({
      inventoryLines: [{ ar_line_id: LINE_A_ID, item_id: ITEM_A, qty: 3, revenue_amount: "30.00" }],
    });

    const result = await postEvent(supabase, arSendEvent(out));

    expect(supabase.consumeCalls).toHaveLength(1);
    expect(supabase.consumeCalls[0]).toMatchObject({
      p_entity_id: ENTITY,
      p_item_id: ITEM_A,
      p_qty: 3,
      p_consumer_kind: "ar_invoice",
      p_consumer_ref_id: LINE_A_ID,  // points at ar_invoice_lines.id, not ar_invoices.id
    });
    expect(result.accrual_je_id).toBeTruthy();
  });

  it("rewrites the COGS sentinel pair with cogs_cents returned by consume()", async () => {
    const supabase = mockSupabase({ consumeReturnsByItem: { [ITEM_A]: 1500n } }); // $15.00
    const out = buildArSendOutput({
      inventoryLines: [{ ar_line_id: LINE_A_ID, item_id: ITEM_A, qty: 3, revenue_amount: "30.00" }],
    });
    await postEvent(supabase, arSendEvent(out));

    const payload = supabase.persistedPayloads[0];
    // line 1 = DR AR; line 2 = CR revenue; line 3 = DR COGS; line 4 = CR inventory
    expect(payload.lines).toHaveLength(4);
    expect(payload.lines[0].account_id).toBe(AR_ACC);
    expect(payload.lines[0].debit).toBe("30.00");
    expect(payload.lines[1].account_id).toBe(REV_ACC);
    expect(payload.lines[1].credit).toBe("30.00");
    expect(payload.lines[2].account_id).toBe(COGS_ACC);
    expect(payload.lines[2].debit).toBe("15.00");  // rewritten from "0"
    expect(payload.lines[3].account_id).toBe(INV_ACC);
    expect(payload.lines[3].credit).toBe("15.00"); // rewritten from "0"
  });

  it("multi-inventory: per-item consume() calls with per-line cogs accumulating", async () => {
    const supabase = mockSupabase({
      consumeReturnsByItem: { [ITEM_A]: 1500n, [ITEM_B]: 800n },
    });
    const out = buildArSendOutput({
      inventoryLines: [
        { ar_line_id: LINE_A_ID, item_id: ITEM_A, qty: 3, revenue_amount: "30.00" },
        { ar_line_id: LINE_B_ID, item_id: ITEM_B, qty: 2, revenue_amount: "20.00" },
      ],
    });
    const result = await postEvent(supabase, arSendEvent(out));

    expect(supabase.consumeCalls).toHaveLength(2);
    expect(result.consume_results).toHaveLength(2);
    expect(result.consume_results[0]).toMatchObject({
      item_id: ITEM_A, qty: 3, cogs_cents: "1500", target_line_id: LINE_A_ID,
    });
    expect(result.consume_results[1]).toMatchObject({
      item_id: ITEM_B, qty: 2, cogs_cents: "800", target_line_id: LINE_B_ID,
    });
  });

  it("multi-inventory: each line's COGS sentinel pair rewritten with its OWN cogs (not summed)", async () => {
    const supabase = mockSupabase({
      consumeReturnsByItem: { [ITEM_A]: 1500n, [ITEM_B]: 800n },
    });
    const out = buildArSendOutput({
      inventoryLines: [
        { ar_line_id: LINE_A_ID, item_id: ITEM_A, qty: 3, revenue_amount: "30.00" },
        { ar_line_id: LINE_B_ID, item_id: ITEM_B, qty: 2, revenue_amount: "20.00" },
      ],
    });
    await postEvent(supabase, arSendEvent(out));

    const payload = supabase.persistedPayloads[0];
    // line 1 = DR AR (50.00); line 2 = CR rev (30.00); line 3 = DR COGS A;
    // line 4 = CR inv A; line 5 = CR rev (20.00); line 6 = DR COGS B; line 7 = CR inv B
    expect(payload.lines).toHaveLength(7);
    expect(payload.lines[0].debit).toBe("50.00"); // AR total
    expect(payload.lines[2].account_id).toBe(COGS_ACC);
    expect(payload.lines[2].debit).toBe("15.00");
    expect(payload.lines[3].credit).toBe("15.00");
    expect(payload.lines[5].account_id).toBe(COGS_ACC);
    expect(payload.lines[5].debit).toBe("8.00");  // ITEM_B, not summed
    expect(payload.lines[6].credit).toBe("8.00");
  });

  it("mixed inventory + non-inventory lines: only inventory lines drive consume()", async () => {
    const supabase = mockSupabase({ consumeReturnsByItem: { [ITEM_A]: 1500n } });
    const out = buildArSendOutput({
      inventoryLines: [{ ar_line_id: LINE_A_ID, item_id: ITEM_A, qty: 3, revenue_amount: "30.00" }],
      nonInventoryLines: [{ revenue_amount: "50.00", revenue_account_id: REV_ACC }],
    });
    const result = await postEvent(supabase, arSendEvent(out));

    expect(supabase.consumeCalls).toHaveLength(1);
    expect(supabase.consumeCalls[0].p_item_id).toBe(ITEM_A);

    const payload = supabase.persistedPayloads[0];
    // AR (80.00) + rev for ITEM_A (30.00) + COGS pair + non-inv rev (50.00)
    expect(payload.lines[0].debit).toBe("80.00");
    expect(payload.lines[2].debit).toBe("15.00"); // COGS
  });

  it("non-inventory-only invoice: no consumePlan → no consume() calls", async () => {
    const supabase = mockSupabase();
    const out = buildArSendOutput({
      nonInventoryLines: [{ revenue_amount: "100.00", revenue_account_id: REV_ACC }],
    });
    expect(out.consumePlan).toHaveLength(0);

    const result = await postEvent(supabase, arSendEvent(out));

    expect(supabase.consumeCalls).toHaveLength(0);
    expect(result.consume_results).toBeUndefined();
    expect(result.accrual_je_id).toBeTruthy();
  });

  it("consume() runs BEFORE persist (rpc call order)", async () => {
    const supabase = mockSupabase({ consumeReturnsByItem: { [ITEM_A]: 1000n } });
    const out = buildArSendOutput({
      inventoryLines: [{ ar_line_id: LINE_A_ID, item_id: ITEM_A, qty: 1, revenue_amount: "10.00" }],
    });
    await postEvent(supabase, arSendEvent(out));

    const order = supabase.rpc.mock.calls.map((c) => c[0]);
    const consumeIdx = order.indexOf("inventory_fifo_consume");
    const postIdx = order.indexOf("gl_post_journal_entry");
    expect(consumeIdx).toBeGreaterThanOrEqual(0);
    expect(postIdx).toBeGreaterThan(consumeIdx);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Insufficient inventory — error propagation
// ════════════════════════════════════════════════════════════════════════════
describe("postEvent ar_invoice_sent — insufficient inventory", () => {
  it("propagates insufficient_inventory error from RPC; JE NOT persisted", async () => {
    const supabase = mockSupabase({
      consumeImpl: async () => ({
        data: null,
        error: { message: "Insufficient inventory for item " + ITEM_A + " (short by 2 units)" },
      }),
    });
    const out = buildArSendOutput({
      inventoryLines: [{ ar_line_id: LINE_A_ID, item_id: ITEM_A, qty: 5, revenue_amount: "50.00" }],
    });

    await expect(postEvent(supabase, arSendEvent(out)))
      .rejects.toThrow(/Insufficient inventory|insufficient/i);

    // No persist call happened
    expect(supabase.persistedPayloads).toHaveLength(0);
  });

  it("partial-multi: first item ok + second item insufficient → JE NOT persisted; first consume STILL committed at DB layer", async () => {
    let n = 0;
    const supabase = mockSupabase({
      consumeImpl: async (args) => {
        n += 1;
        if (n === 2) {
          return { data: null, error: { message: "Insufficient inventory for " + args.p_item_id } };
        }
        return null; // fall through to default
      },
      consumeReturnsByItem: { [ITEM_A]: 1500n },
    });
    const out = buildArSendOutput({
      inventoryLines: [
        { ar_line_id: LINE_A_ID, item_id: ITEM_A, qty: 3, revenue_amount: "30.00" },
        { ar_line_id: LINE_B_ID, item_id: ITEM_B, qty: 99, revenue_amount: "9.99" },
      ],
    });

    await expect(postEvent(supabase, arSendEvent(out)))
      .rejects.toThrow(/insufficient/i);

    // First consume DID run; this is the accepted FIFO-leads-GL asymmetry.
    expect(supabase.consumeCalls).toHaveLength(2);
    expect(supabase.persistedPayloads).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Sentinel rewrite contract: zero-cogs drops sentinel pair
// ════════════════════════════════════════════════════════════════════════════
describe("postEvent ar_invoice_sent — zero-cogs sentinel drop", () => {
  it("single inventory line with cogs=0 drops the COGS pair entirely from the JE", async () => {
    const supabase = mockSupabase({ consumeReturnsByItem: { [ITEM_A]: 0n } });
    const out = buildArSendOutput({
      inventoryLines: [{ ar_line_id: LINE_A_ID, item_id: ITEM_A, qty: 1, revenue_amount: "10.00" }],
    });
    await postEvent(supabase, arSendEvent(out));

    const payload = supabase.persistedPayloads[0];
    // Expect ONLY DR AR + CR revenue. No COGS pair.
    expect(payload.lines).toHaveLength(2);
    expect(payload.lines[0].account_id).toBe(AR_ACC);
    expect(payload.lines[1].account_id).toBe(REV_ACC);
    expect(payload.lines.some((l) => l.account_id === COGS_ACC)).toBe(false);
    expect(payload.lines.some((l) => l.account_id === INV_ACC)).toBe(false);
  });

  it("mixed: one inventory item with cogs > 0 + one with cogs = 0 → second drops, first keeps", async () => {
    const supabase = mockSupabase({
      consumeReturnsByItem: { [ITEM_A]: 1500n, [ITEM_B]: 0n },
    });
    const out = buildArSendOutput({
      inventoryLines: [
        { ar_line_id: LINE_A_ID, item_id: ITEM_A, qty: 3, revenue_amount: "30.00" },
        { ar_line_id: LINE_B_ID, item_id: ITEM_B, qty: 2, revenue_amount: "20.00" },
      ],
    });
    await postEvent(supabase, arSendEvent(out));

    const payload = supabase.persistedPayloads[0];
    // AR + revA + COGS A + Inv A + revB  = 5 lines (B's COGS pair dropped)
    expect(payload.lines).toHaveLength(5);
    expect(payload.lines.filter((l) => l.account_id === COGS_ACC)).toHaveLength(1);
    expect(payload.lines.filter((l) => l.account_id === INV_ACC)).toHaveLength(1);
    // The remaining COGS line is for ITEM_A
    const cogsLine = payload.lines.find((l) => l.account_id === COGS_ACC);
    expect(cogsLine.subledger_id).toBe(ITEM_A);
    expect(cogsLine.debit).toBe("15.00");
  });

  it("renumbers line_number contiguously 1..N after a sentinel drop", async () => {
    const supabase = mockSupabase({
      consumeReturnsByItem: { [ITEM_A]: 0n, [ITEM_B]: 800n },
    });
    const out = buildArSendOutput({
      inventoryLines: [
        { ar_line_id: LINE_A_ID, item_id: ITEM_A, qty: 1, revenue_amount: "10.00" },
        { ar_line_id: LINE_B_ID, item_id: ITEM_B, qty: 2, revenue_amount: "20.00" },
      ],
    });
    await postEvent(supabase, arSendEvent(out));

    const payload = supabase.persistedPayloads[0];
    const numbers = payload.lines.map((l) => l.line_number);
    // Must be contiguous 1..N
    expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, i) => i + 1));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Mode detection — legacy 2-line vs indexed
// ════════════════════════════════════════════════════════════════════════════
describe("postEvent — consumePlan mode detection", () => {
  it("inventoryAdjustment (negative qty) still works via legacy 2-line mode (back-compat)", async () => {
    // This regression-tests that P4-3's indexed-mode addition does NOT break
    // P3-5's existing behavior. We use the real inventoryAdjustment rule.
    const supabase = mockSupabase({ consumeReturnsByItem: { [ITEM_A]: 700n } });

    const result = await postEvent(supabase, {
      kind: "inventory_adjustment",
      entity_id: ENTITY,
      created_by_user_id: USER,
      data: {
        adjustment_id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
        item_id: ITEM_A,
        adjustment_type: "shrinkage",
        qty_delta: -5,
        inventory_account_id: INV_ACC,
        gl_account_id: COGS_ACC,
        posting_date: "2026-05-27",
      },
    });

    // Two persists (accrual + cash twins, both rewritten to 7.00).
    expect(supabase.persistedPayloads).toHaveLength(2);
    expect(supabase.persistedPayloads[0].lines[0].debit).toBe("7.00");
    expect(supabase.persistedPayloads[0].lines[1].credit).toBe("7.00");
    expect(result.consume_results[0].cogs_cents).toBe("700");
  });

  it("indexed-mode entry missing dr_line_ix throws consume_plan_shape", async () => {
    const supabase = mockSupabase({ consumeReturnsByItem: { [ITEM_A]: 100n } });
    const out = buildArSendOutput({
      inventoryLines: [{ ar_line_id: LINE_A_ID, item_id: ITEM_A, qty: 1, revenue_amount: "10.00" }],
    });
    // Corrupt: keep cr_line_ix but drop dr_line_ix
    out.consumePlan[0].dr_line_ix = null;

    await expect(postEvent(supabase, arSendEvent(out)))
      .rejects.toThrow(/missing dr_line_ix/);
  });

  it("indexed-mode line index out of range throws consume_plan_shape", async () => {
    const supabase = mockSupabase({ consumeReturnsByItem: { [ITEM_A]: 100n } });
    const out = buildArSendOutput({
      inventoryLines: [{ ar_line_id: LINE_A_ID, item_id: ITEM_A, qty: 1, revenue_amount: "10.00" }],
    });
    out.consumePlan[0].dr_line_ix = 999;

    await expect(postEvent(supabase, arSendEvent(out)))
      .rejects.toThrow(/line index out of range/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Target line id pass-through (for handler write-back to ar_invoice_lines)
// ════════════════════════════════════════════════════════════════════════════
describe("postEvent ar_invoice_sent — target_line_id pass-through", () => {
  it("consume_results carries target_line_id when rule supplies it", async () => {
    const supabase = mockSupabase({
      consumeReturnsByItem: { [ITEM_A]: 1500n, [ITEM_B]: 800n },
    });
    const out = buildArSendOutput({
      inventoryLines: [
        { ar_line_id: LINE_A_ID, item_id: ITEM_A, qty: 3, revenue_amount: "30.00" },
        { ar_line_id: LINE_B_ID, item_id: ITEM_B, qty: 2, revenue_amount: "20.00" },
      ],
    });
    const result = await postEvent(supabase, arSendEvent(out));

    expect(result.consume_results.map((r) => r.target_line_id))
      .toEqual([LINE_A_ID, LINE_B_ID]);
  });

  it("consume_results target_line_id is null when not supplied (e.g. M37 path)", async () => {
    const supabase = mockSupabase({ consumeReturnsByItem: { [ITEM_A]: 700n } });

    const result = await postEvent(supabase, {
      kind: "inventory_adjustment",
      entity_id: ENTITY,
      created_by_user_id: USER,
      data: {
        adjustment_id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
        item_id: ITEM_A,
        adjustment_type: "shrinkage",
        qty_delta: -5,
        inventory_account_id: INV_ACC,
        gl_account_id: COGS_ACC,
        posting_date: "2026-05-27",
      },
    });

    expect(result.consume_results[0].target_line_id).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// consumer_kind validity — ar_invoice is a recognized kind
// ════════════════════════════════════════════════════════════════════════════
describe("postEvent ar_invoice_sent — consumer_kind ar_invoice", () => {
  it("does NOT reject consumer_kind='ar_invoice' (P4-3 path)", async () => {
    const supabase = mockSupabase({ consumeReturnsByItem: { [ITEM_A]: 1n } });
    const out = buildArSendOutput({
      inventoryLines: [{ ar_line_id: LINE_A_ID, item_id: ITEM_A, qty: 1, revenue_amount: "10.00" }],
    });
    // Sanity: the synthetic builder uses 'ar_invoice'
    expect(out.consumePlan[0].consumer_kind).toBe("ar_invoice");

    await expect(postEvent(supabase, arSendEvent(out))).resolves.toBeTruthy();
    expect(supabase.consumeCalls[0].p_consumer_kind).toBe("ar_invoice");
  });
});
