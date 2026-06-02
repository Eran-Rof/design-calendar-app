// Tests for api/_lib/inventory/fifo.js — the JS wrapper around the
// inventory_fifo_consume RPC and the inventory_layers table.
//
// The SQL function itself runs inside Supabase; for unit coverage we
// mock supabase with an in-memory store that simulates `.from('inventory_layers')
// .insert(...)` and `.rpc('inventory_fifo_consume', ...)`. The mock
// .rpc() implementation runs a faithful FIFO algorithm against the in-memory
// layers so we can assert that callers receive the right cogs_cents and that
// our wrapper correctly maps PG errors to InventoryError codes.

import { describe, it, expect, beforeEach } from "vitest";
import {
  createLayer,
  consume,
  inventoryFifoAPI,
  InventoryError,
} from "../inventory/fifo.js";

const ENTITY = "00000000-0000-0000-0000-000000000001";
const ITEM_A = "11111111-1111-1111-1111-111111111111";
const ITEM_B = "22222222-2222-2222-2222-222222222222";
const USER  = "33333333-3333-3333-3333-333333333333";
const INV_A = "44444444-4444-4444-4444-444444444444";
const REF_X = "55555555-5555-5555-5555-555555555555";

function buildClient(state) {
  return {
    from(table) {
      const tableState = state[table] || (state[table] = []);
      return new Chain(table, tableState, state);
    },
    rpc: async (fn, params) => {
      if (fn !== "inventory_fifo_consume") {
        return { data: null, error: { message: `unknown rpc ${fn}` } };
      }
      try {
        const result = simulateConsume(state, params);
        return { data: result, error: null };
      } catch (e) {
        return { data: null, error: { message: e.message } };
      }
    },
  };
}

class Chain {
  constructor(table, rows, allTables) {
    this.table = table;
    this.rows = rows;
    this.allTables = allTables;
    this.filters = [];
    this.insertRows = null;
    this.singleFlag = false;
    this._chained = false;
  }
  select() { return this; }
  eq(col, val) { this.filters.push((r) => r[col] === val); return this; }
  insert(rows) {
    this.insertRows = Array.isArray(rows) ? rows : [rows];
    return this;
  }
  single() { this.singleFlag = true; return this._run(); }
  then(resolve, reject) { return this._run().then(resolve, reject); }

  async _run() {
    if (this.insertRows) {
      const out = [];
      for (const r of this.insertRows) {
        const row = {
          id: `id-${this.allTables.__seq = (this.allTables.__seq || 0) + 1}`,
          created_at: new Date().toISOString(),
          ...r,
        };
        this.rows.push(row);
        out.push(row);
      }
      if (this.singleFlag) return { data: out[0], error: null };
      return { data: out, error: null };
    }
    const filtered = this.rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.singleFlag) {
      if (filtered.length === 0) return { data: null, error: { message: "not found" } };
      return { data: filtered[0], error: null };
    }
    return { data: filtered, error: null };
  }
}

/**
 * In-memory faithful FIFO consume — mirrors the PL/pgSQL function.
 * Returns total cogs_cents as a JS number (which the wrapper will BigInt).
 */
