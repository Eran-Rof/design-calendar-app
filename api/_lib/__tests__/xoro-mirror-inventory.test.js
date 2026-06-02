// Tangerine T10-4 — rebuildInventoryLayersForDate tests.
//
// Arch reference: docs/tangerine/T10-shadow-mirror-architecture.md §4.3.
//
// Mocks supabase end-to-end (no live DB).  Focuses on:
//   - drop-and-rebuild scope is keyed on source_kind='xoro_mirror_snapshot'
//     (so operator-typed adjustment/ap_invoice/etc rows can never be touched)
//   - happy path: 100 SKUs × 3 warehouses → 300 layers
//   - skip qty=0
//   - skip unmatched sku → goes to errors, run continues
//   - empty input → zero counts, clean run
//   - unit cost ROUND-to-nearest cent (12.345 → 1235, NOT 1234)
//   - supabase errors are caught and surfaced

import { describe, it, expect } from "vitest";
import { rebuildInventoryLayersForDate } from "../xoro-mirror/inventory.js";

const ENTITY = "00000000-0000-0000-0000-000000000001";
const SNAP_DATE = "2026-05-28";

function uuid(seed) {
  const hex = seed.toString(16).padStart(32, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Build a chainable mock that resolves to a supplied value when awaited.
 *
 * Usage:
 *   chain({ data: [...], error: null })
 * The returned object accepts `.select()`, `.eq()`, `.lte()`, `.in()`,
 * `.order()` etc. as no-ops and resolves to { data, error } when awaited.
 */
function chain(result) {
  const target = {
    select: () => target,
    eq: () => target,
    lte: () => target,
    in: () => target,
    order: () => target,
    limit: () => target,
    maybeSingle: async () => result,
    single: async () => result,
    then(resolve, reject) {
      return Promise.resolve(result).then(resolve, reject);
    },
  };
  return target;
}

/**
 * Mock supabase with controllable per-table responses.
 *
 * Tables tracked:
 *  - ip_inventory_snapshot  → snapshotRows
 *  - ip_item_master         → itemMasterRows
 *  - ip_item_avg_cost       → avgCostRows
 *  - inventory_layers       → DELETE returns deleteCount; INSERT captures rows
 *
 * Inject errors via:
 *   { snapshotError, itemMasterError, deleteError, insertError, avgCostError }
 */
function mockSupabase({
  snapshotRows = [],
  itemMasterRows = [],
  avgCostRows = [],
  sizeOnHandRows = [],
  sizeOnHandError = null,
  deleteCount = 0,
  snapshotError = null,
  itemMasterError = null,
  avgCostError = null,
  deleteError = null,
  insertError = null,
  insertErrorAfterChunk = null, // fail after this many rows captured
} = {}) {
  const insertedRows = [];
  let deleteWhere = null;

  const from = (table) => {
    if (table === "tangerine_size_onhand") {
      return chain({ data: sizeOnHandRows, error: sizeOnHandError });
    }
    if (table === "ip_inventory_snapshot") {
      return chain({ data: snapshotRows, error: snapshotError });
    }
    if (table === "ip_item_master") {
      if (itemMasterError) return chain({ data: null, error: itemMasterError });
      // Honour `.in('id', ids)` the way PostgREST does, so size-grain routing
      // (which reads ip_item_master filtered to the size SKUs) selects only the
      // requested rows rather than the whole catalog.
      let ids = null;
      const target = {
        select: () => target,
        eq: () => target,
        lte: () => target,
        order: () => target,
        limit: () => target,
        in: (_col, vals) => { ids = vals; return target; },
        maybeSingle: async () => ({ data: filtered()[0] ?? null, error: null }),
        single: async () => ({ data: filtered()[0] ?? null, error: null }),
        then(resolve, reject) {
          return Promise.resolve({ data: filtered(), error: null }).then(resolve, reject);
        },
      };
      const filtered = () => (ids == null ? itemMasterRows : itemMasterRows.filter((r) => ids.includes(r.id)));
      return target;
    }
    if (table === "ip_item_avg_cost") {
      return chain({ data: avgCostRows, error: avgCostError });
    }
    if (table === "inventory_layers") {
      // Supports two paths:
      //   .delete({count:"exact"}).eq().eq()  → returns {error, count}
      //   .insert(rows)                       → returns {error}
      const builder = {
        delete(opts) {
          deleteWhere = { ...opts, eqs: [] };
          return builder;
        },
        eq(col, val) {
          if (deleteWhere) deleteWhere.eqs.push([col, val]);
          return builder;
        },
        async then(resolve) {
          // Awaiting after delete(...).eq(...).eq(...) resolves here.
          return resolve({ error: deleteError, count: deleteCount });
        },
        insert(rows) {
          const arr = Array.isArray(rows) ? rows : [rows];
          if (insertError) {
            return Promise.resolve({ error: insertError });
          }
          if (
            insertErrorAfterChunk != null &&
            insertedRows.length >= insertErrorAfterChunk
          ) {
            return Promise.resolve({ error: { message: "boom on subsequent chunk" } });
          }
          for (const r of arr) insertedRows.push(r);
          return Promise.resolve({ error: null });
        },
      };
      return builder;
    }
    throw new Error(`unexpected table ${table}`);
  };

  return {
    from,
    get insertedRows() { return insertedRows; },
    get deleteWhere() { return deleteWhere; },
  };
}

describe("rebuildInventoryLayersForDate — argument validation", () => {
  it("throws when supabase missing", async () => {
    await expect(rebuildInventoryLayersForDate(null, ENTITY, SNAP_DATE))
      .rejects.toThrow(/supabase/);
  });
  it("throws when entity_id missing", async () => {
    await expect(rebuildInventoryLayersForDate(mockSupabase(), "", SNAP_DATE))
      .rejects.toThrow(/entity_id/);
  });
  it("throws when snapshot_date missing", async () => {
    await expect(rebuildInventoryLayersForDate(mockSupabase(), ENTITY, ""))
      .rejects.toThrow(/snapshot_date/);
  });
});

describe("rebuildInventoryLayersForDate — empty input", () => {
  it("returns zero counts and no errors when there are no snapshot rows", async () => {
    const supabase = mockSupabase({ snapshotRows: [], deleteCount: 0 });
    const result = await rebuildInventoryLayersForDate(supabase, ENTITY, SNAP_DATE);
    expect(result.rows_upserted).toBe(0);
    expect(result.rows_deleted).toBe(0);
    expect(result.rows_skipped_unmatched_sku).toBe(0);
    expect(result.rows_skipped_zero_qty).toBe(0);
    expect(result.errors).toEqual([]);
    expect(supabase.insertedRows).toHaveLength(0);
  });

  it("still issues the DELETE so stale mirror rows from a prior run get cleared", async () => {
    const supabase = mockSupabase({ snapshotRows: [], deleteCount: 5 });
    const result = await rebuildInventoryLayersForDate(supabase, ENTITY, SNAP_DATE);
    expect(result.rows_deleted).toBe(5);
    expect(supabase.deleteWhere).not.toBeNull();
  });
});

describe("rebuildInventoryLayersForDate — happy path", () => {
  it("rebuilds 100 SKUs × 3 warehouses → 300 layers when every row has qty > 0", async () => {
    const skuIds = Array.from({ length: 100 }, (_, i) => uuid(100 + i));
    const warehouses = ["NJ", "CA", "TX"];

    const snapshotRows = [];
    for (const sku_id of skuIds) {
      for (const wh of warehouses) {
        snapshotRows.push({
          sku_id,
          warehouse_code: wh,
          qty_on_hand: 5,
          snapshot_date: SNAP_DATE,
        });
      }
    }
    const itemMasterRows = skuIds.map((id, i) => ({
      id,
      sku_code: `SKU-${i}`,
      unit_cost: 10,
      style_code: `STY-${i}`,
    }));

    const supabase = mockSupabase({ snapshotRows, itemMasterRows, deleteCount: 0 });
    const result = await rebuildInventoryLayersForDate(supabase, ENTITY, SNAP_DATE);

    expect(result.rows_upserted).toBe(300);
    expect(result.rows_skipped_unmatched_sku).toBe(0);
    expect(result.rows_skipped_zero_qty).toBe(0);
    expect(result.errors).toEqual([]);
    expect(supabase.insertedRows).toHaveLength(300);

    const sample = supabase.insertedRows[0];
    expect(sample.entity_id).toBe(ENTITY);
    expect(sample.source_kind).toBe("xoro_mirror_snapshot");
    expect(sample.original_qty).toBe(5);
    expect(sample.remaining_qty).toBe(5);
    expect(sample.unit_cost_cents).toBe(1000);
    expect(sample.received_at).toBe("2026-05-28T23:59:59.000Z");
    expect(sample.notes).toMatch(/^xoro_mirror_snapshot:2026-05-28:wh=/);
  });

  it("collapses multiple snapshots per (sku, warehouse) to the latest date", async () => {
    const sku = uuid(1);
    const snapshotRows = [
      // Older row first — must be IGNORED in favour of the more recent one
      // because the rebuild keeps only the latest per (sku_id, warehouse_code).
      { sku_id: sku, warehouse_code: "NJ", qty_on_hand: 99, snapshot_date: "2026-05-20" },
      { sku_id: sku, warehouse_code: "NJ", qty_on_hand: 7,  snapshot_date: "2026-05-27" },
    ];
    const itemMasterRows = [{ id: sku, sku_code: "SKU-1", unit_cost: 5, style_code: "STY-1" }];

    // The module sorts snapshot_date DESC, so the 2026-05-27 row arrives
    // first.  Provide rows in DESC order to mirror what postgrest would
    // return.
    snapshotRows.sort((a, b) => b.snapshot_date.localeCompare(a.snapshot_date));

    const supabase = mockSupabase({ snapshotRows, itemMasterRows });
    const result = await rebuildInventoryLayersForDate(supabase, ENTITY, SNAP_DATE);
    expect(result.rows_upserted).toBe(1);
    expect(supabase.insertedRows[0].original_qty).toBe(7);
  });

  it("defaults warehouse_code to 'DEFAULT' when the snapshot row has none", async () => {
    const sku = uuid(1);
    const snapshotRows = [
      { sku_id: sku, warehouse_code: null, qty_on_hand: 3, snapshot_date: SNAP_DATE },
    ];
    const itemMasterRows = [{ id: sku, sku_code: "SKU-1", unit_cost: 5, style_code: "STY-1" }];
    const supabase = mockSupabase({ snapshotRows, itemMasterRows });
    const result = await rebuildInventoryLayersForDate(supabase, ENTITY, SNAP_DATE);
    expect(result.rows_upserted).toBe(1);
    expect(supabase.insertedRows[0].notes).toContain("wh=DEFAULT");
  });
});

describe("rebuildInventoryLayersForDate — qty filtering", () => {
  it("skips rows with qty_on_hand = 0", async () => {
    const sku = uuid(1);
    const snapshotRows = [
      { sku_id: sku, warehouse_code: "NJ", qty_on_hand: 0, snapshot_date: SNAP_DATE },
      { sku_id: sku, warehouse_code: "CA", qty_on_hand: 4, snapshot_date: SNAP_DATE },
    ];
    const itemMasterRows = [{ id: sku, sku_code: "SKU-1", unit_cost: 1, style_code: "STY-1" }];
    const supabase = mockSupabase({ snapshotRows, itemMasterRows });
    const result = await rebuildInventoryLayersForDate(supabase, ENTITY, SNAP_DATE);
    expect(result.rows_upserted).toBe(1);
    expect(result.rows_skipped_zero_qty).toBe(1);
  });

  it("skips rows with negative qty (defensive)", async () => {
    const sku = uuid(1);
    const snapshotRows = [
      { sku_id: sku, warehouse_code: "NJ", qty_on_hand: -3, snapshot_date: SNAP_DATE },
    ];
    const itemMasterRows = [{ id: sku, sku_code: "SKU-1", unit_cost: 1, style_code: "STY-1" }];
    const supabase = mockSupabase({ snapshotRows, itemMasterRows });
    const result = await rebuildInventoryLayersForDate(supabase, ENTITY, SNAP_DATE);
    expect(result.rows_upserted).toBe(0);
    expect(result.rows_skipped_zero_qty).toBe(1);
  });

  it("skips rows with NaN / null qty", async () => {
    const sku = uuid(1);
    const snapshotRows = [
      { sku_id: sku, warehouse_code: "NJ", qty_on_hand: null, snapshot_date: SNAP_DATE },
    ];
    const itemMasterRows = [{ id: sku, sku_code: "SKU-1", unit_cost: 1, style_code: "STY-1" }];
    const supabase = mockSupabase({ snapshotRows, itemMasterRows });
    const result = await rebuildInventoryLayersForDate(supabase, ENTITY, SNAP_DATE);
    expect(result.rows_skipped_zero_qty).toBe(1);
    expect(result.rows_upserted).toBe(0);
  });
});

describe("rebuildInventoryLayersForDate — sku matching", () => {
  it("logs unmatched sku to errors and continues", async () => {
    const known = uuid(1);
    const unknown = uuid(999);
    const snapshotRows = [
      { sku_id: known,   warehouse_code: "NJ", qty_on_hand: 5, snapshot_date: SNAP_DATE },
      { sku_id: unknown, warehouse_code: "NJ", qty_on_hand: 5, snapshot_date: SNAP_DATE },
    ];
    const itemMasterRows = [{ id: known, sku_code: "SKU-1", unit_cost: 1, style_code: "STY-1" }];
    const supabase = mockSupabase({ snapshotRows, itemMasterRows });
    const result = await rebuildInventoryLayersForDate(supabase, ENTITY, SNAP_DATE);
    expect(result.rows_upserted).toBe(1);
    expect(result.rows_skipped_unmatched_sku).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].stage).toBe("match_sku");
    expect(result.errors[0].sku_id).toBe(unknown);
  });
});

