// Tests for the Tangerine P9-6 Inventory reconciliation engine.
//
// Architecture: docs/tangerine/P9-parallel-run-architecture.md §3.5 + §4.4.
// Schema:       supabase/migrations/20260629800000_p9_chunk1_recon_schema.sql
//
// All tests run against an in-memory supabase double — no live DB.

import { describe, it, expect } from "vitest";
import {
  runInventoryReconciliation,
  validateArgs,
  buildLayerKey,
  buildMatchKey,
  layerValueCents,
  bucketLayersByGroup,
  collapseToMatchBuckets,
  matchInventory,
  applyThresholds,
  __test_only__,
} from "../inventory-engine.js";

const ENTITY = "11111111-1111-1111-1111-111111111111";
const PERIOD_START = "2026-05-01";
const PERIOD_END = "2026-05-31";

// Location fixtures.
const LOC_MAIN = { id: "loc-main", code: "MAIN-WH", kind: "warehouse" };
const LOC_FBA  = { id: "loc-fba",  code: "FBA_US",  kind: "fba" };
const LOC_WFS  = { id: "loc-wfs",  code: "WFS_US",  kind: "wfs" };
const LOC_3PL  = { id: "loc-3pl",  code: "3PL_WEST",kind: "3pl" };
const LOC_DROP = { id: "loc-drop", code: "DROP",    kind: "dropship" };
const LOC_VIRT = { id: "loc-virt", code: "VIRT",    kind: "virtual" };
const LOC_WH2  = { id: "loc-wh2",  code: "OVERFLOW",kind: "warehouse" };

const ALL_LOCS = [LOC_MAIN, LOC_FBA, LOC_WFS, LOC_3PL, LOC_DROP, LOC_VIRT, LOC_WH2];

// ──────────────────────────────────────────────────────────────────────────
// In-memory supabase double
// ──────────────────────────────────────────────────────────────────────────

/**
 * Build a supabase admin double parameterized by:
 *   inventoryLayers   rows in `inventory_layers` (both sides — separated
 *                     by source_kind = 'xoro_mirror_snapshot' vs other)
 *   inventoryLocations array of {id, code, kind} location rows
 *   reconRunsInsertError / reconVariancesInsertError / reconRunsUpdateError
 *   layersReadError   optional → injected on the inventory_layers SELECT
 *   locationsReadError optional → injected on the inventory_locations SELECT
 *   reconRunId        uuid the recon_runs INSERT returns
 */
function makeSupabase({
  inventoryLayers = [],
  inventoryLocations = ALL_LOCS,
  reconRunsInsertError = null,
  reconVariancesInsertError = null,
  reconRunsUpdateError = null,
  layersReadError = null,
  locationsReadError = null,
  reconRunId = "rrr-1",
} = {}) {
  const captured = {
    runsInserts: [],
    runsUpdates: [],
    variancesInserts: [],
    layerReads: 0,
  };
  const sb = {
    captured,
    from(table) {
      if (table === "recon_runs") return makeReconRunsBuilder(captured, reconRunsInsertError, reconRunsUpdateError, reconRunId);
      if (table === "recon_variances") return makeReconVariancesBuilder(captured, reconVariancesInsertError);
      if (table === "inventory_layers") return makeLayersBuilder(captured, inventoryLayers, layersReadError);
      if (table === "inventory_locations") return makeLocationsBuilder(inventoryLocations, locationsReadError);
      throw new Error(`unexpected table ${table}`);
    },
  };
  return sb;
}

function makeReconRunsBuilder(captured, insertError, updateError, fakeId) {
  let pendingInsert = null;
  let updatePayload = null;
  let idFilter = null;
  const builder = {
    insert(payload) {
      pendingInsert = payload;
      return {
        select() { return this; },
        single() {
          if (insertError) return Promise.resolve({ data: null, error: { message: insertError } });
          captured.runsInserts.push(payload);
          return Promise.resolve({ data: { id: fakeId }, error: null });
        },
      };
    },
    update(payload) {
      updatePayload = payload;
      return {
        eq(col, val) {
          if (col === "id") idFilter = val;
          return this;
        },
        then(resolve) {
          if (updateError) return resolve({ data: null, error: { message: updateError } });
          captured.runsUpdates.push({ id: idFilter, payload: updatePayload });
          return resolve({ data: null, error: null });
        },
      };
    },
  };
  return builder;
}

function makeReconVariancesBuilder(captured, insertError) {
  return {
    insert(payload) {
      if (insertError) return Promise.resolve({ data: null, error: { message: insertError } });
      captured.variancesInserts.push(payload);
      return Promise.resolve({ data: null, error: null });
    },
  };
}

function makeLayersBuilder(captured, rows, readError) {
  const filters = {
    entity_id: null,
    eq_source_kind: null,
    neq_source_kind: null,
    lte_received_at: null,
  };
  let rangeStart = null;
  let rangeEnd = null;
  const builder = {
    select() { return builder; },
    eq(col, val) {
      if (col === "entity_id") filters.entity_id = val;
      else if (col === "source_kind") filters.eq_source_kind = val;
      return builder;
    },
    neq(col, val) {
      if (col === "source_kind") filters.neq_source_kind = val;
      return builder;
    },
    lte(col, val) {
      if (col === "received_at") filters.lte_received_at = val;
      return builder;
    },
    range(a, b) { rangeStart = a; rangeEnd = b; return builder; },
    then(resolve) {
      if (readError) return resolve({ data: null, error: { message: readError } });
      captured.layerReads += 1;
      let out = rows;
      if (filters.entity_id != null) out = out.filter((r) => r.entity_id === filters.entity_id);
      if (filters.eq_source_kind != null) out = out.filter((r) => r.source_kind === filters.eq_source_kind);
      if (filters.neq_source_kind != null) out = out.filter((r) => r.source_kind !== filters.neq_source_kind);
      if (filters.lte_received_at != null) out = out.filter((r) => r.received_at <= filters.lte_received_at);
      if (rangeStart != null && rangeEnd != null) out = out.slice(rangeStart, rangeEnd + 1);
      return resolve({ data: out, error: null });
    },
  };
  return builder;
}

function makeLocationsBuilder(rows, readError) {
  const filters = { entity_id: null };
  const builder = {
    select() { return builder; },
    eq(col, val) { filters[col] = val; return builder; },
    then(resolve) {
      if (readError) return resolve({ data: null, error: { message: readError } });
      // Locations are entity-scoped via RLS in prod; the double returns
      // all rows since fixtures don't tag entity_id on locations.
      return resolve({ data: rows, error: null });
    },
  };
  return builder;
}

// Fixture helpers.
function layer({
  id,
  item_id,
  location_id,
  source_kind = "ap_invoice",
  remaining_qty,
  unit_cost_cents,
  received_at = "2026-05-15T12:00:00.000Z",
  entity_id = ENTITY,
}) {
  return { id, item_id, location_id, source_kind, remaining_qty, unit_cost_cents, received_at, entity_id };
}