function simulateConsume(state, p) {
  if (!p.p_entity_id || !p.p_item_id) {
    throw new Error("entity/item required");
  }
  if (!p.p_qty || Number(p.p_qty) <= 0) {
    throw new Error("p_qty must be > 0");
  }
  const layers = (state.inventory_layers || [])
    .filter(
      (l) =>
        l.entity_id === p.p_entity_id &&
        l.item_id === p.p_item_id &&
        Number(l.remaining_qty) > 0,
    )
    .sort((a, b) => {
      const ad = new Date(a.received_at).getTime();
      const bd = new Date(b.received_at).getTime();
      if (ad !== bd) return ad - bd;
      return String(a.id).localeCompare(String(b.id));
    });

  let remaining = Number(p.p_qty);
  let totalCogs = 0;
  state.inventory_consumption = state.inventory_consumption || [];
  for (const layer of layers) {
    if (remaining <= 0) break;
    const draw = Math.min(Number(layer.remaining_qty), remaining);
    const cogs = draw * Number(layer.unit_cost_cents);
    state.inventory_consumption.push({
      id: `cons-${(state.__seq = (state.__seq || 0) + 1)}`,
      entity_id: p.p_entity_id,
      layer_id: layer.id,
      consumed_at: new Date().toISOString(),
      qty_consumed: draw,
      cogs_cents: cogs,
      consumer_kind: p.p_consumer_kind,
      consumer_invoice_id: p.p_consumer_kind === "ar_invoice" ? p.p_consumer_ref_id : null,
      consumer_adjustment_id: p.p_consumer_kind !== "ar_invoice" ? p.p_consumer_ref_id : null,
      created_by_user_id: p.p_user_id,
    });
    layer.remaining_qty = Number(layer.remaining_qty) - draw;
    totalCogs += cogs;
    remaining -= draw;
  }
  if (remaining > 0) {
    throw new Error(`Insufficient inventory for item ${p.p_item_id} (short by ${remaining} units)`);
  }
  return totalCogs;
}

function seed() {
  const state = { inventory_layers: [], inventory_consumption: [] };
  return { state, sb: buildClient(state) };
}