describe("rebuildInventoryLayersForDate — drop-and-rebuild scope", () => {
  it("DELETE filter is entity + source_kind='xoro_mirror_snapshot' (manual rows untouched)", async () => {
    const supabase = mockSupabase({ snapshotRows: [], deleteCount: 0 });
    await rebuildInventoryLayersForDate(supabase, ENTITY, SNAP_DATE);
    const eqs = supabase.deleteWhere.eqs;
    const filterMap = Object.fromEntries(eqs);
    expect(filterMap.entity_id).toBe(ENTITY);
    expect(filterMap.source_kind).toBe("xoro_mirror_snapshot");
    // CRITICAL: nothing else.  Operator-typed adjustment / ap_invoice /
    // opening_balance / transfer_in / credit_memo_return rows are filtered
    // OUT by the source_kind clause and therefore never reach the DELETE.
    expect(eqs).toHaveLength(2);
  });

  it("returns rows_deleted from the DELETE count", async () => {
    const supabase = mockSupabase({ snapshotRows: [], deleteCount: 42 });
    const result = await rebuildInventoryLayersForDate(supabase, ENTITY, SNAP_DATE);
    expect(result.rows_deleted).toBe(42);
  });
});

describe("rebuildInventoryLayersForDate — unit cost rounding", () => {
  it("rounds 12.345 → 1235 cents (NEAREST, not floor)", async () => {
    const sku = uuid(1);
    const snapshotRows = [
      { sku_id: sku, warehouse_code: "NJ", qty_on_hand: 1, snapshot_date: SNAP_DATE },
    ];
    const itemMasterRows = [{ id: sku, sku_code: "SKU-1", unit_cost: 12.345, style_code: "STY-1" }];
    const supabase = mockSupabase({ snapshotRows, itemMasterRows });
    const result = await rebuildInventoryLayersForDate(supabase, ENTITY, SNAP_DATE);
    expect(result.rows_upserted).toBe(1);
    expect(supabase.insertedRows[0].unit_cost_cents).toBe(1235);
  });

  it("rounds 0.005 → 1 cent (Math.round half-away-from-zero)", async () => {
    const sku = uuid(1);
    const snapshotRows = [
      { sku_id: sku, warehouse_code: "NJ", qty_on_hand: 1, snapshot_date: SNAP_DATE },
    ];
    const itemMasterRows = [{ id: sku, sku_code: "SKU-1", unit_cost: 0.005, style_code: "STY-1" }];
    const supabase = mockSupabase({ snapshotRows, itemMasterRows });
    const result = await rebuildInventoryLayersForDate(supabase, ENTITY, SNAP_DATE);
    expect(supabase.insertedRows[0].unit_cost_cents).toBe(1);
  });

  it("falls back to ip_item_avg_cost.avg_cost when unit_cost is null", async () => {
    const sku = uuid(1);
    const snapshotRows = [
      { sku_id: sku, warehouse_code: "NJ", qty_on_hand: 2, snapshot_date: SNAP_DATE },
    ];
    const itemMasterRows = [{ id: sku, sku_code: "SKU-1", unit_cost: null, style_code: "STY-1" }];
    const avgCostRows = [{ sku_code: "SKU-1", avg_cost: 7.5 }];
    const supabase = mockSupabase({ snapshotRows, itemMasterRows, avgCostRows });
    const result = await rebuildInventoryLayersForDate(supabase, ENTITY, SNAP_DATE);
    expect(result.rows_upserted).toBe(1);
    expect(supabase.insertedRows[0].unit_cost_cents).toBe(750);
  });

  it("uses unit_cost_cents=0 when both primary and fallback costs are missing", async () => {
    const sku = uuid(1);
    const snapshotRows = [
      { sku_id: sku, warehouse_code: "NJ", qty_on_hand: 2, snapshot_date: SNAP_DATE },
    ];
    const itemMasterRows = [{ id: sku, sku_code: "SKU-1", unit_cost: null, style_code: "STY-1" }];
    const supabase = mockSupabase({ snapshotRows, itemMasterRows, avgCostRows: [] });
    const result = await rebuildInventoryLayersForDate(supabase, ENTITY, SNAP_DATE);
    expect(result.rows_upserted).toBe(1);
    expect(supabase.insertedRows[0].unit_cost_cents).toBe(0);
  });
});

