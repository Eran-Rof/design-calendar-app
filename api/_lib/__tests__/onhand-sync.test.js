import { describe, it, expect } from "vitest";
import { planOnHandSync, computeManagedStyleIds } from "../inventory/onhand-sync.js";

// Minimal chainable fake of the supabase client for computeManagedStyleIds.
// inventory_layers queries end in .range() (paginated); ip_item_master queries
// end in .in() and are awaited directly (thenable).
function fakeAdmin({ disqLayers, masters }) {
  return {
    from(table) {
      const st = { table, inIds: null };
      const b = {
        select() { return b; },
        eq() { return b; },
        not() { return b; },
        in(_col, ids) { st.inIds = ids; return b; },
        async range(from, to) {
          if (table !== "inventory_layers") return { data: [], error: null };
          return { data: disqLayers.slice(from, to + 1), error: null };
        },
        then(resolve) {
          const rows = table === "ip_item_master"
            ? (st.inIds || []).map((id) => ({ style_id: masters[id] ?? null }))
            : [];
          resolve({ data: rows, error: null });
        },
      };
      return b;
    },
  };
}

const LOCS = new Map([["WH-00000", "loc-main"]]);

function ctx(over = {}) {
  return {
    feedRows: [],
    masterById: new Map(),
    managedStyleIds: new Set(),
    avgCostCentsByCode: new Map(),
    locationIdByCode: LOCS,
    receivedAt: "2026-06-29",
    ...over,
  };
}

describe("planOnHandSync", () => {
  it("emits a sync layer for a managed style present in the feed", () => {
    const masterById = new Map([["sk1", { id: "it1", style_id: "st1", sku_code: "RYB0335-ALOE" }]]);
    const out = planOnHandSync(ctx({
      feedRows: [{ sku_id: "sk1", warehouse_code: "DEFAULT", qty_on_hand: 78 }],
      masterById,
      managedStyleIds: new Set(["st1"]),
      avgCostCentsByCode: new Map([["RYB0335-ALOE", 292]]),
    }));
    expect(out.insert).toEqual([{
      item_id: "it1", location_id: "loc-main", received_at: "2026-06-29",
      original_qty: 78, remaining_qty: 78, unit_cost_cents: 292,
      source_kind: "xoro_onhand_sync", notes: "xoro_onhand_sync:2026-06-29:wh=DEFAULT:grain=color",
    }]);
    expect([...out.touchItemIds]).toEqual(["it1"]);
    expect(out.counts.planned_layers).toBe(1);
  });

  it("zeroes the seed (touches item) but inserts NO layer when feed qty is 0", () => {
    // Sold-through style: feed says 0 → seed must be zeroed, no sync layer added.
    const masterById = new Map([["sk1", { id: "it1", style_id: "st1", sku_code: "RBB0185-OLIVE" }]]);
    const out = planOnHandSync(ctx({
      feedRows: [{ sku_id: "sk1", warehouse_code: "DEFAULT", qty_on_hand: 0 }],
      masterById,
      managedStyleIds: new Set(["st1"]),
    }));
    expect(out.insert).toEqual([]);
    expect([...out.touchItemIds]).toEqual(["it1"]); // still managed → seed zeroed
    expect(out.counts.managed_zero_qty).toBe(1);
  });

  it("skips a style that is NOT mirror-managed (native/by-size) — never touched", () => {
    const masterById = new Map([["sk1", { id: "it1", style_id: "st1", sku_code: "X-RED" }]]);
    const out = planOnHandSync(ctx({
      feedRows: [{ sku_id: "sk1", warehouse_code: "DEFAULT", qty_on_hand: 500 }],
      masterById,
      managedStyleIds: new Set(), // st1 excluded
    }));
    expect(out.insert).toEqual([]);
    expect(out.touchItemIds.size).toBe(0);
    expect(out.counts.skipped_not_managed).toBe(1);
  });

  it("falls back to loose avg-cost key, then 0", () => {
    const masterById = new Map([
      ["a", { id: "ia", style_id: "s", sku_code: "RYB0412-NAVY-CAMO-30" }],
      ["b", { id: "ib", style_id: "s", sku_code: "RYB0412-OTHER-30" }],
    ]);
    const out = planOnHandSync(ctx({
      feedRows: [
        { sku_id: "a", warehouse_code: "DEFAULT", qty_on_hand: 1 },
        { sku_id: "b", warehouse_code: "DEFAULT", qty_on_hand: 1 },
      ],
      masterById,
      managedStyleIds: new Set(["s"]),
      // exact miss for a, loose hit; nothing for b → 0
      avgCostCentsByCode: new Map([["loose:RYB0412NAVYCAMO30", 555]]),
    }));
    expect(out.insert.find((r) => r.item_id === "ia").unit_cost_cents).toBe(555);
    expect(out.insert.find((r) => r.item_id === "ib").unit_cost_cents).toBe(0);
  });

  it("skips a feed row whose warehouse_code has no location mapping", () => {
    const masterById = new Map([["sk1", { id: "it1", style_id: "st1", sku_code: "Z" }]]);
    const out = planOnHandSync(ctx({
      feedRows: [{ sku_id: "sk1", warehouse_code: "MARS_WH", qty_on_hand: 9 }],
      masterById,
      managedStyleIds: new Set(["st1"]),
    }));
    expect(out.insert).toEqual([]);
    expect(out.counts.skipped_no_location).toBe(1);
    expect(out.touchItemIds.size).toBe(0);
  });

  it("skips a feed row with no master", () => {
    const out = planOnHandSync(ctx({
      feedRows: [{ sku_id: "ghost", warehouse_code: "DEFAULT", qty_on_hand: 5 }],
      managedStyleIds: new Set(["st1"]),
    }));
    expect(out.counts.skipped_no_master).toBe(1);
  });
});

describe("computeManagedStyleIds (cap-safe disqualify scan)", () => {
  it("excludes any feed style that has a non-mirror layer; keeps the rest", async () => {
    // st-bysize owns a xoro_rest_size layer (item iz); st-native a po_receipt
    // (item ip). st-clean has only an opening_balance item (never in disqLayers).
    const disqLayers = [{ item_id: "iz" }, { item_id: "ip" }];
    const masters = { iz: "st-bysize", ip: "st-native" };
    const managed = await computeManagedStyleIds(
      fakeAdmin({ disqLayers, masters }),
      "ent",
      ["st-clean", "st-bysize", "st-native", "st-empty"],
    );
    expect([...managed].sort()).toEqual(["st-clean", "st-empty"]);
  });

  it("paginates the disqualify scan past the 1000-row cap", async () => {
    // 1500 disqualifying layers for one style must all be read → that style is
    // excluded even though it spans two pages.
    const disqLayers = Array.from({ length: 1500 }, (_, i) => ({ item_id: `i${i}` }));
    const masters = Object.fromEntries(disqLayers.map((l) => [l.item_id, "st-big"]));
    const managed = await computeManagedStyleIds(
      fakeAdmin({ disqLayers, masters }),
      "ent",
      ["st-big", "st-ok"],
    );
    expect([...managed]).toEqual(["st-ok"]);
  });
});