function mirror(args) {
  return layer({ ...args, source_kind: "xoro_mirror_snapshot" });
}

// ──────────────────────────────────────────────────────────────────────────
// Pure helper tests
// ──────────────────────────────────────────────────────────────────────────

describe("layerValueCents", () => {
  it("multiplies qty × unit_cost_cents and rounds", () => {
    expect(layerValueCents(10, 250)).toBe(2500);
  });
  it("handles fractional qty (numeric(18,4))", () => {
    expect(layerValueCents(2.5, 200)).toBe(500);
  });
  it("rounds 0.5 up", () => {
    expect(layerValueCents(1, 101)).toBe(101);
    // 1.5 * 100 = 150
    expect(layerValueCents(1.5, 100)).toBe(150);
  });
  it("returns 0 for null/undefined", () => {
    expect(layerValueCents(null, 250)).toBe(0);
    expect(layerValueCents(10, null)).toBe(0);
    expect(layerValueCents(null, null)).toBe(0);
  });
  it("returns 0 for non-finite", () => {
    expect(layerValueCents(NaN, 250)).toBe(0);
    expect(layerValueCents(Infinity, 250)).toBe(0);
  });
});

describe("buildLayerKey", () => {
  it("composes item + location + kind", () => {
    expect(buildLayerKey("i1", "loc-main", "ap_invoice")).toBe("i1::loc-main::ap_invoice");
  });
  it("sentinels null location", () => {
    expect(buildLayerKey("i1", null, "ap_invoice")).toBe("i1::__null_location__::ap_invoice");
  });
  it("sentinels null source_kind", () => {
    expect(buildLayerKey("i1", "loc-main", null)).toBe("i1::loc-main::unknown");
  });
});