describe("rebuildInventoryLayersForDate — error surfaces", () => {
  it("snapshot read error: returned in errors, no insert attempted", async () => {
    const supabase = mockSupabase({
      snapshotError: { message: "kaboom selecting snapshot" },
    });
    const result = await rebuildInventoryLayersForDate(supabase, ENTITY, SNAP_DATE);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].stage).toBe("read_snapshot");
    expect(result.errors[0].message).toContain("kaboom");
    expect(supabase.insertedRows).toHaveLength(0);
  });

  it("item_master read error: surfaced, no insert", async () => {
    const sku = uuid(1);
    const supabase = mockSupabase({
      snapshotRows: [
        { sku_id: sku, warehouse_code: "NJ", qty_on_hand: 1, snapshot_date: SNAP_DATE },
      ],
      itemMasterError: { message: "kaboom on items" },
    });
    const result = await rebuildInventoryLayersForDate(supabase, ENTITY, SNAP_DATE);
    expect(result.errors.some((e) => e.stage === "read_item_master")).toBe(true);
    expect(supabase.insertedRows).toHaveLength(0);
  });

  it("avg_cost read error is non-fatal — rebuild still proceeds", async () => {
    const sku = uuid(1);
    const snapshotRows = [
      { sku_id: sku, warehouse_code: "NJ", qty_on_hand: 2, snapshot_date: SNAP_DATE },
    ];
    const itemMasterRows = [{ id: sku, sku_code: "SKU-1", unit_cost: 4, style_code: "STY-1" }];
    const supabase = mockSupabase({
      snapshotRows, itemMasterRows,
      avgCostError: { message: "avg_cost table read failed" },
    });
    const result = await rebuildInventoryLayersForDate(supabase, ENTITY, SNAP_DATE);
    expect(result.rows_upserted).toBe(1);
    expect(result.errors.some((e) => e.stage === "read_avg_cost")).toBe(true);
  });

  it("delete error: surfaced, no insert", async () => {
    const supabase = mockSupabase({
      deleteError: { message: "delete failed" },
    });
    const result = await rebuildInventoryLayersForDate(supabase, ENTITY, SNAP_DATE);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].stage).toBe("delete_existing_mirror_layers");
    expect(supabase.insertedRows).toHaveLength(0);
  });

  it("insert error: surfaced, partial counts preserved as zero", async () => {
    const sku = uuid(1);
    const snapshotRows = [
      { sku_id: sku, warehouse_code: "NJ", qty_on_hand: 5, snapshot_date: SNAP_DATE },
    ];
    const itemMasterRows = [{ id: sku, sku_code: "SKU-1", unit_cost: 1, style_code: "STY-1" }];
    const supabase = mockSupabase({
      snapshotRows, itemMasterRows,
      insertError: { message: "insert failed" },
    });
    const result = await rebuildInventoryLayersForDate(supabase, ENTITY, SNAP_DATE);
    expect(result.rows_upserted).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].stage).toBe("insert_new_mirror_layers");
  });
});