function seedLayers(state, layers) {
  for (const l of layers) {
    state.inventory_layers.push({
      id: l.id || `layer-${(state.__seq = (state.__seq || 0) + 1)}`,
      entity_id: l.entity_id || ENTITY,
      item_id: l.item_id || ITEM_A,
      received_at: l.received_at,
      original_qty: l.qty,
      remaining_qty: l.qty,
      unit_cost_cents: l.unit_cost_cents,
      source_kind: l.source_kind || "ap_invoice",
    });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// createLayer
// ════════════════════════════════════════════════════════════════════════════
describe("createLayer", () => {
  it("inserts a layer with original_qty == remaining_qty", async () => {
    const { state, sb } = seed();
    const out = await createLayer(sb, {
      entity_id: ENTITY,
      item_id: ITEM_A,
      qty: 12,
      unit_cost_cents: 750,
      source_kind: "ap_invoice",
      source_invoice_id: INV_A,
      created_by_user_id: USER,
    });
    expect(out.layer).toBeTruthy();
    expect(state.inventory_layers).toHaveLength(1);
    const row = state.inventory_layers[0];
    expect(row.original_qty).toBe(12);
    expect(row.remaining_qty).toBe(12);
    expect(row.unit_cost_cents).toBe(750);
    expect(row.source_kind).toBe("ap_invoice");
    expect(row.source_invoice_id).toBe(INV_A);
  });

  it("defaults received_at to current ISO timestamp when omitted", async () => {
    const { state, sb } = seed();
    const before = new Date().toISOString();
    await createLayer(sb, {
      entity_id: ENTITY,
      item_id: ITEM_A,
      qty: 1,
      unit_cost_cents: 100,
      source_kind: "adjustment",
    });
    const after = new Date().toISOString();
    const row = state.inventory_layers[0];
    expect(row.received_at).toBeTruthy();
    expect(row.received_at >= before).toBe(true);
    expect(row.received_at <= after).toBe(true);
  });

  it("accepts an explicit received_at", async () => {
    const { state, sb } = seed();
    const ts = "2025-01-15T10:00:00.000Z";
    await createLayer(sb, {
      entity_id: ENTITY, item_id: ITEM_A, qty: 5, unit_cost_cents: 200,
      source_kind: "opening_balance", received_at: ts,
    });
    expect(state.inventory_layers[0].received_at).toBe(ts);
  });

  it("accepts unit_cost_cents as bigint", async () => {
    const { state, sb } = seed();
    await createLayer(sb, {
      entity_id: ENTITY, item_id: ITEM_A, qty: 1,
      unit_cost_cents: 9_999_999n,
      source_kind: "ap_invoice",
    });
    expect(state.inventory_layers[0].unit_cost_cents).toBe("9999999");
  });

  it("accepts unit_cost_cents=0 (free / opening balance with no avg cost)", async () => {
    const { state, sb } = seed();
    await createLayer(sb, {
      entity_id: ENTITY, item_id: ITEM_A, qty: 7, unit_cost_cents: 0,
      source_kind: "opening_balance",
    });
    expect(state.inventory_layers[0].unit_cost_cents).toBe(0);
  });

  it("rejects missing entity_id", async () => {
    const { sb } = seed();
    await expect(
      createLayer(sb, { item_id: ITEM_A, qty: 1, unit_cost_cents: 100, source_kind: "ap_invoice" })
    ).rejects.toThrow(/entity_id/);
  });

  it("rejects missing item_id", async () => {
    const { sb } = seed();
    await expect(
      createLayer(sb, { entity_id: ENTITY, qty: 1, unit_cost_cents: 100, source_kind: "ap_invoice" })
    ).rejects.toThrow(/item_id/);
  });

  it("rejects qty <= 0", async () => {
    const { sb } = seed();
    await expect(
      createLayer(sb, { entity_id: ENTITY, item_id: ITEM_A, qty: 0, unit_cost_cents: 1, source_kind: "ap_invoice" })
    ).rejects.toThrow(/qty/);
    await expect(
      createLayer(sb, { entity_id: ENTITY, item_id: ITEM_A, qty: -5, unit_cost_cents: 1, source_kind: "ap_invoice" })
    ).rejects.toThrow(/qty/);
  });

  it("rejects negative unit_cost_cents", async () => {
    const { sb } = seed();
    await expect(
      createLayer(sb, { entity_id: ENTITY, item_id: ITEM_A, qty: 1, unit_cost_cents: -100, source_kind: "ap_invoice" })
    ).rejects.toThrow(/unit_cost_cents/);
  });

  it("rejects invalid source_kind", async () => {
    const { sb } = seed();
    await expect(
      createLayer(sb, { entity_id: ENTITY, item_id: ITEM_A, qty: 1, unit_cost_cents: 100, source_kind: "bogus" })
    ).rejects.toThrow(/source_kind/);
  });

  it("rejects non-uuid entity_id", async () => {
    const { sb } = seed();
    await expect(
      createLayer(sb, { entity_id: "not-a-uuid", item_id: ITEM_A, qty: 1, unit_cost_cents: 1, source_kind: "ap_invoice" })
    ).rejects.toThrow(/uuid/);
  });

  it("throws InventoryError (not plain Error) with stable code", async () => {
    const { sb } = seed();
    try {
      await createLayer(sb, {});
    } catch (e) {
      expect(e).toBeInstanceOf(InventoryError);
      expect(e.code).toBeTruthy();
      return;
    }
    throw new Error("expected throw");
  });

  it("wraps a supabase insert error as layer_insert_failed", async () => {
    const sb = {
      from: () => ({
        insert: () => ({
          select: () => ({
            single: async () => ({ data: null, error: { message: "boom" } }),
          }),
        }),
      }),
    };
    try {
      await createLayer(sb, {
        entity_id: ENTITY, item_id: ITEM_A, qty: 1, unit_cost_cents: 1,
        source_kind: "ap_invoice",
      });
    } catch (e) {
      expect(e.code).toBe("layer_insert_failed");
      return;
    }
    throw new Error("expected throw");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// consume — happy paths
// ════════════════════════════════════════════════════════════════════════════
describe("consume — single-layer", () => {
  it("draws from one layer when it covers the qty", async () => {
    const { state, sb } = seed();
    seedLayers(state, [
      { received_at: "2025-01-01T00:00:00Z", qty: 10, unit_cost_cents: 500 },
    ]);
    const { cogs_cents } = await consume(sb, {
      entity_id: ENTITY, item_id: ITEM_A, qty: 3,
      consumer_kind: "ar_invoice", consumer_ref_id: INV_A, user_id: USER,
    });
    expect(cogs_cents).toBe(1500n); // 3 * 500
    expect(state.inventory_layers[0].remaining_qty).toBe(7);
    expect(state.inventory_consumption).toHaveLength(1);
    expect(state.inventory_consumption[0].qty_consumed).toBe(3);
    expect(state.inventory_consumption[0].consumer_invoice_id).toBe(INV_A);
  });

  it("exactly drains a layer with no leftover", async () => {
    const { state, sb } = seed();
    seedLayers(state, [
      { received_at: "2025-01-01T00:00:00Z", qty: 4, unit_cost_cents: 250 },
    ]);
    const { cogs_cents } = await consume(sb, {
      entity_id: ENTITY, item_id: ITEM_A, qty: 4,
      consumer_kind: "ar_invoice",
    });
    expect(cogs_cents).toBe(1000n);
    expect(state.inventory_layers[0].remaining_qty).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// consume — multi-layer FIFO ordering
// ════════════════════════════════════════════════════════════════════════════
describe("consume — multi-layer FIFO", () => {
  it("crosses layer boundaries in receipt-date order", async () => {
    const { state, sb } = seed();
    seedLayers(state, [
      { received_at: "2025-01-01T00:00:00Z", qty: 2,  unit_cost_cents: 500 },
      { received_at: "2025-02-01T00:00:00Z", qty: 10, unit_cost_cents: 700 },
    ]);
    const { cogs_cents } = await consume(sb, {
      entity_id: ENTITY, item_id: ITEM_A, qty: 5,
      consumer_kind: "ar_invoice", consumer_ref_id: INV_A,
    });
    // 2 * 500 + 3 * 700 = 1000 + 2100 = 3100
    expect(cogs_cents).toBe(3100n);
    expect(state.inventory_layers[0].remaining_qty).toBe(0);
    expect(state.inventory_layers[1].remaining_qty).toBe(7);
    expect(state.inventory_consumption).toHaveLength(2);
  });

  it("ignores later-dated layers when an earlier one still covers", async () => {
    const { state, sb } = seed();
    seedLayers(state, [
      { received_at: "2025-01-01T00:00:00Z", qty: 100, unit_cost_cents: 100 },
      { received_at: "2025-06-01T00:00:00Z", qty: 100, unit_cost_cents: 999 },
    ]);
    const { cogs_cents } = await consume(sb, {
      entity_id: ENTITY, item_id: ITEM_A, qty: 5,
      consumer_kind: "ar_invoice",
    });
    expect(cogs_cents).toBe(500n);
    expect(state.inventory_layers[1].remaining_qty).toBe(100); // untouched
  });

  it("skips already-exhausted (remaining_qty=0) layers", async () => {
    const { state, sb } = seed();
    seedLayers(state, [
      { received_at: "2025-01-01T00:00:00Z", qty: 5, unit_cost_cents: 100 },
      { received_at: "2025-02-01T00:00:00Z", qty: 5, unit_cost_cents: 200 },
    ]);
    // Manually exhaust layer 1
    state.inventory_layers[0].remaining_qty = 0;
    const { cogs_cents } = await consume(sb, {
      entity_id: ENTITY, item_id: ITEM_A, qty: 3,
      consumer_kind: "ar_invoice",
    });
    expect(cogs_cents).toBe(600n); // all drawn from layer 2 @ 200
    expect(state.inventory_layers[1].remaining_qty).toBe(2);
  });

  it("isolates layers by item_id (does not draw cross-item)", async () => {
    const { state, sb } = seed();
    seedLayers(state, [
      { received_at: "2025-01-01T00:00:00Z", item_id: ITEM_A, qty: 5, unit_cost_cents: 500 },
      { received_at: "2025-01-01T00:00:00Z", item_id: ITEM_B, qty: 100, unit_cost_cents: 1 },
    ]);
    await expect(
      consume(sb, {
        entity_id: ENTITY, item_id: ITEM_A, qty: 50, consumer_kind: "ar_invoice",
      })
    ).rejects.toThrow(/Insufficient/);
    // ITEM_B layer should be untouched
    expect(state.inventory_layers[1].remaining_qty).toBe(100);
  });

  it("isolates layers by entity_id", async () => {
    const { state, sb } = seed();
    const ENTITY_2 = "00000000-0000-0000-0000-000000000002";
    seedLayers(state, [
      { received_at: "2025-01-01T00:00:00Z", entity_id: ENTITY_2, qty: 100, unit_cost_cents: 1 },
    ]);
    await expect(
      consume(sb, {
        entity_id: ENTITY, item_id: ITEM_A, qty: 1, consumer_kind: "ar_invoice",
      })
    ).rejects.toThrow(/Insufficient/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// consume — insufficient inventory
// ════════════════════════════════════════════════════════════════════════════
describe("consume — insufficient inventory", () => {
  it("throws InventoryError with code=insufficient_inventory when layers don't cover", async () => {
    const { state, sb } = seed();
    seedLayers(state, [
      { received_at: "2025-01-01T00:00:00Z", qty: 2, unit_cost_cents: 500 },
    ]);
    try {
      await consume(sb, {
        entity_id: ENTITY, item_id: ITEM_A, qty: 5, consumer_kind: "ar_invoice",
      });
    } catch (e) {
      expect(e).toBeInstanceOf(InventoryError);
      expect(e.code).toBe("insufficient_inventory");
      expect(e.message).toMatch(/short by 3 units/);
      return;
    }
    throw new Error("expected throw");
  });

  it("throws when there are zero layers at all", async () => {
    const { sb } = seed();
    try {
      await consume(sb, {
        entity_id: ENTITY, item_id: ITEM_A, qty: 1, consumer_kind: "ar_invoice",
      });
    } catch (e) {
      expect(e).toBeInstanceOf(InventoryError);
      expect(e.code).toBe("insufficient_inventory");
      return;
    }
    throw new Error("expected throw");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// consume — validation
// ════════════════════════════════════════════════════════════════════════════
describe("consume — input validation", () => {
  it("rejects missing entity_id", async () => {
    const { sb } = seed();
    await expect(
      consume(sb, { item_id: ITEM_A, qty: 1, consumer_kind: "ar_invoice" })
    ).rejects.toThrow(/entity_id/);
  });

  it("rejects missing item_id", async () => {
    const { sb } = seed();
    await expect(
      consume(sb, { entity_id: ENTITY, qty: 1, consumer_kind: "ar_invoice" })
    ).rejects.toThrow(/item_id/);
  });

  it("rejects qty=0 as invalid_qty (does not even hit RPC)", async () => {
    const { sb } = seed();
    try {
      await consume(sb, {
        entity_id: ENTITY, item_id: ITEM_A, qty: 0, consumer_kind: "ar_invoice",
      });
    } catch (e) {
      expect(e).toBeInstanceOf(InventoryError);
      expect(e.code).toBe("invalid_qty");
      return;
    }
    throw new Error("expected throw");
  });

  it("rejects negative qty", async () => {
    const { sb } = seed();
    await expect(
      consume(sb, { entity_id: ENTITY, item_id: ITEM_A, qty: -1, consumer_kind: "ar_invoice" })
    ).rejects.toThrow(/qty/);
  });

  it("rejects invalid consumer_kind", async () => {
    const { sb } = seed();
    await expect(
      consume(sb, { entity_id: ENTITY, item_id: ITEM_A, qty: 1, consumer_kind: "bogus" })
    ).rejects.toThrow(/consumer_kind/);
  });

  it("accepts all four consumer_kind values", async () => {
    for (const kind of ["ar_invoice", "adjustment_decrease", "transfer_out", "write_off"]) {
      const { state, sb } = seed();
      seedLayers(state, [{ received_at: "2025-01-01T00:00:00Z", qty: 5, unit_cost_cents: 100 }]);
      const { cogs_cents } = await consume(sb, {
        entity_id: ENTITY, item_id: ITEM_A, qty: 2, consumer_kind: kind,
        consumer_ref_id: REF_X,
      });
      expect(cogs_cents).toBe(200n);
    }
  });

  it("routes consumer_ref_id to consumer_invoice_id when consumer_kind=ar_invoice", async () => {
    const { state, sb } = seed();
    seedLayers(state, [{ received_at: "2025-01-01T00:00:00Z", qty: 5, unit_cost_cents: 100 }]);
    await consume(sb, {
      entity_id: ENTITY, item_id: ITEM_A, qty: 1,
      consumer_kind: "ar_invoice", consumer_ref_id: INV_A,
    });
    expect(state.inventory_consumption[0].consumer_invoice_id).toBe(INV_A);
    expect(state.inventory_consumption[0].consumer_adjustment_id).toBeNull();
  });

  it("routes consumer_ref_id to consumer_adjustment_id for non-AR kinds", async () => {
    const { state, sb } = seed();
    seedLayers(state, [{ received_at: "2025-01-01T00:00:00Z", qty: 5, unit_cost_cents: 100 }]);
    await consume(sb, {
      entity_id: ENTITY, item_id: ITEM_A, qty: 1,
      consumer_kind: "adjustment_decrease", consumer_ref_id: REF_X,
    });
    expect(state.inventory_consumption[0].consumer_invoice_id).toBeNull();
    expect(state.inventory_consumption[0].consumer_adjustment_id).toBe(REF_X);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// consume — error mapping from supabase.rpc
// ════════════════════════════════════════════════════════════════════════════
describe("consume — RPC error mapping", () => {
  it("maps a generic rpc error to consume_failed", async () => {
    const sb = {
      from: () => { throw new Error("unused"); },
      rpc: async () => ({ data: null, error: { message: "connection reset" } }),
    };
    try {
      await consume(sb, {
        entity_id: ENTITY, item_id: ITEM_A, qty: 1, consumer_kind: "ar_invoice",
      });
    } catch (e) {
      expect(e.code).toBe("consume_failed");
      expect(e.message).toMatch(/connection reset/);
      return;
    }
    throw new Error("expected throw");
  });

  it("maps an 'Insufficient inventory' rpc error to insufficient_inventory", async () => {
    const sb = {
      from: () => { throw new Error("unused"); },
      rpc: async () => ({ data: null, error: { message: "Insufficient inventory for item X (short by 2 units)" } }),
    };
    try {
      await consume(sb, {
        entity_id: ENTITY, item_id: ITEM_A, qty: 10, consumer_kind: "ar_invoice",
      });
    } catch (e) {
      expect(e.code).toBe("insufficient_inventory");
      return;
    }
    throw new Error("expected throw");
  });

  it("returns BigInt cogs_cents even when supabase returns string", async () => {
    const sb = {
      from: () => { throw new Error("unused"); },
      rpc: async () => ({ data: "12345", error: null }),
    };
    const { cogs_cents } = await consume(sb, {
      entity_id: ENTITY, item_id: ITEM_A, qty: 1, consumer_kind: "ar_invoice",
    });
    expect(typeof cogs_cents).toBe("bigint");
    expect(cogs_cents).toBe(12345n);
  });

  it("returns BigInt cogs_cents from a numeric rpc return", async () => {
    const sb = {
      from: () => { throw new Error("unused"); },
      rpc: async () => ({ data: 999, error: null }),
    };
    const { cogs_cents } = await consume(sb, {
      entity_id: ENTITY, item_id: ITEM_A, qty: 1, consumer_kind: "ar_invoice",
    });
    expect(cogs_cents).toBe(999n);
  });

  it("treats null rpc data as 0n cogs_cents (no-op edge case)", async () => {
    const sb = {
      from: () => { throw new Error("unused"); },
      rpc: async () => ({ data: null, error: null }),
    };
    const { cogs_cents } = await consume(sb, {
      entity_id: ENTITY, item_id: ITEM_A, qty: 1, consumer_kind: "ar_invoice",
    });
    expect(cogs_cents).toBe(0n);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Top-level API surface
// ════════════════════════════════════════════════════════════════════════════
describe("inventoryFifoAPI", () => {
  it("exports createLayer + consume + InventoryError", () => {
    expect(typeof inventoryFifoAPI.createLayer).toBe("function");
    expect(typeof inventoryFifoAPI.consume).toBe("function");
    expect(inventoryFifoAPI.InventoryError).toBe(InventoryError);
  });
});
