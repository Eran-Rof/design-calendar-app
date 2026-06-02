// Tests for Tangerine P3-5 — end-to-end postEvent for inventory_adjustment.
//
// Verifies that:
//   1. Positive qty_delta posts a JE AND creates ONE inventory_layers row
//      (source_kind='adjustment', source_adjustment_id set).
//   2. Negative qty_delta calls inventory_fifo_consume RPC and the resulting
//      cogs_cents rewrites the sentinel "0" amounts on the JE lines BEFORE
//      persist.
//   3. consume() failure (insufficient inventory) propagates as PostingError.

import { describe, it, expect, vi } from "vitest";
import { postEvent } from "../accounting/posting/index.js";

const ENTITY  = "00000000-0000-0000-0000-000000000001";
const ADJ     = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ITEM    = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const INV_ACC = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const GL_ACC  = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const USER    = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

const accounts = [
  { id: INV_ACC, entity_id: ENTITY, status: "active", is_postable: true, is_control: true, code: "1300", name: "Inventory" },
  { id: GL_ACC,  entity_id: ENTITY, status: "active", is_postable: true, is_control: false, code: "5800", name: "Shrinkage Expense" },
];

/**
 * Mock supabase that captures:
 *   - gl_post_journal_entry payloads (so we can assert the rewritten amounts)
 *   - inventory_fifo_consume RPC calls (so we can assert qty + consumer_kind)
 *   - inventory_layers inserts
 */
function mockSupabase({
  consumeReturns = 700n,   // cogs_cents from FIFO RPC
  consumeImpl = null,
  glAccounts = accounts,
  period = { id: "p1", status: "open", starts_on: "2026-05-01", ends_on: "2026-05-31" },
  entity = { posting_locked_through: null },
} = {}) {
  const persistedPayloads = [];
  const insertedLayers = [];
  let jeSeq = 0;
  let layerSeq = 0;

  const rpc = vi.fn().mockImplementation(async (fnName, args) => {
    if (fnName === "gl_post_journal_entry") {
      persistedPayloads.push(args?.payload);
      return { data: `je-${++jeSeq}`, error: null };
    }
    if (fnName === "gl_link_sibling_je") {
      return { data: null, error: null };
    }
    if (fnName === "inventory_fifo_consume") {
      if (consumeImpl) {
        const out = await consumeImpl(args);
        if (out) return out;
      }
      return { data: consumeReturns.toString(), error: null };
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
          const row = { id: `layer-${++layerSeq}`, ...rowsToInsert[0] };
          insertedLayers.push(row);
          return { data: row, error: null };
        },
      };
    }
    throw new Error(`unexpected table ${table}`);
  };

  return { from, rpc, persistedPayloads, insertedLayers };
}

function adjustmentEvent(extra = {}) {
  return {
    kind: "inventory_adjustment",
    entity_id: ENTITY,
    created_by_user_id: USER,
    data: {
      adjustment_id: ADJ,
      item_id: ITEM,
      adjustment_type: "shrinkage",
      qty_delta: -5,
      unit_cost_cents: null,
      inventory_account_id: INV_ACC,
      gl_account_id: GL_ACC,
      posting_date: "2026-05-27",
      reason: "missing units in cycle count",
      ...extra,
    },
  };
}

describe("postEvent inventory_adjustment — POSITIVE", () => {
  it("posts both accrual + cash JEs and creates ONE adjustment layer", async () => {
    const supabase = mockSupabase();
    const result = await postEvent(supabase, adjustmentEvent({
      adjustment_type: "found",
      qty_delta: 10,
      unit_cost_cents: 1500,
    }));

    expect(result.accrual_je_id).toBe("je-1");
    expect(result.cash_je_id).toBe("je-2");

    expect(supabase.insertedLayers).toHaveLength(1);
    const layer = supabase.insertedLayers[0];
    expect(layer.source_kind).toBe("adjustment");
    expect(layer.source_adjustment_id).toBe(ADJ);
    expect(layer.item_id).toBe(ITEM);
    expect(layer.unit_cost_cents).toBe(1500);
    expect(layer.original_qty).toBe(10);
    expect(layer.remaining_qty).toBe(10);
  });

  it("DOES NOT call inventory_fifo_consume on positive path", async () => {
    const supabase = mockSupabase();
    await postEvent(supabase, adjustmentEvent({
      adjustment_type: "found",
      qty_delta: 10,
      unit_cost_cents: 1500,
    }));

    const consumeCalls = supabase.rpc.mock.calls.filter((c) => c[0] === "inventory_fifo_consume");
    expect(consumeCalls).toHaveLength(0);
  });

  it("persists JE with DR inventory + CR counter at qty × cost", async () => {
    const supabase = mockSupabase();
    await postEvent(supabase, adjustmentEvent({
      adjustment_type: "found",
      qty_delta: 4,
      unit_cost_cents: 2500, // $25.00
    }));

    const accrualPayload = supabase.persistedPayloads[0];
    expect(accrualPayload.basis).toBe("ACCRUAL");
    expect(accrualPayload.lines).toHaveLength(2);
    expect(accrualPayload.lines[0].account_id).toBe(INV_ACC);
    expect(accrualPayload.lines[0].debit).toBe("100.00"); // 4 × $25 = $100
    expect(accrualPayload.lines[1].account_id).toBe(GL_ACC);
    expect(accrualPayload.lines[1].credit).toBe("100.00");
  });
});

