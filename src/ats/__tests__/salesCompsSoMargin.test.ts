// Coverage for the client-side SO margin estimator. Tests use a
// synthetic in-memory item-master cache + plain Maps for the snapshot
// avgCost / PO weighted-avg inputs, so they don't hit the module-
// scoped singletons in itemMasterLookup.ts or rely on excelData
// plumbing — keeps the unit tests hermetic and quick.

import { describe, it, expect } from "vitest";
import {
  estimateSoMargin,
  estimateSoUnitCost,
  hasPpkToken,
  type SoCostInputs,
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

/** Build a minimal synthetic cache from an array of records.
 *  resolveIds looks up by exact sku_code match; getMaster returns the
 *  record by id. Snapshot + PO maps default to empty so tests can
 *  layer them in only when relevant — mirrors the modal which builds
 *  both maps once via useMemo and hands them to every estimator call. */
function makeInputs(
  records: ItemMasterRecord[],
  opts: {
    avgCostBySku?: Record<string, number>;
    poWeightedAvgByStyle?: Record<string, number>;
  } = {},
): SoCostInputs {
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
    avgCostBySku: new Map(Object.entries(opts.avgCostBySku ?? {})),
    poWeightedAvgByStyle: new Map(Object.entries(opts.poWeightedAvgByStyle ?? {})),
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

describe("estimateSoUnitCost — cost chain (snapshot → PO in-window)", () => {
  it("snapshot avgCost wins when present (each-grain SKU)", () => {
    const inputs = makeInputs(
      [makeRecord({ sku_code: "RBB1440N-BLACK", style_code: "RBB1440N", pack_size: 1 })],
      {
        avgCostBySku: { "RBB1440N-BLACK": 5.5 },
        // PO map carries a different value — snapshot should beat it.
        poWeightedAvgByStyle: { "RBB1440N": 9.99 },
      },
    );
    const out = estimateSoUnitCost("RBB1440N-BLACK", inputs);
    expect(out).toEqual({ unitCostEach: 5.5, source: "snapshot_avg", reason: "ok" });
  });

  it("PO in-window weighted avg used when snapshot is missing", () => {
    const inputs = makeInputs(
      [makeRecord({ sku_code: "NEWSTYLE-RED", style_code: "NEWSTYLE", pack_size: 1 })],
      {
        avgCostBySku: {},
        poWeightedAvgByStyle: { "NEWSTYLE": 7.25 },
      },
    );
    const out = estimateSoUnitCost("NEWSTYLE-RED", inputs);
    expect(out).toEqual({ unitCostEach: 7.25, source: "po_in_window", reason: "ok" });
  });

  it("no_cost when neither snapshot nor PO yields a positive value", () => {
    const inputs = makeInputs(
      [makeRecord({ sku_code: "EMPTY-BLACK", style_code: "EMPTY", pack_size: 1, unit_cost: 99 })],
      {
        avgCostBySku: {},
        poWeightedAvgByStyle: {},
      },
    );
    const out = estimateSoUnitCost("EMPTY-BLACK", inputs);
    expect(out.unitCostEach).toBeNull();
    expect(out.source).toBe("none");
    expect(out.reason).toBe("no_cost");
  });

  it("master.unit_cost is NOT consulted as a fallback", () => {
    // Master has a positive unit_cost but no snapshot + no PO entry
    // → should still return no_cost. This is the deliberate drop of
    // master.unit_cost from the cost chain after PR #287.
    const inputs = makeInputs(
      [makeRecord({ sku_code: "MASTERCOST-BLACK", style_code: "MC", pack_size: 1, unit_cost: 42 })],
      {
        avgCostBySku: {},
        poWeightedAvgByStyle: {},
      },
    );
    const out = estimateSoUnitCost("MASTERCOST-BLACK", inputs);
    expect(out.unitCostEach).toBeNull();
    expect(out.reason).toBe("no_cost");
  });

  it("no_master when the SKU does not resolve at all", () => {
    const inputs = makeInputs([], {
      avgCostBySku: { "UNKNOWN-SKU": 5.5 }, // even with a snapshot entry, no master = no_master
    });
    const out = estimateSoUnitCost("UNKNOWN-SKU", inputs);
    expect(out.reason).toBe("no_master");
    expect(out.unitCostEach).toBeNull();
  });

  it("snapshot value of 0 or negative falls through to PO", () => {
    const inputs = makeInputs(
      [makeRecord({ sku_code: "ZERO-BLACK", style_code: "Z", pack_size: 1 })],
      {
        avgCostBySku: { "ZERO-BLACK": 0 },
        poWeightedAvgByStyle: { "Z": 3.5 },
      },
    );
    const out = estimateSoUnitCost("ZERO-BLACK", inputs);
    expect(out.unitCostEach).toBe(3.5);
    expect(out.source).toBe("po_in_window");
  });

  it("PPK token + PPK master uses snapshot ÷ pack_size for per-each cost", () => {
    const inputs = makeInputs(
      [makeRecord({ sku_code: "RBB1440N-PPK-BLACK", style_code: "RBB1440N", pack_size: 48 })],
      {
        // Per-pack snapshot cost ($264 for 48 units) → per-each = $5.50.
        avgCostBySku: { "RBB1440N-PPK-BLACK": 264 },
      },
    );
    const out = estimateSoUnitCost("RBB1440N-PPK-BLACK", inputs);
    expect(out.reason).toBe("ok");
    expect(out.source).toBe("snapshot_avg");
    expect(out.unitCostEach).toBeCloseTo(5.5, 5);
  });

  it("PPK token + each-grain master → swap to PPK sibling (dash form), apply per-each divisor", () => {
    const inputs = makeInputs(
      [
        // Each-grain master.
        makeRecord({ sku_code: "RBB1440N-BLACK", style_code: "RBB1440N", pack_size: 1 }),
        // PPK sibling.
        makeRecord({ sku_code: "RBB1440N-PPK-BLACK", style_code: "RBB1440N", pack_size: 48 }),
      ],
      {
        // Snapshot keyed on the raw PPK sku.
        avgCostBySku: { "RBB1440N-PPK-BLACK": 264 },
      },
    );
    const out = estimateSoUnitCost("RBB1440N-PPK-BLACK", inputs);
    expect(out.reason).toBe("ok");
    expect(out.unitCostEach).toBeCloseTo(5.5, 5);
  });

  it("PPK token + each-grain master → swap to PPK sibling (glued form)", () => {
    const inputs = makeInputs(
      [
        makeRecord({ sku_code: "RYO0658-BLACK/BIRCH", style_code: "RYO0658", pack_size: 1 }),
        makeRecord({ sku_code: "RYO0658PPK-BLACK/BIRCH", style_code: "RYO0658", pack_size: 18 }),
      ],
      {
        avgCostBySku: { "RYO0658PPK-BLACK/BIRCH": 99 },
      },
    );
    const out = estimateSoUnitCost("RYO0658PPK-BLACK/BIRCH", inputs);
    expect(out.reason).toBe("ok");
    expect(out.unitCostEach).toBeCloseTo(99 / 18, 5);
  });

  it("PO-only fallback uses STYLE key (broader than rawSku), divides for PPK", () => {
    // Snapshot empty; PO has cost recorded against the style. Same
    // style two color SKUs both pick up the PO weighted avg even
    // though neither has a direct snapshot entry.
    const inputs = makeInputs(
      [
        makeRecord({ sku_code: "NEWPPK-RED", style_code: "NEWPPK", pack_size: 1 }),
        makeRecord({ sku_code: "NEWPPK-PPK-RED", style_code: "NEWPPK", pack_size: 12 }),
        makeRecord({ sku_code: "NEWPPK-PPK-BLUE", style_code: "NEWPPK", pack_size: 12 }),
      ],
      {
        avgCostBySku: {},
        poWeightedAvgByStyle: { "NEWPPK": 60 }, // $60/pack
      },
    );
    const red = estimateSoUnitCost("NEWPPK-PPK-RED", inputs);
    const blue = estimateSoUnitCost("NEWPPK-PPK-BLUE", inputs);
    expect(red.unitCostEach).toBeCloseTo(5, 5);
    expect(blue.unitCostEach).toBeCloseTo(5, 5);
    expect(red.source).toBe("po_in_window");
  });
});

describe("estimateSoMargin", () => {
  it("computes margin for an each-grain SKU using snapshot cost", () => {
    const inputs = makeInputs(
      [makeRecord({ sku_code: "RBB1440N-BLACK", style_code: "RBB1440N", pack_size: 1 })],
      { avgCostBySku: { "RBB1440N-BLACK": 5.5 } },
    );
    // 100 units at $15 each = $1500 revenue; cost = 100 × $5.50 = $550.
    // Margin = $950.
    const out = estimateSoMargin("RBB1440N-BLACK", 100, 1500, inputs);
    expect(out.costResolved).toBe(true);
    expect(out.margin).toBeCloseTo(950, 5);
    expect(out.qtyUnits).toBe(100);
    expect(out.unitCostEach).toBe(5.5);
    expect(out.source).toBe("snapshot_avg");
  });

  it("computes margin for a PPK SKU using snapshot cost ÷ pack_size", () => {
    const inputs = makeInputs(
      [makeRecord({ sku_code: "RBB1440N-PPK-BLACK", style_code: "RBB1440N", pack_size: 48 })],
      { avgCostBySku: { "RBB1440N-PPK-BLACK": 264 } },
    );
    // 5 packs at $1320/pack = $6600 revenue. qtyUnits = 5 × 48 = 240.
    // unit cost = $264 / 48 = $5.50 → cogs = 240 × 5.50 = $1320.
    // Margin = $6600 − $1320 = $5280.
    const out = estimateSoMargin("RBB1440N-PPK-BLACK", 5, 6600, inputs);
    expect(out.costResolved).toBe(true);
    expect(out.qtyUnits).toBe(240);
    expect(out.unitCostEach).toBeCloseTo(5.5, 5);
    expect(out.margin).toBeCloseTo(5280, 5);
  });

  it("computes margin using in-window PO weighted avg when snapshot is missing", () => {
    const inputs = makeInputs(
      [makeRecord({ sku_code: "NEWSTYLE-RED", style_code: "NEWSTYLE", pack_size: 1 })],
      {
        avgCostBySku: {},
        poWeightedAvgByStyle: { "NEWSTYLE": 4 }, // $4 per-each from in-window PO
      },
    );
    // 50 units @ $10 = $500 revenue; cost = 50 × $4 = $200; margin = $300.
    const out = estimateSoMargin("NEWSTYLE-RED", 50, 500, inputs);
    expect(out.costResolved).toBe(true);
    expect(out.source).toBe("po_in_window");
    expect(out.margin).toBeCloseTo(300, 5);
  });

  it("returns margin 0 and costResolved=false when master is missing", () => {
    const inputs = makeInputs([]);
    const out = estimateSoMargin("UNKNOWN", 10, 200, inputs);
    expect(out.costResolved).toBe(false);
    expect(out.reason).toBe("no_master");
    expect(out.margin).toBe(0);
    expect(out.source).toBe("none");
  });

  it("returns margin 0 and costResolved=false when neither chain step yields cost", () => {
    const inputs = makeInputs(
      [makeRecord({ sku_code: "NOCOST-BLACK", style_code: "NOCOST", pack_size: 1 })],
      { avgCostBySku: {}, poWeightedAvgByStyle: {} },
    );
    const out = estimateSoMargin("NOCOST-BLACK", 10, 200, inputs);
    expect(out.costResolved).toBe(false);
    expect(out.reason).toBe("no_cost");
    expect(out.margin).toBe(0);
  });

  it("PPK token + each-grain master → routes to PPK sibling and computes correctly", () => {
    const inputs = makeInputs(
      [
        makeRecord({ sku_code: "RBB1440N-BLACK", style_code: "RBB1440N", pack_size: 1 }),
        makeRecord({ sku_code: "RBB1440N-PPK-BLACK", style_code: "RBB1440N", pack_size: 48 }),
      ],
      { avgCostBySku: { "RBB1440N-PPK-BLACK": 264 } },
    );
    // 2 packs at $1320/pack → revenue $2640, qtyUnits = 96, cogs = 96 × 5.50 = $528.
    // Margin = $2112.
    const out = estimateSoMargin("RBB1440N-PPK-BLACK", 2, 2640, inputs);
    expect(out.costResolved).toBe(true);
    expect(out.qtyUnits).toBe(96);
    expect(out.margin).toBeCloseTo(2112, 5);
  });

  it("mixed dim-aggregate computes weighted margin correctly across snapshot + PO sources", () => {
    // One row resolves via snapshot, the other via PO. Aggregate
    // margin% should land on the blended value.
    const inputs = makeInputs(
      [
        makeRecord({ sku_code: "A-BLACK", style_code: "A", pack_size: 1 }),
        makeRecord({ sku_code: "B-BLACK", style_code: "B", pack_size: 1 }),
      ],
      {
        avgCostBySku: { "A-BLACK": 4 },
        poWeightedAvgByStyle: { "B": 6 },
      },
    );
    // Row A: 100 units @ $10 = $1000 rev; cost 400 → margin 600 (60%).
    // Row B: 50  units @ $12 = $600  rev; cost 300 → margin 300 (50%).
    // Aggregate: rev 1600, margin 900, margin% = 56.25%.
    const rA = estimateSoMargin("A-BLACK", 100, 1000, inputs);
    const rB = estimateSoMargin("B-BLACK", 50, 600, inputs);
    expect(rA.margin).toBeCloseTo(600, 5);
    expect(rB.margin).toBeCloseTo(300, 5);
    expect(rA.source).toBe("snapshot_avg");
    expect(rB.source).toBe("po_in_window");
    const totalRev = 1000 + 600;
    const totalMargin = rA.margin + rB.margin;
    expect(totalMargin / totalRev).toBeCloseTo(0.5625, 5);
  });

  it("partial-cost aggregate: missing-cost rows do not poison resolved rows", () => {
    const inputs = makeInputs(
      [
        makeRecord({ sku_code: "OK-BLACK", style_code: "OK", pack_size: 1 }),
        makeRecord({ sku_code: "NOCOST-BLACK", style_code: "NC", pack_size: 1 }),
      ],
      {
        avgCostBySku: { "OK-BLACK": 5 },
        poWeightedAvgByStyle: {},
      },
    );
    const ok = estimateSoMargin("OK-BLACK", 10, 100, inputs);
    const noCost = estimateSoMargin("NOCOST-BLACK", 5, 50, inputs);
    expect(ok.costResolved).toBe(true);
    expect(ok.margin).toBeCloseTo(50, 5);
    expect(noCost.costResolved).toBe(false);
    expect(noCost.margin).toBe(0);
    // Aggregate margin = $50 across $150 rev.
    expect((ok.margin + noCost.margin) / (100 + 50)).toBeCloseTo(50 / 150, 5);
  });
});
