// Coverage for the client-side SO margin estimator. Tests use a
// synthetic in-memory item-master cache so they don't hit the module-
// scoped singletons in itemMasterLookup.ts — keeps the unit tests
// hermetic and quick.

import { describe, it, expect } from "vitest";
import {
  estimateSoMargin,
  estimateSoUnitCost,
  hasPpkToken,
} from "../salesCompsSoMargin";
import type { ItemMasterRecord } from "../itemMasterLookup";

function makeRecord(overrides: Partial<ItemMasterRecord> = {}): ItemMasterRecord {
  return {
    id: overrides.id ?? "id-" + (overrides.sku_code ?? "default"),
    sku_code: overrides.sku_code ?? "DEFAULT",
    style_code: overrides.style_code ?? null,
    color: overrides.color ?? null,
    size: overrides.size ?? null,
    description: overrides.description ?? null,
    unit_cost: overrides.unit_cost ?? null,
    pack_size: overrides.pack_size ?? 1,
    attributes: overrides.attributes ?? null,
  };
}

/** Build a minimal synthetic cache from an array of records. resolveIds
 *  looks up by exact sku_code match; getMaster returns the record by id.
 *  Keeps the tests focused on the estimator's routing/cost rules
 *  without re-exercising itemMasterLookup's canonicalization logic. */
function makeCache(records: ItemMasterRecord[]): {
  resolveIds: (sku: string) => string[];
  getMaster: (id: string) => ItemMasterRecord | null;
} {
  const bySku = new Map<string, string[]>();
  const byId = new Map<string, ItemMasterRecord>();
  for (const r of records) {
    byId.set(r.id, r);
    const cur = bySku.get(r.sku_code) ?? [];
    cur.push(r.id);
    bySku.set(r.sku_code, cur);
  }
  return {
    resolveIds: sku => bySku.get(sku) ?? [],
    getMaster: id => byId.get(id) ?? null,
  };
}

describe("hasPpkToken", () => {
  it("matches PPK<digits> tokens", () => {
    expect(hasPpkToken("RBB1440N-BLACK-PPK48")).toBe(true);
    expect(hasPpkToken("RYO0658PPK-BLACK")).toBe(true);
    expect(hasPpkToken("RYG1842PPK-BLACK-PPK60")).toBe(true);
  });
  it("rejects rows without a PPK token", () => {
    expect(hasPpkToken("RBB1440N-BLACK")).toBe(false);
    expect(hasPpkToken("RYO0658-BLACK/BIRCH")).toBe(false);
    expect(hasPpkToken("")).toBe(false);
  });
  it("does not match style codes that just happen to contain 'PPK' letters", () => {
    // No digits after PPK → not a pack token.
    expect(hasPpkToken("STYLEPPK-BLACK")).toBe(false);
  });
});