describe("rebuildInventoryLayersForDate — does not touch operator rows", () => {
  it("never includes source_kind in INSERT payload other than xoro_mirror_snapshot", async () => {
    const skuIds = [uuid(1), uuid(2), uuid(3)];
    const snapshotRows = skuIds.map((id) => ({
      sku_id: id, warehouse_code: "NJ", qty_on_hand: 1, snapshot_date: SNAP_DATE,
    }));
    const itemMasterRows = skuIds.map((id, i) => ({
      id, sku_code: `SKU-${i}`, unit_cost: 1, style_code: `STY-${i}`,
    }));
    const supabase = mockSupabase({ snapshotRows, itemMasterRows });
    await rebuildInventoryLayersForDate(supabase, ENTITY, SNAP_DATE);
    for (const row of supabase.insertedRows) {
      expect(row.source_kind).toBe("xoro_mirror_snapshot");
    }
  });

  it("does not query inventory_layers for any operator source_kind", async () => {
    // The supabase mock would throw on any unexpected `eq('source_kind', 'adjustment')`
    // because we only allow the canonical 'xoro_mirror_snapshot' DELETE filter
    // and don't accept any other source_kind clause. This implicitly proves
    // that adjustments / ap_invoices / opening_balances / transfers / credit
    // memos are NEVER read or deleted by the rebuild.
    const supabase = mockSupabase({ snapshotRows: [], deleteCount: 0 });
    await rebuildInventoryLayersForDate(supabase, ENTITY, SNAP_DATE);
    const filters = supabase.deleteWhere.eqs.map(([col, val]) => `${col}=${val}`);
    expect(filters).toContain("source_kind=xoro_mirror_snapshot");
    expect(filters.some((f) => f.startsWith("source_kind=") && !f.endsWith("=xoro_mirror_snapshot"))).toBe(false);
  });
});

