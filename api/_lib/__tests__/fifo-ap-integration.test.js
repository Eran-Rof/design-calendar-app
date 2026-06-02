// Tests for Tangerine P3-4 — FIFO ↔ AP integration.
//
// The wiring lives in two files:
//   1. api/_lib/accounting/posting/rules/apInvoiceReceived.js — when a
//      multi-line AP invoice carries inventory_item_id + qty + unit_cost_cents,
//      the rule emits PostingRuleOutput.inventoryLayers[].
//   2. api/_lib/accounting/posting/index.js (postEvent) — after the JE persists
//      via persistRuleOutput, it iterates inventoryLayers and calls
//      fifo.createLayer() for each one. Layer-create failures DO NOT roll back
//      the JE; they surface on the result as inventory_layer_errors.
//
// These tests mock Supabase (rpc + from('inventory_layers').insert) end-to-end.

import { describe, it, expect, vi } from "vitest";
import { apInvoiceReceived } from "../accounting/posting/rules/apInvoiceReceived.js";
import { postEvent, PostingError } from "../accounting/posting/index.js";

const ENTITY = "00000000-0000-0000-0000-000000000001";
const VENDOR = "11111111-1111-1111-1111-111111111111";
const INVOICE = "22222222-2222-2222-2222-222222222222";
const AP = "33333333-3333-3333-3333-333333333333";
const EXP = "44444444-4444-4444-4444-444444444444";
const INV_ACC = "55555555-5555-5555-5555-555555555555";
const ITEM_A = "66666666-6666-6666-6666-666666666666";
const ITEM_B = "77777777-7777-7777-7777-777777777777";
const USER = "88888888-8888-8888-8888-888888888888";

const accounts = [
  { id: EXP, entity_id: ENTITY, status: "active", is_postable: true, is_control: false, code: "5000", name: "COGS" },
  { id: AP, entity_id: ENTITY, status: "active", is_postable: true, is_control: true, code: "2000", name: "AP" },
  { id: INV_ACC, entity_id: ENTITY, status: "active", is_postable: true, is_control: true, code: "1200", name: "Inventory" },
];

/**
 * Mock Supabase client capable of:
 *   - gl_post_journal_entry RPC (returns a fake JE id)
 *   - gl_link_sibling_je RPC
 *   - SELECT gl_accounts / gl_periods / entities (for guards)
 *   - INSERT inventory_layers (records args, returns synthesized row)
 */