describe("estimateSoUnitCost", () => {
  it("returns the master unit_cost directly for each-grain SKUs", () => {
    const cache = makeCache([
      makeRecord({ sku_code: "RBB1440N-BLACK", style_code: "RBB1440N", unit_cost: 5.5, pack_size: 1 }),
    ]);
    const out = estimateSoUnitCost("RBB1440N-BLACK", cache.resolveIds, cache.getMaster);
    expect(out).toEqual({ unitCostEach: 5.5, reason: "ok" });
  });

  it("flags no_master when the SKU does not resolve", () => {
    const cache = makeCache([]);
    const out = estimateSoUnitCost("UNKNOWN-SKU", cache.resolveIds, cache.getMaster);
    expect(out.reason).toBe("no_master");
    expect(out.unitCostEach).toBeNull();
  });

  it("flags no_cost when the master has unit_cost = null", () => {
    const cache = makeCache([
      makeRecord({ sku_code: "RBB1440N-BLACK", style_code: "RBB1440N", unit_cost: null, pack_size: 1 }),
    ]);
    const out = estimateSoUnitCost("RBB1440N-BLACK", cache.resolveIds, cache.getMaster);
    expect(out.reason).toBe("no_cost");
    expect(out.unitCostEach).toBeNull();
  });

  it("flags no_cost when master.unit_cost is 0 or negative", () => {
    const cache = makeCache([
      makeRecord({ sku_code: "ZERO-BLACK", style_code: "ZERO", unit_cost: 0, pack_size: 1 }),
      makeRecord({ sku_code: "NEG-BLACK", style_code: "NEG", unit_cost: -1, pack_size: 1 }),
    ]);
    expect(estimateSoUnitCost("ZERO-BLACK", cache.resolveIds, cache.getMaster).reason).toBe("no_cost");
    expect(estimateSoUnitCost("NEG-BLACK", cache.resolveIds, cache.getMaster).reason).toBe("no_cost");
  });

  it("PPK token + master pack_size > 1 divides cost by pack_size", () => {
    const cache = makeCache([
      // PPK master with per-pack cost ($264 for 48 units).
      makeRecord({ sku_code: "RBB1440N-PPK-BLACK", style_code: "RBB1440N", unit_cost: 264, pack_size: 48 }),
    ]);
    const out = estimateSoUnitCost("RBB1440N-PPK-BLACK", cache.resolveIds, cache.getMaster);
    expect(out.reason).toBe("ok");
    expect(out.unitCostEach).toBeCloseTo(5.5, 5);
  });

  it("PPK token but master is each-grain → swap to PPK sibling (dash form)", () => {
    const cache = makeCache([
      // Each-grain master (pack_size = 1) under the un-prefixed style.
      makeRecord({ sku_code: "RBB1440N-BLACK", style_code: "RBB1440N", unit_cost: 99, pack_size: 1 }),
      // Sibling PPK master at "<STYLE>-PPK<SUFFIX>".
      makeRecord({ sku_code: "RBB1440N-PPK-BLACK", style_code: "RBB1440N", unit_cost: 264, pack_size: 48 }),
    ]);
    // SO sku carries the PPK token — even though the each-grain master
    // resolves first, the routing should swap to the PPK sibling.
    const out = estimateSoUnitCost("RBB1440N-PPK-BLACK", cache.resolveIds, cache.getMaster);
    expect(out.reason).toBe("ok");
    expect(out.unitCostEach).toBeCloseTo(5.5, 5);
  });

  it("PPK token but master is each-grain → swap to PPK sibling (glued form)", () => {
    const cache = makeCache([
      // Each-grain.
      makeRecord({ sku_code: "RYO0658-BLACK/BIRCH", style_code: "RYO0658", unit_cost: 99, pack_size: 1 }),
      // Glued-form sibling at "<STYLE>PPK<SUFFIX>".
      makeRecord({ sku_code: "RYO0658PPK-BLACK/BIRCH", style_code: "RYO0658", unit_cost: 99, pack_size: 18 }),
    ]);
    const out = estimateSoUnitCost("RYO0658PPK-BLACK/BIRCH", cache.resolveIds, cache.getMaster);
    expect(out.reason).toBe("ok");
    expect(out.unitCostEach).toBeCloseTo(99 / 18, 5);
  });
});