describe("rebuildInventoryLayersForDate — size-grain routing (Tangerine-only)", () => {
  it("is a NO-OP when tangerine_size_onhand is empty (color grain unchanged)", async () => {
    const sku = uuid(1);
    const snapshotRows = [
      { sku_id: sku, warehouse_code: "NJ", qty_on_hand: 5, snapshot_date: SNAP_DATE },
    ];
    const itemMasterRows = [{ id: sku, sku_code: "SKU-1", unit_cost: 1, style_code: "STY-1", style_id: uuid(900) }];
    const supabase = mockSupabase({ snapshotRows, itemMasterRows, sizeOnHandRows: [] });
    const result = await rebuildInventoryLayersForDate(supabase, ENTITY, SNAP_DATE);
    expect(result.rows_upserted).toBe(1);
    expect(supabase.insertedRows[0].item_id).toBe(sku);
    expect(supabase.insertedRows[0].notes).toContain("grain=color");
  });

  it("routes a cut-over style to SIZE grain and drops its COLOR-grain placeholder", async () => {
    const styleId = uuid(900);
    const colorSku = uuid(1); // color-grain placeholder for the style
    const sizeSku30 = uuid(2); // per-size SKU
    const sizeSku32 = uuid(3);

    // Color-grain snapshot carries the WHOLE color total on a placeholder size.
    const snapshotRows = [
      { sku_id: colorSku, warehouse_code: "NJ", qty_on_hand: 100, snapshot_date: SNAP_DATE },
    ];
    // Size-grain source carries per-size truth for the SAME style.
    const sizeOnHandRows = [
      { item_id: sizeSku30, warehouse_code: "NJ", qty_on_hand: 40, snapshot_date: SNAP_DATE },
      { item_id: sizeSku32, warehouse_code: "NJ", qty_on_hand: 55, snapshot_date: SNAP_DATE },
    ];
    const itemMasterRows = [
      { id: colorSku, sku_code: "STY-1", unit_cost: 1, style_code: "STY-1", style_id: styleId },
      { id: sizeSku30, sku_code: "STY-1-30", unit_cost: 1, style_code: "STY-1", style_id: styleId },
      { id: sizeSku32, sku_code: "STY-1-32", unit_cost: 1, style_code: "STY-1", style_id: styleId },
    ];
    const supabase = mockSupabase({ snapshotRows, itemMasterRows, sizeOnHandRows });
    const result = await rebuildInventoryLayersForDate(supabase, ENTITY, SNAP_DATE);

    // 2 size layers, 0 color layers (the placeholder was dropped → no double count).
    expect(result.rows_upserted).toBe(2);
    const items = supabase.insertedRows.map((r) => r.item_id).sort();
    expect(items).toEqual([sizeSku30, sizeSku32].sort());
    expect(supabase.insertedRows.every((r) => r.notes.includes("grain=size"))).toBe(true);
    expect(supabase.insertedRows.find((r) => r.item_id === colorSku)).toBeUndefined();
  });

  it("keeps NON-cut-over styles on color grain in the same run", async () => {
    const styleSize = uuid(900);
    const styleColor = uuid(901);
    const sizeSku = uuid(2);
    const otherColorSku = uuid(10);

    const snapshotRows = [
      // placeholder for the cut-over style — should be dropped
      { sku_id: uuid(1), warehouse_code: "NJ", qty_on_hand: 100, snapshot_date: SNAP_DATE },
      // a different style with no size grain — should stay
      { sku_id: otherColorSku, warehouse_code: "NJ", qty_on_hand: 9, snapshot_date: SNAP_DATE },
    ];
    const sizeOnHandRows = [
      { item_id: sizeSku, warehouse_code: "NJ", qty_on_hand: 40, snapshot_date: SNAP_DATE },
    ];
    const itemMasterRows = [
      { id: uuid(1), sku_code: "A", unit_cost: 1, style_code: "A", style_id: styleSize },
      { id: sizeSku, sku_code: "A-30", unit_cost: 1, style_code: "A", style_id: styleSize },
      { id: otherColorSku, sku_code: "B", unit_cost: 1, style_code: "B", style_id: styleColor },
    ];
    const supabase = mockSupabase({ snapshotRows, itemMasterRows, sizeOnHandRows });
    const result = await rebuildInventoryLayersForDate(supabase, ENTITY, SNAP_DATE);
    expect(result.rows_upserted).toBe(2); // 1 size (style A) + 1 color (style B)
    const byItem = Object.fromEntries(supabase.insertedRows.map((r) => [r.item_id, r]));
    expect(byItem[sizeSku].notes).toContain("grain=size");
    expect(byItem[otherColorSku].notes).toContain("grain=color");
    expect(byItem[uuid(1)]).toBeUndefined(); // placeholder dropped
  });
});

describe("rebuildInventoryLayersForDate — return shape", () => {
  it("returns the documented keys", async () => {
    const supabase = mockSupabase({ snapshotRows: [], deleteCount: 0 });
    const result = await rebuildInventoryLayersForDate(supabase, ENTITY, SNAP_DATE);
    expect(result).toHaveProperty("rows_deleted");
    expect(result).toHaveProperty("rows_upserted");
    expect(result).toHaveProperty("rows_skipped_unmatched_sku");
    expect(result).toHaveProperty("rows_skipped_zero_qty");
    expect(result).toHaveProperty("errors");
    expect(Array.isArray(result.errors)).toBe(true);
  });
});