function mockSupabase({
  postRpcReturns = "je-id",
  postRpcImpl = null,
  layerInsertImpl = null,
  glAccounts = accounts,
  period = { id: "p1", status: "open", starts_on: "2026-05-01", ends_on: "2026-05-31" },
  entity = { posting_locked_through: null },
} = {}) {
  const insertedLayers = [];
  let layerSeq = 0;

  const rpc = vi.fn().mockImplementation(async (fnName, args) => {
    if (postRpcImpl) {
      const out = await postRpcImpl(fnName, args);
      if (out) return out;
    }
    if (fnName === "gl_post_journal_entry") {
      return { data: postRpcReturns, error: null };
    }
    if (fnName === "gl_link_sibling_je") {
      return { data: null, error: null };
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
      const obj = {
        insert(rows) {
          rowsToInsert = Array.isArray(rows) ? rows : [rows];
          return this;
        },
        select() { return this; },
        async single() {
          if (layerInsertImpl) {
            const out = await layerInsertImpl(rowsToInsert[0]);
            if (out) return out;
          }
          const row = { id: `layer-${++layerSeq}`, ...rowsToInsert[0] };
          insertedLayers.push(row);
          return { data: row, error: null };
        },
      };
      return obj;
    }
    throw new Error(`unexpected table ${table}`);
  };

  return { from, rpc, insertedLayers };
}

function baseEvent(extraData = {}) {
  return {
    kind: "ap_invoice_received",
    entity_id: ENTITY,
    created_by_user_id: USER,
    data: {
      invoice_id: INVOICE,
      vendor_id: VENDOR,
      invoice_number: "INV-9001",
      invoice_date: "2026-05-27",
      ap_account_id: AP,
      ...extraData,
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Rule output — inventoryLayers
// ════════════════════════════════════════════════════════════════════════════
describe("apInvoiceReceived — inventoryLayers emission", () => {
  it("inventory line WITHOUT qty/unit_cost_cents emits NO inventoryLayers", () => {
    const r = apInvoiceReceived(baseEvent({
      lines: [
        { amount: "750.00", inventory_item_id: ITEM_A, inventory_account_id: INV_ACC },
      ],
    }));
    expect(r.inventoryLayers).toBeUndefined();
  });

  it("inventory line WITH qty + unit_cost_cents queues exactly one layer", () => {
    const r = apInvoiceReceived(baseEvent({
      lines: [
        {
          amount: "750.00",
          inventory_item_id: ITEM_A,
          inventory_account_id: INV_ACC,
          qty: 10,
          unit_cost_cents: 7500,
          memo: "Receipt of widgets",
        },
      ],
    }));
    expect(r.inventoryLayers).toHaveLength(1);
    expect(r.inventoryLayers[0]).toMatchObject({
      item_id: ITEM_A,
      qty: 10,
      unit_cost_cents: 7500,
      source_invoice_id: INVOICE,
      received_at: "2026-05-27",
      notes: "Receipt of widgets",
    });
  });

  it("multi-line invoice queues one layer per inventory line", () => {
    const r = apInvoiceReceived(baseEvent({
      lines: [
        { amount: "100.00", expense_account_id: EXP },
        { amount: "750.00", inventory_item_id: ITEM_A, inventory_account_id: INV_ACC, qty: 10, unit_cost_cents: 7500 },
        { amount: "200.00", inventory_item_id: ITEM_B, inventory_account_id: INV_ACC, qty: 4, unit_cost_cents: 5000 },
      ],
    }));
    expect(r.inventoryLayers).toHaveLength(2);
    expect(r.inventoryLayers[0].item_id).toBe(ITEM_A);
    expect(r.inventoryLayers[1].item_id).toBe(ITEM_B);
  });

  it("mixed lines: only those with qty + unit_cost_cents queue layers (others skip)", () => {
    const r = apInvoiceReceived(baseEvent({
      lines: [
        { amount: "750.00", inventory_item_id: ITEM_A, inventory_account_id: INV_ACC, qty: 10, unit_cost_cents: 7500 },
        { amount: "100.00", inventory_item_id: ITEM_B, inventory_account_id: INV_ACC /* missing qty/unit */ },
      ],
    }));
    expect(r.inventoryLayers).toHaveLength(1);
    expect(r.inventoryLayers[0].item_id).toBe(ITEM_A);
  });

  it("single-amount (non-multi-line) path never emits inventoryLayers", () => {
    const r = apInvoiceReceived(baseEvent({ amount: "1000.00", expense_account_id: EXP }));
    expect(r.inventoryLayers).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// postEvent integration — JE persists + layers created
// ════════════════════════════════════════════════════════════════════════════
describe("postEvent ap_invoice_received → FIFO layer creation", () => {
  it("creates one inventory_layers row per pending layer with full metadata", async () => {
    const supabase = mockSupabase({ postRpcReturns: "je-abc" });

    const result = await postEvent(supabase, baseEvent({
      lines: [
        {
          amount: "750.00",
          inventory_item_id: ITEM_A,
          inventory_account_id: INV_ACC,
          qty: 10,
          unit_cost_cents: 7500,
          memo: "Widgets",
        },
      ],
    }));

    expect(result.accrual_je_id).toBe("je-abc");
    expect(result.inventory_layer_ids).toHaveLength(1);
    expect(supabase.insertedLayers).toHaveLength(1);
    const layer = supabase.insertedLayers[0];
    expect(layer.entity_id).toBe(ENTITY);
    expect(layer.item_id).toBe(ITEM_A);
    expect(layer.original_qty).toBe(10);
    expect(layer.remaining_qty).toBe(10);
    expect(layer.unit_cost_cents).toBe(7500);
    expect(layer.source_kind).toBe("ap_invoice");
    expect(layer.source_invoice_id).toBe(INVOICE);
    expect(layer.created_by_user_id).toBe(USER);
    expect(layer.notes).toBe("Widgets");
  });

  it("AP invoice WITHOUT any inventory lines creates ZERO layers", async () => {
    const supabase = mockSupabase();
    const result = await postEvent(supabase, baseEvent({
      amount: "500.00",
      expense_account_id: EXP,
    }));
    expect(result.accrual_je_id).toBe("je-id");
    expect(result.inventory_layer_ids).toBeUndefined();
    expect(supabase.insertedLayers).toHaveLength(0);
  });

  it("AP invoice with inventory line that LACKS qty/unit_cost_cents creates ZERO layers", async () => {
    const supabase = mockSupabase();
    const result = await postEvent(supabase, baseEvent({
      lines: [
        { amount: "750.00", inventory_item_id: ITEM_A, inventory_account_id: INV_ACC },
      ],
    }));
    expect(result.accrual_je_id).toBeTruthy();
    expect(result.inventory_layer_ids).toBeUndefined();
    expect(supabase.insertedLayers).toHaveLength(0);
  });

  it("creates one layer per inventory line in a multi-line invoice", async () => {
    const supabase = mockSupabase();
    const result = await postEvent(supabase, baseEvent({
      lines: [
        { amount: "100.00", expense_account_id: EXP },
        { amount: "750.00", inventory_item_id: ITEM_A, inventory_account_id: INV_ACC, qty: 10, unit_cost_cents: 7500 },
        { amount: "200.00", inventory_item_id: ITEM_B, inventory_account_id: INV_ACC, qty: 4, unit_cost_cents: 5000 },
      ],
    }));
    expect(result.inventory_layer_ids).toHaveLength(2);
    expect(supabase.insertedLayers).toHaveLength(2);
    expect(supabase.insertedLayers[0].item_id).toBe(ITEM_A);
    expect(supabase.insertedLayers[1].item_id).toBe(ITEM_B);
  });

  it("layer received_at falls back to invoice_date when set on the rule output", async () => {
    const supabase = mockSupabase();
    await postEvent(supabase, baseEvent({
      invoice_date: "2026-04-15",
      lines: [
        { amount: "750.00", inventory_item_id: ITEM_A, inventory_account_id: INV_ACC, qty: 10, unit_cost_cents: 7500 },
      ],
    }));
    // The layer row uses received_at from the pending layer (= invoice_date)
    expect(supabase.insertedLayers[0].received_at).toBe("2026-04-15");
  });

  it("Layer create failure does NOT roll back the JE; error surfaces on result", async () => {
    const supabase = mockSupabase({
      layerInsertImpl: async () => ({ data: null, error: { message: "uniqueness violation" } }),
    });

    const result = await postEvent(supabase, baseEvent({
      lines: [
        { amount: "750.00", inventory_item_id: ITEM_A, inventory_account_id: INV_ACC, qty: 10, unit_cost_cents: 7500 },
      ],
    }));

    expect(result.accrual_je_id).toBeTruthy(); // JE persisted
    expect(result.inventory_layer_ids).toEqual([]);
    expect(result.inventory_layer_errors).toHaveLength(1);
    expect(result.inventory_layer_errors[0].item_id).toBe(ITEM_A);
    expect(result.inventory_layer_errors[0].error).toMatch(/uniqueness/);
  });

  it("Partial-failure: one layer succeeds + one fails — JE still posted, both outcomes recorded", async () => {
    let callCount = 0;
    const supabase = mockSupabase({
      layerInsertImpl: async (row) => {
        callCount += 1;
        if (callCount === 2) {
          return { data: null, error: { message: "second layer rejected" } };
        }
        return null; // fall through to default success
      },
    });

    const result = await postEvent(supabase, baseEvent({
      lines: [
        { amount: "750.00", inventory_item_id: ITEM_A, inventory_account_id: INV_ACC, qty: 10, unit_cost_cents: 7500 },
        { amount: "200.00", inventory_item_id: ITEM_B, inventory_account_id: INV_ACC, qty: 4, unit_cost_cents: 5000 },
      ],
    }));

    expect(result.accrual_je_id).toBeTruthy();
    expect(result.inventory_layer_ids).toHaveLength(1); // one succeeded
    expect(result.inventory_layer_errors).toHaveLength(1);
    expect(result.inventory_layer_errors[0].item_id).toBe(ITEM_B);
  });

  it("JE RPC failure (gl_post_journal_entry rejects) creates NO layers (layer step short-circuits)", async () => {
    const supabase = mockSupabase({
      postRpcImpl: async (fnName) => {
        if (fnName === "gl_post_journal_entry") {
          return { data: null, error: { message: "period closed" } };
        }
        return null;
      },
    });

    await expect(postEvent(supabase, baseEvent({
      lines: [
        { amount: "750.00", inventory_item_id: ITEM_A, inventory_account_id: INV_ACC, qty: 10, unit_cost_cents: 7500 },
      ],
    }))).rejects.toThrow(/RPC failed|period closed/);

    expect(supabase.insertedLayers).toHaveLength(0);
  });

  it("apInvoiceVoided (no-op shape: never-posted) does NOT delete or reverse layers", async () => {
    // The void-event rule output has reversals[] only — no inventoryLayers.
    // postEvent's reversal branch returns BEFORE the layer step. We use the
    // 'never-posted' shape here so reverseJournalEntry isn't invoked (it would
    // need a much heavier mock). Either way the FIFO contract is the same:
    // voiding an AP invoice does NOT touch inventory_layers. If the operator
    // wants to reverse the received inventory they must file a separate
    // adjustment (P3-5).
    const supabase = mockSupabase();

    const result = await postEvent(supabase, {
      kind: "ap_invoice_voided",
      entity_id: ENTITY,
      created_by_user_id: USER,
      data: {
        invoice_id: INVOICE,
        accrual_je_id: null,
        cash_je_id: null,
        gl_status: "unposted",
      },
    });

    // No layer mutations whatsoever — confirms "layers stay" rule.
    expect(supabase.insertedLayers).toHaveLength(0);
    expect(result.reversed_je_ids).toEqual([]);
    expect(result.inventory_layer_ids).toBeUndefined();
  });

  it("created_by_user_id propagates from event to inventory_layers.created_by_user_id", async () => {
    const supabase = mockSupabase();
    await postEvent(supabase, baseEvent({
      lines: [
        { amount: "750.00", inventory_item_id: ITEM_A, inventory_account_id: INV_ACC, qty: 10, unit_cost_cents: 7500 },
      ],
    }));
    expect(supabase.insertedLayers[0].created_by_user_id).toBe(USER);
  });

  it("backwards-compat: existing test fixtures (amount + expense_account_id only) keep working", async () => {
    const supabase = mockSupabase();
    const result = await postEvent(supabase, baseEvent({
      amount: "1000.00",
      expense_account_id: EXP,
    }));
    expect(result.accrual_je_id).toBe("je-id");
    expect(result.cash_je_id).toBeNull();
    expect(result.inventory_layer_ids).toBeUndefined();
    expect(result.inventory_layer_errors).toBeUndefined();
  });

  it("PostingResult shape: inventory_layer_ids omitted when no inventoryLayers were queued", async () => {
    const supabase = mockSupabase();
    const result = await postEvent(supabase, baseEvent({
      lines: [
        { amount: "100.00", expense_account_id: EXP },
      ],
    }));
    // Pure non-inventory invoice → no layer-related keys on result.
    expect(Object.keys(result)).toEqual(
      expect.not.arrayContaining(["inventory_layer_ids", "inventory_layer_errors"]),
    );
  });
});