describe("estimateSoMargin", () => {
  it("computes margin for an each-grain SKU using cost directly", () => {
    const cache = makeCache([
      makeRecord({ sku_code: "RBB1440N-BLACK", style_code: "RBB1440N", unit_cost: 5.5, pack_size: 1 }),
    ]);
    // 100 units at $15 each = $1500 revenue; cost = 100 × $5.50 = $550.
    // Margin = $950. Margin% = 63.3%.
    const out = estimateSoMargin("RBB1440N-BLACK", 100, 1500, cache.resolveIds, cache.getMaster);
    expect(out.costResolved).toBe(true);
    expect(out.margin).toBeCloseTo(950, 5);
    expect(out.qtyUnits).toBe(100);
    expect(out.unitCostEach).toBe(5.5);
  });

  it("computes margin for a PPK SKU (pack-grain) at correct per-each cost", () => {
    const cache = makeCache([
      makeRecord({ sku_code: "RBB1440N-PPK-BLACK", style_code: "RBB1440N", unit_cost: 264, pack_size: 48 }),
    ]);
    // 5 packs at $1320/pack = $6600 revenue. qtyUnits = 5 × 48 = 240.
    // unit cost = $264 / 48 = $5.50 → cogs = 240 × 5.50 = $1320.
    // Margin = $6600 - $1320 = $5280.
    const out = estimateSoMargin("RBB1440N-PPK-BLACK", 5, 6600, cache.resolveIds, cache.getMaster);
    expect(out.costResolved).toBe(true);
    expect(out.qtyUnits).toBe(240);
    expect(out.unitCostEach).toBeCloseTo(5.5, 5);
    expect(out.margin).toBeCloseTo(5280, 5);
  });

  it("returns margin 0 and costResolved=false when the master is missing", () => {
    const cache = makeCache([]);
    const out = estimateSoMargin("UNKNOWN", 10, 200, cache.resolveIds, cache.getMaster);
    expect(out.costResolved).toBe(false);
    expect(out.reason).toBe("no_master");
    expect(out.margin).toBe(0);
  });

  it("returns margin 0 and costResolved=false when master has no cost", () => {
    const cache = makeCache([
      makeRecord({ sku_code: "NOCOST-BLACK", style_code: "NOCOST", unit_cost: null, pack_size: 1 }),
    ]);
    const out = estimateSoMargin("NOCOST-BLACK", 10, 200, cache.resolveIds, cache.getMaster);
    expect(out.costResolved).toBe(false);
    expect(out.reason).toBe("no_cost");
    expect(out.margin).toBe(0);
  });

  it("PPK token + each-grain master → routes to PPK sibling and computes correctly", () => {
    const cache = makeCache([
      makeRecord({ sku_code: "RBB1440N-BLACK", style_code: "RBB1440N", unit_cost: 99, pack_size: 1 }),
      makeRecord({ sku_code: "RBB1440N-PPK-BLACK", style_code: "RBB1440N", unit_cost: 264, pack_size: 48 }),
    ]);
    // 2 packs at $1320/pack → revenue $2640, qtyUnits = 96, cogs = 96 × 5.50 = $528.
    // Margin = $2112.
    const out = estimateSoMargin("RBB1440N-PPK-BLACK", 2, 2640, cache.resolveIds, cache.getMaster);
    expect(out.costResolved).toBe(true);
    expect(out.qtyUnits).toBe(96);
    expect(out.margin).toBeCloseTo(2112, 5);
  });

  it("unit-grain anomaly guard: cost > 2× unit_price → divides by pack_size", () => {
    // Pathological master: pack_size > 1 but cost stored at per-pack
    // grain even though the SO sku has no PPK token (data-quality bug
    // covered by resolvePerUnitCost step 3).
    const cache = makeCache([
      makeRecord({ sku_code: "WEIRD-BLACK", style_code: "WEIRD", unit_cost: 100, pack_size: 12 }),
    ]);
    // 10 units at $10 each = $100 revenue. unitPrice = $10. cost ($100) >
    // 2 × unitPrice ($20) → cost should be divided by 12 → $8.33 per each.
    // cogs = 10 × 8.33 = $83.33 → margin ≈ $16.67.
    const out = estimateSoMargin("WEIRD-BLACK", 10, 100, cache.resolveIds, cache.getMaster);
    expect(out.costResolved).toBe(true);
    expect(out.unitCostEach).toBeCloseTo(100 / 12, 5);
    expect(out.margin).toBeCloseTo(100 - 10 * (100 / 12), 5);
  });

  it("mixed dim-aggregate computes weighted margin correctly", () => {
    // Two SOs roll up under one dimension (e.g. one customer). The
    // caller sums margin across the SOs — verify the per-row math is
    // correct so the aggregated margin% lands at the right blended
    // value.
    const cache = makeCache([
      makeRecord({ sku_code: "A-BLACK", style_code: "A", unit_cost: 4, pack_size: 1 }),
      makeRecord({ sku_code: "B-BLACK", style_code: "B", unit_cost: 6, pack_size: 1 }),
    ]);
    // Row A: 100 units @ $10 = $1000 rev; cost 400 → margin 600 (60%).
    // Row B: 50  units @ $12 = $600  rev; cost 300 → margin 300 (50%).
    // Aggregate: rev 1600, margin 900, margin% = 56.25%.
    const rA = estimateSoMargin("A-BLACK", 100, 1000, cache.resolveIds, cache.getMaster);
    const rB = estimateSoMargin("B-BLACK", 50, 600, cache.resolveIds, cache.getMaster);
    expect(rA.margin).toBeCloseTo(600, 5);
    expect(rB.margin).toBeCloseTo(300, 5);
    const totalRev = 1000 + 600;
    const totalMargin = rA.margin + rB.margin;
    expect(totalMargin / totalRev).toBeCloseTo(0.5625, 5);
  });

  it("partial-cost aggregate: missing-cost rows do not poison resolved rows", () => {
    const cache = makeCache([
      makeRecord({ sku_code: "OK-BLACK", style_code: "OK", unit_cost: 5, pack_size: 1 }),
      // Second SKU has no master at all → no_master.
    ]);
    const ok = estimateSoMargin("OK-BLACK", 10, 100, cache.resolveIds, cache.getMaster);
    const missing = estimateSoMargin("UNKNOWN-SKU", 5, 50, cache.resolveIds, cache.getMaster);
    expect(ok.costResolved).toBe(true);
    expect(ok.margin).toBeCloseTo(50, 5);
    expect(missing.costResolved).toBe(false);
    expect(missing.margin).toBe(0);
    // Aggregate margin = $50 across $150 rev = 33.3%. With the
    // unresolved row contributing 0 margin (and the caveat-line
    // surfacing it), the blend is honest.
    expect((ok.margin + missing.margin) / (100 + 50)).toBeCloseTo(50 / 150, 5);
  });
});