describe("buildMatchKey", () => {
  it("composes item + location only (source_kind collapses)", () => {
    expect(buildMatchKey("i1", "loc-main")).toBe("i1::loc-main");
  });
  it("sentinels null location", () => {
    expect(buildMatchKey("i1", null)).toBe("i1::__null_location__");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// validateArgs
// ──────────────────────────────────────────────────────────────────────────

describe("validateArgs", () => {
  const ok = { entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END };

  it("accepts a minimal valid arg bag with defaults", () => {
    const r = validateArgs(ok);
    expect(r.error).toBeUndefined();
    expect(r.data.cadence).toBe("weekly");
    expect(r.data.replay_of_id).toBeNull();
  });
  it("rejects missing entity_id", () => {
    expect(validateArgs({ period_start: PERIOD_START, period_end: PERIOD_END }).error).toMatch(/entity_id/);
  });
  it("rejects bad period_start format", () => {
    expect(validateArgs({ ...ok, period_start: "2026/05/01" }).error).toMatch(/period_start/);
  });
  it("rejects bad period_end format", () => {
    expect(validateArgs({ ...ok, period_end: "May 31, 2026" }).error).toMatch(/period_end/);
  });
  it("rejects period_end < period_start", () => {
    expect(validateArgs({ ...ok, period_end: "2026-04-01" }).error).toMatch(/period_end must be >=/);
  });
  it("accepts cadence='manual' and 'replay'", () => {
    expect(validateArgs({ ...ok, cadence: "manual" }).data.cadence).toBe("manual");
    expect(validateArgs({ ...ok, cadence: "replay" }).data.cadence).toBe("replay");
  });
  it("rejects bogus cadence", () => {
    expect(validateArgs({ ...ok, cadence: "yearly" }).error).toMatch(/cadence/);
  });
  it("preserves replay_of_id when provided", () => {
    const r = validateArgs({ ...ok, replay_of_id: "abc" });
    expect(r.data.replay_of_id).toBe("abc");
  });
  it("rejects non-string replay_of_id", () => {
    expect(validateArgs({ ...ok, replay_of_id: 42 }).error).toMatch(/replay_of_id/);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// bucketLayersByGroup + collapseToMatchBuckets
// ──────────────────────────────────────────────────────────────────────────

describe("bucketLayersByGroup", () => {
  it("groups layers by (item, location, source_kind)", () => {
    const rows = [
      layer({ id: "l1", item_id: "i1", location_id: "loc-main", source_kind: "ap_invoice", remaining_qty: 10, unit_cost_cents: 100 }),
      layer({ id: "l2", item_id: "i1", location_id: "loc-main", source_kind: "ap_invoice", remaining_qty: 5, unit_cost_cents: 100 }),
      layer({ id: "l3", item_id: "i1", location_id: "loc-main", source_kind: "adjustment", remaining_qty: 2, unit_cost_cents: 100 }),
    ];
    const m = bucketLayersByGroup(rows);
    expect(m.size).toBe(2);
    expect(m.get("i1::loc-main::ap_invoice").value_cents).toBe(1500);
    expect(m.get("i1::loc-main::ap_invoice").layer_count).toBe(2);
    expect(m.get("i1::loc-main::adjustment").value_cents).toBe(200);
  });
  it("separates different locations", () => {
    const rows = [
      layer({ id: "l1", item_id: "i1", location_id: "loc-main", remaining_qty: 10, unit_cost_cents: 100 }),
      layer({ id: "l2", item_id: "i1", location_id: "loc-fba",  remaining_qty: 10, unit_cost_cents: 100 }),
    ];
    const m = bucketLayersByGroup(rows);
    expect(m.size).toBe(2);
  });
  it("buckets NULL location under sentinel", () => {
    const rows = [
      layer({ id: "l1", item_id: "i1", location_id: null, remaining_qty: 5, unit_cost_cents: 100 }),
      layer({ id: "l2", item_id: "i1", location_id: null, remaining_qty: 5, unit_cost_cents: 100 }),
    ];
    const m = bucketLayersByGroup(rows);
    expect(m.size).toBe(1);
    expect([...m.values()][0].value_cents).toBe(1000);
  });
});

describe("collapseToMatchBuckets", () => {
  it("sums values across source_kinds for the same (item, location)", () => {
    const layerBuckets = bucketLayersByGroup([
      layer({ id: "l1", item_id: "i1", location_id: "loc-main", source_kind: "ap_invoice", remaining_qty: 10, unit_cost_cents: 100 }),
      layer({ id: "l2", item_id: "i1", location_id: "loc-main", source_kind: "adjustment", remaining_qty: 2, unit_cost_cents: 100 }),
    ]);
    const matches = collapseToMatchBuckets(layerBuckets);
    expect(matches.size).toBe(1);
    const m = matches.get("i1::loc-main");
    expect(m.value_cents).toBe(1200);
    expect(m.source_kinds).toContain("ap_invoice");
    expect(m.source_kinds).toContain("adjustment");
  });
  it("preserves per-channel source_kinds list (D7)", () => {
    const layerBuckets = bucketLayersByGroup([
      layer({ id: "l1", item_id: "i1", location_id: "loc-fba", source_kind: "fba_inbound", remaining_qty: 1, unit_cost_cents: 100 }),
    ]);
    const m = collapseToMatchBuckets(layerBuckets);
    expect(m.get("i1::loc-fba").source_kinds).toEqual(["fba_inbound"]);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// matchInventory
// ──────────────────────────────────────────────────────────────────────────

function locationsMap(arr = ALL_LOCS) {
  const m = new Map();
  for (const l of arr) m.set(l.id, l);
  return m;
}

describe("matchInventory", () => {
  const locs = locationsMap();

  it("emits zero variance when sides match exactly at Main-WH", () => {
    const t = collapseToMatchBuckets(bucketLayersByGroup([
      layer({ id: "l1", item_id: "i1", location_id: "loc-main", source_kind: "ap_invoice", remaining_qty: 10, unit_cost_cents: 100 }),
    ]));
    const x = collapseToMatchBuckets(bucketLayersByGroup([
      mirror({ id: "x1", item_id: "i1", location_id: "loc-main", remaining_qty: 10, unit_cost_cents: 100 }),
    ]));
    const v = matchInventory(t, x, locs);
    expect(v).toHaveLength(1);
    expect(v[0].variance_amount_cents).toBe(0);
    expect(v[0].is_skipped).toBe(false);
    expect(v[0].location_kind).toBe("warehouse");
  });

  it("emits positive variance when Tangerine > Xoro at Main-WH", () => {
    const t = collapseToMatchBuckets(bucketLayersByGroup([
      layer({ id: "l1", item_id: "i1", location_id: "loc-main", remaining_qty: 12, unit_cost_cents: 100 }),
    ]));
    const x = collapseToMatchBuckets(bucketLayersByGroup([
      mirror({ id: "x1", item_id: "i1", location_id: "loc-main", remaining_qty: 10, unit_cost_cents: 100 }),
    ]));
    const v = matchInventory(t, x, locs);
    expect(v[0].variance_amount_cents).toBe(200);
    expect(v[0].tangerine_amount_cents).toBe(1200);
    expect(v[0].xoro_amount_cents).toBe(1000);
  });

  it("emits negative variance when Tangerine < Xoro at Main-WH", () => {
    const t = collapseToMatchBuckets(bucketLayersByGroup([
      layer({ id: "l1", item_id: "i1", location_id: "loc-main", remaining_qty: 9, unit_cost_cents: 100 }),
    ]));
    const x = collapseToMatchBuckets(bucketLayersByGroup([
      mirror({ id: "x1", item_id: "i1", location_id: "loc-main", remaining_qty: 10, unit_cost_cents: 100 }),
    ]));
    const v = matchInventory(t, x, locs);
    expect(v[0].variance_amount_cents).toBe(-100);
  });

  it("marks FBA-location rows as is_skipped with location_not_in_xoro note", () => {
    const t = collapseToMatchBuckets(bucketLayersByGroup([
      layer({ id: "l1", item_id: "i1", location_id: "loc-fba", source_kind: "fba_inbound", remaining_qty: 10, unit_cost_cents: 500 }),
    ]));
    const x = collapseToMatchBuckets(bucketLayersByGroup([]));
    const v = matchInventory(t, x, locs);
    expect(v).toHaveLength(1);
    expect(v[0].is_skipped).toBe(true);
    expect(v[0].notes).toBe("location_not_in_xoro");
    expect(v[0].variance_amount_cents).toBe(5000);
  });

  it("marks WFS-location rows as is_skipped with location_not_in_xoro note", () => {
    const t = collapseToMatchBuckets(bucketLayersByGroup([
      layer({ id: "l1", item_id: "i1", location_id: "loc-wfs", source_kind: "wfs_inbound", remaining_qty: 4, unit_cost_cents: 500 }),
    ]));
    const v = matchInventory(t, collapseToMatchBuckets(bucketLayersByGroup([])), locs);
    expect(v[0].is_skipped).toBe(true);
    expect(v[0].notes).toBe("location_not_in_xoro");
  });

  it("marks 3PL / dropship / virtual locations as skipped too", () => {
    for (const loc of [LOC_3PL, LOC_DROP, LOC_VIRT]) {
      const t = collapseToMatchBuckets(bucketLayersByGroup([
        layer({ id: "l1", item_id: "i1", location_id: loc.id, remaining_qty: 1, unit_cost_cents: 500 }),
      ]));
      const v = matchInventory(t, collapseToMatchBuckets(bucketLayersByGroup([])), locs);
      expect(v[0].is_skipped).toBe(true);
      expect(v[0].notes).toBe("location_not_in_xoro");
    }
  });

  it("does NOT skip second warehouse-kind location (Main-WH-2)", () => {
    const t = collapseToMatchBuckets(bucketLayersByGroup([
      layer({ id: "l1", item_id: "i1", location_id: "loc-wh2", remaining_qty: 10, unit_cost_cents: 100 }),
    ]));
    const v = matchInventory(t, collapseToMatchBuckets(bucketLayersByGroup([])), locs);
    expect(v[0].is_skipped).toBe(false);
    expect(v[0].notes).toBeNull();
  });

  it("emits Xoro-only row when Tangerine never received the layer", () => {
    const t = collapseToMatchBuckets(bucketLayersByGroup([]));
    const x = collapseToMatchBuckets(bucketLayersByGroup([
      mirror({ id: "x1", item_id: "i9", location_id: "loc-main", remaining_qty: 8, unit_cost_cents: 100 }),
    ]));
    const v = matchInventory(t, x, locs);
    expect(v).toHaveLength(1);
    expect(v[0].variance_amount_cents).toBe(-800);
    expect(v[0].tangerine_amount_cents).toBe(0);
    expect(v[0].source_tag).toBe("xoro_mirror_snapshot");
    expect(v[0].is_skipped).toBe(false);
  });

  it("treats different items as separate rows", () => {
    const t = collapseToMatchBuckets(bucketLayersByGroup([
      layer({ id: "l1", item_id: "i1", location_id: "loc-main", remaining_qty: 1, unit_cost_cents: 100 }),
      layer({ id: "l2", item_id: "i2", location_id: "loc-main", remaining_qty: 1, unit_cost_cents: 100 }),
    ]));
    const v = matchInventory(t, collapseToMatchBuckets(bucketLayersByGroup([])), locs);
    expect(v).toHaveLength(2);
  });

  it("treats same item at different locations as separate rows", () => {
    const t = collapseToMatchBuckets(bucketLayersByGroup([
      layer({ id: "l1", item_id: "i1", location_id: "loc-main", remaining_qty: 1, unit_cost_cents: 100 }),
      layer({ id: "l2", item_id: "i1", location_id: "loc-fba",  source_kind: "fba_inbound", remaining_qty: 1, unit_cost_cents: 100 }),
    ]));
    const v = matchInventory(t, collapseToMatchBuckets(bucketLayersByGroup([])), locs);
    expect(v).toHaveLength(2);
    const fbaRow = v.find((r) => r.location_id === "loc-fba");
    const mainRow = v.find((r) => r.location_id === "loc-main");
    expect(fbaRow.is_skipped).toBe(true);
    expect(mainRow.is_skipped).toBe(false);
  });

  it("sums source_tag join across multiple source_kinds at one (item, location)", () => {
    const t = collapseToMatchBuckets(bucketLayersByGroup([
      layer({ id: "l1", item_id: "i1", location_id: "loc-main", source_kind: "ap_invoice", remaining_qty: 5, unit_cost_cents: 100 }),
      layer({ id: "l2", item_id: "i1", location_id: "loc-main", source_kind: "adjustment", remaining_qty: 1, unit_cost_cents: 100 }),
    ]));
    const v = matchInventory(t, collapseToMatchBuckets(bucketLayersByGroup([])), locs);
    expect(v[0].source_tag).toBe("adjustment+ap_invoice"); // sorted join
    expect(v[0].tangerine_amount_cents).toBe(600);
  });

  it("handles unknown location_id (not in locations map) — does not skip", () => {
    const t = collapseToMatchBuckets(bucketLayersByGroup([
      layer({ id: "l1", item_id: "i1", location_id: "loc-unknown", remaining_qty: 1, unit_cost_cents: 100 }),
    ]));
    const v = matchInventory(t, collapseToMatchBuckets(bucketLayersByGroup([])), locs);
    expect(v[0].is_skipped).toBe(false);
    expect(v[0].location_kind).toBeNull();
  });

  it("handles NULL location_id (legacy layer) — does not skip", () => {
    const t = collapseToMatchBuckets(bucketLayersByGroup([
      layer({ id: "l1", item_id: "i1", location_id: null, remaining_qty: 1, unit_cost_cents: 100 }),
    ]));
    const v = matchInventory(t, collapseToMatchBuckets(bucketLayersByGroup([])), locs);
    expect(v[0].is_skipped).toBe(false);
    expect(v[0].location_id).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// applyThresholds
// ──────────────────────────────────────────────────────────────────────────

describe("applyThresholds", () => {
  it("classifies sub-$50 variance as 'within'", () => {
    const r = applyThresholds([
      { variance_amount_cents: 4999, item_id: "i1", location_id: "loc-main", location_kind: "warehouse", source_tag: "ap_invoice", tangerine_amount_cents: 4999, xoro_amount_cents: 0, is_skipped: false, notes: null },
    ]);
    expect(r.variances_with_status[0].status).toBe("within");
    expect(r.summary.variances_found).toBe(0);
    expect(r.summary.run_status).toBe("clean");
  });
  it("classifies $50 variance as 'over' (>= threshold)", () => {
    const r = applyThresholds([
      { variance_amount_cents: 5000, item_id: "i1", location_id: "loc-main", location_kind: "warehouse", source_tag: "ap_invoice", tangerine_amount_cents: 5000, xoro_amount_cents: 0, is_skipped: false, notes: null },
    ]);
    expect(r.variances_with_status[0].status).toBe("over");
    expect(r.summary.variances_found).toBe(1);
  });
  it("uses absolute value for threshold comparison (negative variance)", () => {
    const r = applyThresholds([
      { variance_amount_cents: -6000, item_id: "i1", location_id: "loc-main", location_kind: "warehouse", source_tag: "ap_invoice", tangerine_amount_cents: 0, xoro_amount_cents: 6000, is_skipped: false, notes: null },
    ]);
    expect(r.variances_with_status[0].status).toBe("over");
    expect(r.summary.total_variance_cents).toBe(6000);
  });
  it("marks run 'clean' when total |over| <= $250", () => {
    const r = applyThresholds([
      { variance_amount_cents: 10000, item_id: "i1", location_id: "loc-main", location_kind: "warehouse", source_tag: "x", tangerine_amount_cents: 10000, xoro_amount_cents: 0, is_skipped: false, notes: null },
      { variance_amount_cents: 10000, item_id: "i2", location_id: "loc-main", location_kind: "warehouse", source_tag: "x", tangerine_amount_cents: 10000, xoro_amount_cents: 0, is_skipped: false, notes: null },
    ]);
    // 10000 + 10000 = 20000 cents = $200 — under $250 domain threshold
    expect(r.summary.run_status).toBe("clean");
  });
  it("marks run 'variance' when total |over| > $250", () => {
    const r = applyThresholds([
      { variance_amount_cents: 15000, item_id: "i1", location_id: "loc-main", location_kind: "warehouse", source_tag: "x", tangerine_amount_cents: 15000, xoro_amount_cents: 0, is_skipped: false, notes: null },
      { variance_amount_cents: 12000, item_id: "i2", location_id: "loc-main", location_kind: "warehouse", source_tag: "x", tangerine_amount_cents: 12000, xoro_amount_cents: 0, is_skipped: false, notes: null },
    ]);
    expect(r.summary.run_status).toBe("variance");
    expect(r.summary.variances_found).toBe(2);
    expect(r.summary.total_variance_cents).toBe(27000);
  });
  it("excludes skipped (FBA/WFS) rows from threshold accounting", () => {
    const r = applyThresholds([
      // Huge skipped variance — would otherwise trip 'variance'.
      { variance_amount_cents: 1_000_000, item_id: "i1", location_id: "loc-fba", location_kind: "fba", source_tag: "fba_inbound", tangerine_amount_cents: 1_000_000, xoro_amount_cents: 0, is_skipped: true, notes: "location_not_in_xoro" },
    ]);
    expect(r.summary.run_status).toBe("clean");
    expect(r.summary.variances_found).toBe(0);
    expect(r.summary.skipped_count).toBe(1);
    expect(r.variances_with_status[0].status).toBe("within");
  });
  it("exposes per-row + per-domain threshold values in summary", () => {
    const r = applyThresholds([]);
    expect(r.summary.per_row_threshold_cents).toBe(5000);
    expect(r.summary.per_domain_threshold_cents).toBe(25000);
  });
  it("rows_compared reflects total input rows (including within and skipped)", () => {
    const r = applyThresholds([
      { variance_amount_cents: 100, item_id: "i1", location_id: "loc-main", location_kind: "warehouse", source_tag: "x", tangerine_amount_cents: 100, xoro_amount_cents: 0, is_skipped: false, notes: null },
      { variance_amount_cents: 9000, item_id: "i2", location_id: "loc-main", location_kind: "warehouse", source_tag: "x", tangerine_amount_cents: 9000, xoro_amount_cents: 0, is_skipped: false, notes: null },
      { variance_amount_cents: 999, item_id: "i3", location_id: "loc-fba", location_kind: "fba", source_tag: "fba_inbound", tangerine_amount_cents: 999, xoro_amount_cents: 0, is_skipped: true, notes: "location_not_in_xoro" },
    ]);
    expect(r.summary.rows_compared).toBe(3);
    expect(r.summary.variances_found).toBe(1);
    expect(r.summary.skipped_count).toBe(1);
  });
  it("builds per_location summary with rows/over/skipped/variance breakdown", () => {
    const r = applyThresholds([
      { variance_amount_cents: 8000, item_id: "i1", location_id: "loc-main", location_kind: "warehouse", source_tag: "x", tangerine_amount_cents: 8000, xoro_amount_cents: 0, is_skipped: false, notes: null },
      { variance_amount_cents: 100, item_id: "i2", location_id: "loc-main", location_kind: "warehouse", source_tag: "x", tangerine_amount_cents: 100, xoro_amount_cents: 0, is_skipped: false, notes: null },
      { variance_amount_cents: 50000, item_id: "i3", location_id: "loc-fba", location_kind: "fba", source_tag: "fba_inbound", tangerine_amount_cents: 50000, xoro_amount_cents: 0, is_skipped: true, notes: "location_not_in_xoro" },
    ]);
    expect(r.summary.per_location["loc-main"].rows).toBe(2);
    expect(r.summary.per_location["loc-main"].over).toBe(1);
    expect(r.summary.per_location["loc-main"].skipped).toBe(0);
    expect(r.summary.per_location["loc-main"].variance_cents).toBe(8000);
    expect(r.summary.per_location["loc-fba"].rows).toBe(1);
    expect(r.summary.per_location["loc-fba"].over).toBe(0);
    expect(r.summary.per_location["loc-fba"].skipped).toBe(1);
    expect(r.summary.per_location["loc-fba"].variance_cents).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// runInventoryReconciliation — end-to-end
// ──────────────────────────────────────────────────────────────────────────

describe("runInventoryReconciliation", () => {
  it("returns 'clean' on empty period (no layers either side)", async () => {
    const admin = makeSupabase({ inventoryLayers: [] });
    const r = await runInventoryReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.status).toBe("clean");
    expect(r.rows_compared).toBe(0);
    expect(r.variances_found).toBe(0);
    expect(r.total_variance_cents).toBe(0);
    expect(r.errors).toEqual([]);
    expect(admin.captured.runsInserts).toHaveLength(1);
    expect(admin.captured.runsInserts[0].domain).toBe("inventory");
    expect(admin.captured.runsInserts[0].status).toBe("running");
    expect(admin.captured.runsUpdates).toHaveLength(1);
    expect(admin.captured.runsUpdates[0].payload.status).toBe("clean");
    expect(admin.captured.variancesInserts).toHaveLength(0);
  });

  it("returns 'clean' when matched sides agree exactly", async () => {
    const admin = makeSupabase({
      inventoryLayers: [
        layer({ id: "l1", item_id: "i1", location_id: "loc-main", remaining_qty: 10, unit_cost_cents: 100 }),
        mirror({ id: "x1", item_id: "i1", location_id: "loc-main", remaining_qty: 10, unit_cost_cents: 100 }),
      ],
    });
    const r = await runInventoryReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.status).toBe("clean");
    expect(r.variances_found).toBe(0);
    expect(admin.captured.variancesInserts).toHaveLength(0);
  });

  it("emits one over-row variance when Tangerine over-states by $80", async () => {
    const admin = makeSupabase({
      inventoryLayers: [
        layer({ id: "l1", item_id: "i1", location_id: "loc-main", remaining_qty: 18, unit_cost_cents: 1000 }), // 18000c
        mirror({ id: "x1", item_id: "i1", location_id: "loc-main", remaining_qty: 10, unit_cost_cents: 1000 }), // 10000c
      ],
    });
    const r = await runInventoryReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    // $80 > $50/row but $80 < $250/domain → run 'clean', row 'over'
    expect(r.status).toBe("clean");
    expect(r.variances_found).toBe(1);
    expect(r.total_variance_cents).toBe(8000);
    expect(admin.captured.variancesInserts).toHaveLength(1);
    const vRow = admin.captured.variancesInserts[0][0];
    expect(vRow.source_table).toBe("inventory_layers");
    expect(vRow.source_id).toBe("i1::loc-main");
    expect(vRow.variance_amount_cents).toBe(8000);
    expect(vRow.status).toBe("over");
  });

  it("marks run 'variance' when domain total exceeds $250", async () => {
    const admin = makeSupabase({
      inventoryLayers: [
        layer({ id: "l1", item_id: "i1", location_id: "loc-main", remaining_qty: 200, unit_cost_cents: 1000 }), // 200000c
        mirror({ id: "x1", item_id: "i1", location_id: "loc-main", remaining_qty: 100, unit_cost_cents: 1000 }), //  100000c (delta 100000c = $1000)
        layer({ id: "l2", item_id: "i2", location_id: "loc-main", remaining_qty: 50, unit_cost_cents: 1000 }), // 50000c (xoro 0)
      ],
    });
    const r = await runInventoryReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.status).toBe("variance");
    expect(r.variances_found).toBe(2);
    expect(r.total_variance_cents).toBe(150000); // $1500
  });

  it("respects per-row threshold ($49.99 variance = within, no variances_found bump)", async () => {
    const admin = makeSupabase({
      inventoryLayers: [
        layer({ id: "l1", item_id: "i1", location_id: "loc-main", remaining_qty: 4999, unit_cost_cents: 1 }), // 4999c
        mirror({ id: "x1", item_id: "i1", location_id: "loc-main", remaining_qty: 0, unit_cost_cents: 1 }),
      ],
    });
    const r = await runInventoryReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.status).toBe("clean");
    expect(r.variances_found).toBe(0);
    // Below-threshold row with non-zero variance is still persisted (so the
    // dashboard can render it as informational), but status='within'.
    expect(admin.captured.variancesInserts).toHaveLength(1);
    expect(admin.captured.variancesInserts[0][0].status).toBe("within");
  });

  it("FBA layer with huge delta is persisted as within + skipped, NOT counted in domain", async () => {
    const admin = makeSupabase({
      inventoryLayers: [
        // Huge FBA layer that would otherwise trip 'variance'
        layer({ id: "l1", item_id: "i1", location_id: "loc-fba", source_kind: "fba_inbound", remaining_qty: 1000, unit_cost_cents: 1000 }),
        // Plus a small Main-WH layer that's within threshold
        layer({ id: "l2", item_id: "i2", location_id: "loc-main", remaining_qty: 10, unit_cost_cents: 100 }),
        mirror({ id: "x2", item_id: "i2", location_id: "loc-main", remaining_qty: 10, unit_cost_cents: 100 }),
      ],
    });
    const r = await runInventoryReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.status).toBe("clean");
    expect(r.variances_found).toBe(0);
    expect(r.totals_jsonb.skipped_count).toBe(1);
    // The FBA row IS persisted (audit trail), but with within + notes.
    expect(admin.captured.variancesInserts).toHaveLength(1);
    const vRow = admin.captured.variancesInserts[0][0];
    expect(vRow.status).toBe("within");
    expect(vRow.notes).toBe("location_not_in_xoro");
    expect(vRow.source_id).toBe("i1::loc-fba");
  });

  it("WFS layer is also marked location_not_in_xoro and skipped", async () => {
    const admin = makeSupabase({
      inventoryLayers: [
        layer({ id: "l1", item_id: "i1", location_id: "loc-wfs", source_kind: "wfs_inbound", remaining_qty: 50, unit_cost_cents: 1000 }),
      ],
    });
    const r = await runInventoryReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.status).toBe("clean");
    const vRow = admin.captured.variancesInserts[0][0];
    expect(vRow.notes).toBe("location_not_in_xoro");
    expect(vRow.status).toBe("within");
  });

  it("emits Xoro-only row when Tangerine never received the SKU/loc layer", async () => {
    const admin = makeSupabase({
      inventoryLayers: [
        mirror({ id: "x1", item_id: "i9", location_id: "loc-main", remaining_qty: 100, unit_cost_cents: 500 }), // 50000c
      ],
    });
    const r = await runInventoryReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.variances_found).toBe(1);
    expect(r.total_variance_cents).toBe(50000);
    const vRow = admin.captured.variancesInserts[0][0];
    expect(vRow.tangerine_amount_cents).toBe(0);
    expect(vRow.xoro_amount_cents).toBe(50000);
    expect(vRow.variance_amount_cents).toBe(-50000);
    expect(vRow.source_tag).toBe("xoro_mirror_snapshot");
  });

  it("collapses multiple source_kinds at one (item, location) before matching", async () => {
    const admin = makeSupabase({
      inventoryLayers: [
        layer({ id: "l1", item_id: "i1", location_id: "loc-main", source_kind: "ap_invoice", remaining_qty: 5, unit_cost_cents: 1000 }), // 5000c
        layer({ id: "l2", item_id: "i1", location_id: "loc-main", source_kind: "adjustment", remaining_qty: 5, unit_cost_cents: 1000 }), // 5000c
        mirror({ id: "x1", item_id: "i1", location_id: "loc-main", remaining_qty: 10, unit_cost_cents: 1000 }), // 10000c
      ],
    });
    const r = await runInventoryReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.status).toBe("clean");
    expect(r.variances_found).toBe(0);
    expect(admin.captured.variancesInserts).toHaveLength(0);
  });

  it("separates same item across Main-WH and FBA into distinct match rows", async () => {
    const admin = makeSupabase({
      inventoryLayers: [
        layer({ id: "l1", item_id: "i1", location_id: "loc-main", remaining_qty: 10, unit_cost_cents: 100 }),
        layer({ id: "l2", item_id: "i1", location_id: "loc-fba", source_kind: "fba_inbound", remaining_qty: 50, unit_cost_cents: 100 }),
        mirror({ id: "x1", item_id: "i1", location_id: "loc-main", remaining_qty: 10, unit_cost_cents: 100 }),
      ],
    });
    const r = await runInventoryReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.status).toBe("clean");
    // Main-WH: matches → no row. FBA: skipped → row persisted as within.
    expect(admin.captured.variancesInserts).toHaveLength(1);
    expect(admin.captured.variancesInserts[0][0].source_id).toBe("i1::loc-fba");
    expect(admin.captured.variancesInserts[0][0].notes).toBe("location_not_in_xoro");
  });

  it("excludes layers received AFTER period_end (end-of-period snapshot)", async () => {
    const admin = makeSupabase({
      inventoryLayers: [
        layer({ id: "in",  item_id: "i1", location_id: "loc-main", remaining_qty: 10, unit_cost_cents: 100, received_at: "2026-05-15T12:00:00.000Z" }),
        layer({ id: "out", item_id: "i1", location_id: "loc-main", remaining_qty: 99, unit_cost_cents: 100, received_at: "2026-06-15T12:00:00.000Z" }),
        mirror({ id: "x_in",  item_id: "i1", location_id: "loc-main", remaining_qty: 10, unit_cost_cents: 100, received_at: "2026-05-15T12:00:00.000Z" }),
        mirror({ id: "x_out", item_id: "i1", location_id: "loc-main", remaining_qty: 99, unit_cost_cents: 100, received_at: "2026-06-15T12:00:00.000Z" }),
      ],
    });
    const r = await runInventoryReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.status).toBe("clean");
    expect(r.totals_jsonb.tangerine_rows_pulled).toBe(1);
    expect(r.totals_jsonb.xoro_rows_pulled).toBe(1);
  });

  it("includes layers received ON period_end (inclusive boundary)", async () => {
    const admin = makeSupabase({
      inventoryLayers: [
        layer({ id: "l1", item_id: "i1", location_id: "loc-main", remaining_qty: 10, unit_cost_cents: 100, received_at: "2026-05-31T23:59:59.000Z" }),
        mirror({ id: "x1", item_id: "i1", location_id: "loc-main", remaining_qty: 10, unit_cost_cents: 100, received_at: "2026-05-31T23:59:59.000Z" }),
      ],
    });
    const r = await runInventoryReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.status).toBe("clean");
    expect(r.totals_jsonb.tangerine_rows_pulled).toBe(1);
  });

  it("filters by entity_id", async () => {
    const admin = makeSupabase({
      inventoryLayers: [
        layer({ id: "wrong", item_id: "i1", location_id: "loc-main", remaining_qty: 10, unit_cost_cents: 100, entity_id: "other-ent" }),
      ],
    });
    const r = await runInventoryReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.totals_jsonb.tangerine_rows_pulled).toBe(0);
  });

  it("supports cadence='manual'", async () => {
    const admin = makeSupabase({});
    const r = await runInventoryReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END, cadence: "manual",
    });
    expect(r.status).toBe("clean");
    expect(admin.captured.runsInserts[0].cadence).toBe("manual");
  });

  it("supports cadence='replay' with replay_of_id (D11)", async () => {
    const admin = makeSupabase({});
    await runInventoryReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
      cadence: "replay", replay_of_id: "00000000-0000-0000-0000-000000000123",
    });
    expect(admin.captured.runsInserts[0].cadence).toBe("replay");
    expect(admin.captured.runsInserts[0].replay_of_id).toBe("00000000-0000-0000-0000-000000000123");
  });

  it("returns error+errors on bad args (rejects without DB insert)", async () => {
    const admin = makeSupabase({});
    const r = await runInventoryReconciliation({
      admin, entity_id: ENTITY, period_start: "bad", period_end: PERIOD_END,
    });
    expect(r.status).toBe("error");
    expect(r.errors[0].scope).toBe("args");
    expect(admin.captured.runsInserts).toHaveLength(0);
  });

  it("propagates recon_runs.insert error as status='error'", async () => {
    const admin = makeSupabase({ reconRunsInsertError: "db boom" });
    const r = await runInventoryReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.status).toBe("error");
    expect(r.errors[0].scope).toBe("recon_runs_insert");
    expect(r.errors[0].reason).toMatch(/db boom/);
    expect(r.recon_run_id).toBeNull();
  });

  it("propagates locations.read error and marks the run errored", async () => {
    const admin = makeSupabase({ locationsReadError: "loc boom" });
    const r = await runInventoryReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.status).toBe("error");
    expect(r.errors.some((e) => e.scope === "locations_fetch")).toBe(true);
    const errorUpdate = admin.captured.runsUpdates.find((u) => u.payload.status === "error");
    expect(errorUpdate).toBeDefined();
  });

  it("propagates inventory_layers.read error and marks the run errored", async () => {
    const admin = makeSupabase({ layersReadError: "read boom" });
    const r = await runInventoryReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.status).toBe("error");
    expect(r.errors.some((e) => e.scope === "tangerine_fetch")).toBe(true);
  });

  it("propagates recon_variances.insert error and marks the run errored", async () => {
    const admin = makeSupabase({
      inventoryLayers: [
        layer({ id: "l1", item_id: "i1", location_id: "loc-main", remaining_qty: 100, unit_cost_cents: 100 }),
      ],
      reconVariancesInsertError: "variance boom",
    });
    const r = await runInventoryReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.status).toBe("error");
    expect(r.errors.some((e) => e.scope === "recon_variances_insert")).toBe(true);
  });

  it("captures recon_runs.update error without overwriting comparison results", async () => {
    const admin = makeSupabase({
      inventoryLayers: [
        layer({ id: "l1", item_id: "i1", location_id: "loc-main", remaining_qty: 100, unit_cost_cents: 100 }),
      ],
      reconRunsUpdateError: "update boom",
    });
    const r = await runInventoryReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.errors.some((e) => e.scope === "recon_runs_update")).toBe(true);
    expect(r.variances_found).toBe(1);
  });

  it("writes totals_jsonb with the expected shape (incl. per_location)", async () => {
    const admin = makeSupabase({
      inventoryLayers: [
        layer({ id: "l1", item_id: "i1", location_id: "loc-main", remaining_qty: 100, unit_cost_cents: 100 }),
      ],
    });
    await runInventoryReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    const finalUpdate = admin.captured.runsUpdates[admin.captured.runsUpdates.length - 1];
    expect(finalUpdate.payload.totals_jsonb).toMatchObject({
      rows_compared: expect.any(Number),
      variances_found: 1,
      total_variance_cents: 10000,
      skipped_count: 0,
      per_row_threshold_cents: 5000,
      per_domain_threshold_cents: 25000,
      tangerine_rows_pulled: expect.any(Number),
      xoro_rows_pulled: expect.any(Number),
      tangerine_layer_buckets: expect.any(Number),
      xoro_layer_buckets: expect.any(Number),
    });
    expect(finalUpdate.payload.totals_jsonb.per_location).toBeDefined();
    expect(finalUpdate.payload.totals_jsonb.per_location["loc-main"]).toBeDefined();
  });

  it("idempotency via replay_of_id: second run links to first via replay_of_id", async () => {
    const admin1 = makeSupabase({
      inventoryLayers: [
        layer({ id: "l1", item_id: "i1", location_id: "loc-main", remaining_qty: 100, unit_cost_cents: 100 }),
      ],
      reconRunId: "first-run-id",
    });
    const r1 = await runInventoryReconciliation({
      admin: admin1, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END, cadence: "manual",
    });
    expect(r1.recon_run_id).toBe("first-run-id");

    const admin2 = makeSupabase({
      inventoryLayers: [
        layer({ id: "l1", item_id: "i1", location_id: "loc-main", remaining_qty: 100, unit_cost_cents: 100 }),
      ],
      reconRunId: "replay-run-id",
    });
    const r2 = await runInventoryReconciliation({
      admin: admin2, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
      cadence: "replay", replay_of_id: r1.recon_run_id,
    });
    expect(r2.recon_run_id).toBe("replay-run-id");
    expect(admin2.captured.runsInserts[0].replay_of_id).toBe("first-run-id");
    expect(r2.variances_found).toBe(r1.variances_found);
    expect(r2.total_variance_cents).toBe(r1.total_variance_cents);
  });

  it("multi-item multi-location sums correctly across Main + FBA + WFS", async () => {
    const admin = makeSupabase({
      inventoryLayers: [
        // Main-WH SKU A: $100 over
        layer({ id: "t1", item_id: "iA", location_id: "loc-main", remaining_qty: 20, unit_cost_cents: 1000 }), // 20000c
        mirror({ id: "x1", item_id: "iA", location_id: "loc-main", remaining_qty: 10, unit_cost_cents: 1000 }), // 10000c
        // Main-WH SKU B: $60 over
        layer({ id: "t2", item_id: "iB", location_id: "loc-main", remaining_qty: 6, unit_cost_cents: 1000 }), // 6000c
        // FBA: large but skipped
        layer({ id: "f1", item_id: "iA", location_id: "loc-fba", source_kind: "fba_inbound", remaining_qty: 100, unit_cost_cents: 1000 }),
        // WFS: large but skipped
        layer({ id: "w1", item_id: "iB", location_id: "loc-wfs", source_kind: "wfs_inbound", remaining_qty: 100, unit_cost_cents: 1000 }),
      ],
    });
    const r = await runInventoryReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    // 2 over-rows from Main-WH ($100 + $60 = $160 → under $250 domain)
    expect(r.variances_found).toBe(2);
    expect(r.total_variance_cents).toBe(16000);
    expect(r.status).toBe("clean");
    expect(r.totals_jsonb.skipped_count).toBe(2);
    // 4 variance rows persisted: 2 Main-WH over + 2 skipped FBA/WFS
    expect(admin.captured.variancesInserts[0]).toHaveLength(4);
  });

  it("rows with zero variance are NOT persisted (when not skipped)", async () => {
    const admin = makeSupabase({
      inventoryLayers: [
        layer({ id: "l1", item_id: "i1", location_id: "loc-main", remaining_qty: 10, unit_cost_cents: 100 }),
        mirror({ id: "x1", item_id: "i1", location_id: "loc-main", remaining_qty: 10, unit_cost_cents: 100 }),
      ],
    });
    await runInventoryReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(admin.captured.variancesInserts).toHaveLength(0);
  });

  it("INVENTORY_THRESHOLDS frozen + correct constants ($50/row, $250/domain)", () => {
    expect(__test_only__.INVENTORY_THRESHOLDS.per_row_cents).toBe(5000);
    expect(__test_only__.INVENTORY_THRESHOLDS.per_domain_cents).toBe(25000);
    expect(Object.isFrozen(__test_only__.INVENTORY_THRESHOLDS)).toBe(true);
  });

  it("default cadence is 'weekly' when omitted", async () => {
    const admin = makeSupabase({});
    await runInventoryReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(admin.captured.runsInserts[0].cadence).toBe("weekly");
  });

  it("single-day period (period_start == period_end) is accepted", async () => {
    const admin = makeSupabase({
      inventoryLayers: [
        layer({ id: "l1", item_id: "i1", location_id: "loc-main", remaining_qty: 10, unit_cost_cents: 100, received_at: "2026-05-15T12:00:00.000Z" }),
      ],
    });
    const r = await runInventoryReconciliation({
      admin, entity_id: ENTITY, period_start: "2026-05-15", period_end: "2026-05-15",
    });
    expect(r.status).toBe("clean");
    expect(r.totals_jsonb.tangerine_rows_pulled).toBe(1);
  });

  it("reversed period (period_end < period_start) rejected as args error", async () => {
    const admin = makeSupabase({});
    const r = await runInventoryReconciliation({
      admin, entity_id: ENTITY, period_start: "2026-05-31", period_end: "2026-05-01",
    });
    expect(r.status).toBe("error");
    expect(admin.captured.runsInserts).toHaveLength(0);
  });

  it("xoro_mirror_snapshot layers are NOT pulled by the Tangerine fetch (neq filter)", async () => {
    const admin = makeSupabase({
      inventoryLayers: [
        // Only mirror layers — Tangerine side should pull 0.
        mirror({ id: "x1", item_id: "i1", location_id: "loc-main", remaining_qty: 10, unit_cost_cents: 100 }),
      ],
    });
    const r = await runInventoryReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.totals_jsonb.tangerine_rows_pulled).toBe(0);
    expect(r.totals_jsonb.xoro_rows_pulled).toBe(1);
  });

  it("non-mirror layers (ap_invoice, adjustment, fba_inbound, etc.) are NOT pulled by the Xoro fetch", async () => {
    const admin = makeSupabase({
      inventoryLayers: [
        layer({ id: "l1", item_id: "i1", location_id: "loc-main", source_kind: "ap_invoice", remaining_qty: 10, unit_cost_cents: 100 }),
        layer({ id: "l2", item_id: "i2", location_id: "loc-main", source_kind: "adjustment", remaining_qty: 5, unit_cost_cents: 100 }),
        layer({ id: "f1", item_id: "i3", location_id: "loc-fba", source_kind: "fba_inbound", remaining_qty: 5, unit_cost_cents: 100 }),
      ],
    });
    const r = await runInventoryReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.totals_jsonb.tangerine_rows_pulled).toBe(3);
    expect(r.totals_jsonb.xoro_rows_pulled).toBe(0);
  });

  it("preserves source_kind from Tangerine side into source_tag (D7)", async () => {
    const admin = makeSupabase({
      inventoryLayers: [
        layer({ id: "l1", item_id: "i1", location_id: "loc-main", source_kind: "ap_invoice", remaining_qty: 100, unit_cost_cents: 100 }),
        mirror({ id: "x1", item_id: "i1", location_id: "loc-main", remaining_qty: 50, unit_cost_cents: 100 }),
      ],
    });
    await runInventoryReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(admin.captured.variancesInserts[0][0].source_tag).toBe("ap_invoice");
  });

  it("variance row at FBA over $50 stays 'within' due to skip, even though abs > threshold", async () => {
    const admin = makeSupabase({
      inventoryLayers: [
        layer({ id: "f1", item_id: "i1", location_id: "loc-fba", source_kind: "fba_inbound", remaining_qty: 100, unit_cost_cents: 1000 }),
      ],
    });
    const r = await runInventoryReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    const vRow = admin.captured.variancesInserts[0][0];
    expect(vRow.status).toBe("within");
    expect(vRow.variance_amount_cents).toBe(100000);
    expect(r.variances_found).toBe(0);
  });

  it("rounds layer value cents identically to T10-4 mirror (Math.round of qty*unit)", async () => {
    const admin = makeSupabase({
      inventoryLayers: [
        layer({ id: "l1", item_id: "i1", location_id: "loc-main", remaining_qty: 3.3333, unit_cost_cents: 100 }),
        mirror({ id: "x1", item_id: "i1", location_id: "loc-main", remaining_qty: 3.3333, unit_cost_cents: 100 }),
      ],
    });
    const r = await runInventoryReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    // Both sides round 333.33 → 333. Zero variance.
    expect(r.status).toBe("clean");
    expect(r.variances_found).toBe(0);
  });

  it("end-of-period FIFO snapshot: remaining_qty captured as-of period_end", async () => {
    // The engine uses remaining_qty as the period_end snapshot. Sanity test:
    // a single layer with remaining_qty=10 reads identically regardless of
    // hypothetical post-period consumption (which would not be visible in
    // the engine's pull anyway since received_at <= period_end excludes
    // post-period layers).
    const admin = makeSupabase({
      inventoryLayers: [
        layer({ id: "l1", item_id: "i1", location_id: "loc-main", remaining_qty: 10, unit_cost_cents: 100, received_at: "2026-05-01T00:00:00.000Z" }),
        mirror({ id: "x1", item_id: "i1", location_id: "loc-main", remaining_qty: 10, unit_cost_cents: 100, received_at: "2026-05-01T00:00:00.000Z" }),
      ],
    });
    const r = await runInventoryReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.status).toBe("clean");
  });

  it("paginates inventory_layers reads (>1000 rows)", async () => {
    // Build 1500 layers all matching their mirror.
    const rows = [];
    for (let i = 0; i < 1500; i++) {
      rows.push(layer({ id: `l${i}`, item_id: `i${i}`, location_id: "loc-main", remaining_qty: 1, unit_cost_cents: 100 }));
      rows.push(mirror({ id: `x${i}`, item_id: `i${i}`, location_id: "loc-main", remaining_qty: 1, unit_cost_cents: 100 }));
    }
    const admin = makeSupabase({ inventoryLayers: rows });
    const r = await runInventoryReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(r.status).toBe("clean");
    expect(r.totals_jsonb.tangerine_rows_pulled).toBe(1500);
    expect(r.totals_jsonb.xoro_rows_pulled).toBe(1500);
    // 2 pages each side → 2 layer reads per side = 4+ reads total (plus locations).
    expect(admin.captured.layerReads).toBeGreaterThanOrEqual(4);
  });

  it("location_kind 'warehouse' is NEVER skipped (Main-WH parity is the whole point)", async () => {
    const admin = makeSupabase({
      inventoryLayers: [
        layer({ id: "l1", item_id: "i1", location_id: "loc-main", remaining_qty: 100, unit_cost_cents: 100 }),
        layer({ id: "l2", item_id: "i1", location_id: "loc-wh2",  remaining_qty: 100, unit_cost_cents: 100 }),
      ],
    });
    const r = await runInventoryReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    // Both warehouse locations → both count as over (no mirror coverage).
    expect(r.variances_found).toBe(2);
    expect(r.totals_jsonb.skipped_count).toBe(0);
  });

  it("skipped FBA + over Main on same item produce 2 distinct variance rows", async () => {
    const admin = makeSupabase({
      inventoryLayers: [
        layer({ id: "f1", item_id: "i1", location_id: "loc-fba", source_kind: "fba_inbound", remaining_qty: 100, unit_cost_cents: 100 }),
        layer({ id: "l1", item_id: "i1", location_id: "loc-main", remaining_qty: 100, unit_cost_cents: 100 }),
      ],
    });
    const r = await runInventoryReconciliation({
      admin, entity_id: ENTITY, period_start: PERIOD_START, period_end: PERIOD_END,
    });
    expect(admin.captured.variancesInserts[0]).toHaveLength(2);
    expect(r.variances_found).toBe(1); // only Main counts
    expect(r.totals_jsonb.skipped_count).toBe(1);
  });
});