describe("postEvent inventory_adjustment — NEGATIVE (consumePlan drain)", () => {
  it("calls inventory_fifo_consume with the correct args BEFORE persist", async () => {
    const supabase = mockSupabase({ consumeReturns: 1234n });
    await postEvent(supabase, adjustmentEvent({
      adjustment_type: "damage",
      qty_delta: -3,
    }));

    const consumeCalls = supabase.rpc.mock.calls.filter((c) => c[0] === "inventory_fifo_consume");
    expect(consumeCalls).toHaveLength(1);
    expect(consumeCalls[0][1]).toMatchObject({
      p_entity_id: ENTITY,
      p_item_id: ITEM,
      p_qty: 3,
      p_consumer_kind: "adjustment_decrease",
      p_consumer_ref_id: ADJ,
    });

    // consume happens BEFORE persist — assert the order of RPC calls
    const callOrder = supabase.rpc.mock.calls.map((c) => c[0]);
    const consumeIdx = callOrder.indexOf("inventory_fifo_consume");
    const postIdx = callOrder.indexOf("gl_post_journal_entry");
    expect(consumeIdx).toBeLessThan(postIdx);
  });

  it("rewrites the JE sentinel amounts using cogs_cents returned by consume()", async () => {
    const supabase = mockSupabase({ consumeReturns: 1234n }); // $12.34
    await postEvent(supabase, adjustmentEvent({
      adjustment_type: "shrinkage",
      qty_delta: -3,
    }));

    const accrualPayload = supabase.persistedPayloads[0];
    // line 1 = DR counter (gl_account_id), line 2 = CR inventory
    expect(accrualPayload.lines[0].account_id).toBe(GL_ACC);
    expect(accrualPayload.lines[0].debit).toBe("12.34");
    expect(accrualPayload.lines[1].account_id).toBe(INV_ACC);
    expect(accrualPayload.lines[1].credit).toBe("12.34");
  });

  it("returns consume_results array on the postEvent result", async () => {
    const supabase = mockSupabase({ consumeReturns: 700n });
    const r = await postEvent(supabase, adjustmentEvent({
      adjustment_type: "shrinkage",
      qty_delta: -5,
    }));

    expect(r.consume_results).toHaveLength(1);
    expect(r.consume_results[0]).toEqual({
      item_id: ITEM,
      qty: 5,
      cogs_cents: "700",
      // P4-3: target_line_id added to the shape; null for M37 (no per-line
      // write-back) and set for AR send-time (write-back into ar_invoice_lines.cogs_cents).
      target_line_id: null,
    });
  });

  it("DOES NOT create an inventory_layers row on negative path", async () => {
    const supabase = mockSupabase();
    await postEvent(supabase, adjustmentEvent({
      adjustment_type: "shrinkage",
      qty_delta: -5,
    }));

    expect(supabase.insertedLayers).toHaveLength(0);
  });

  it("propagates insufficient_inventory error from RPC as PostingError", async () => {
    const supabase = mockSupabase({
      consumeImpl: async () => ({
        data: null,
        error: { message: "Insufficient inventory for item " + ITEM + " (short by 3 units)" },
      }),
    });

    await expect(postEvent(supabase, adjustmentEvent({
      adjustment_type: "shrinkage",
      qty_delta: -10,
    }))).rejects.toThrow(/Insufficient inventory|insufficient/i);
  });

  it("both accrual and cash bases get the same rewritten amount", async () => {
    const supabase = mockSupabase({ consumeReturns: 500n }); // $5.00
    await postEvent(supabase, adjustmentEvent({
      adjustment_type: "damage",
      qty_delta: -2,
    }));

    expect(supabase.persistedPayloads).toHaveLength(2);
    const accrualPayload = supabase.persistedPayloads.find((p) => p.basis === "ACCRUAL");
    const cashPayload = supabase.persistedPayloads.find((p) => p.basis === "CASH");
    expect(accrualPayload.lines[0].debit).toBe("5.00");
    expect(cashPayload.lines[0].debit).toBe("5.00");
    expect(accrualPayload.lines[1].credit).toBe("5.00");
    expect(cashPayload.lines[1].credit).toBe("5.00");
  });
});

describe("postEvent inventory_adjustment — adjustment_type independence", () => {
  it("write_off type runs the same negative-path flow as shrinkage", async () => {
    const supabase = mockSupabase({ consumeReturns: 600n });
    const r = await postEvent(supabase, adjustmentEvent({
      adjustment_type: "write_off",
      qty_delta: -2,
    }));

    expect(r.consume_results[0].cogs_cents).toBe("600");
    expect(supabase.persistedPayloads[0].lines[0].debit).toBe("6.00");
  });

  it("return_to_vendor flows as negative consume", async () => {
    const supabase = mockSupabase({ consumeReturns: 250n });
    await postEvent(supabase, adjustmentEvent({
      adjustment_type: "return_to_vendor",
      qty_delta: -1,
    }));
    expect(supabase.persistedPayloads[0].lines[0].debit).toBe("2.50");
  });

  it("correction (positive) creates a layer", async () => {
    const supabase = mockSupabase();
    await postEvent(supabase, adjustmentEvent({
      adjustment_type: "correction",
      qty_delta: 5,
      unit_cost_cents: 200,
    }));
    expect(supabase.insertedLayers).toHaveLength(1);
    expect(supabase.insertedLayers[0].source_kind).toBe("adjustment");
  });
});
