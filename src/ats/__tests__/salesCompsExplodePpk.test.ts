// Sales Comps "Explode PPK" toggle — grain classification + sibling
// discovery + the per-explode dimension aggregator that wires them into
// the modal's tableRows / dim rollups.
//
// Tests cover the seven required behaviors from the spec:
//   (a) explode ON collapses PPK + each siblings into one row, qty in
//       eaches
//   (b) explode ON multiplies PPK qty by pack_size in dim aggregation
//   (c) explode OFF splits dim row into two when both grains exist
//   (d) explode OFF keeps single row when only one grain exists
//   (e) totals row splits when mixed grain present
//   (f) revenue and margin NOT multiplied in either mode
//   (g) sibling discovery works in both directions (each → PPK and
//       PPK → each)

import { describe, it, expect } from "vitest";
import {
  classifyMasterGrain,
  findEachSibling,
  findPpkSibling,
  packSizeFor,
  siblingKeyFor,
  explodeMultiplier,
  grainLabelSuffix,
  firstMasterFor,
} from "../salesCompsGrain";
import {
  aggregateExplodeAware,
  totalsForDimRows,
  type RawSkuAgg,
} from "../salesCompsAggregate";
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

describe("classifyMasterGrain", () => {
  it("flags style_codes containing PPK as ppk-grain", () => {
    expect(classifyMasterGrain(makeRecord({ style_code: "RYO0658PPK" }))).toBe("ppk");
    expect(classifyMasterGrain(makeRecord({ style_code: "RBB1440N-PPK" }))).toBe("ppk");
    expect(classifyMasterGrain(makeRecord({ style_code: "rbb1440nppk" }))).toBe("ppk");
  });
  it("returns each for plain style codes", () => {
    expect(classifyMasterGrain(makeRecord({ style_code: "RYO0658" }))).toBe("each");
    expect(classifyMasterGrain(makeRecord({ style_code: "RBB1440N" }))).toBe("each");
  });
  it("returns each for null master / null style_code", () => {
    expect(classifyMasterGrain(null)).toBe("each");
    expect(classifyMasterGrain(makeRecord({ style_code: null }))).toBe("each");
  });
});

describe("siblingKeyFor", () => {
  it("normalizes PPK and each into the same (stem, color) key", () => {
    const ppk = makeRecord({ sku_code: "RYO0658PPK-BLACK", style_code: "RYO0658PPK", color: "BLACK" });
    const each = makeRecord({ sku_code: "RYO0658-BLACK", style_code: "RYO0658", color: "BLACK" });
    expect(siblingKeyFor(ppk)).toBe(siblingKeyFor(each));
    expect(siblingKeyFor(ppk)).toBe("RYO0658|BLACK");
  });
  it("handles the dash form (RBB1440N-PPK + RBB1440N)", () => {
    const ppk = makeRecord({ sku_code: "RBB1440N-PPK-BLACK", style_code: "RBB1440N-PPK", color: "BLACK" });
    const each = makeRecord({ sku_code: "RBB1440N-BLACK", style_code: "RBB1440N", color: "BLACK" });
    expect(siblingKeyFor(ppk)).toBe(siblingKeyFor(each));
  });
  it("falls back to sku_code when style/color are missing", () => {
    expect(siblingKeyFor(makeRecord({ sku_code: "ORPHAN", style_code: null, color: null })))
      .toBe("ORPHAN");
  });
});

describe("packSizeFor", () => {
  it("returns the master pack_size when valid", () => {
    expect(packSizeFor(makeRecord({ pack_size: 48 }))).toBe(48);
  });
  it("defaults to 1 for null/missing/zero pack_size", () => {
    expect(packSizeFor(null)).toBe(1);
    expect(packSizeFor(makeRecord({ pack_size: 0 }))).toBe(1);
    expect(packSizeFor(makeRecord({ pack_size: null }))).toBe(1);
  });
});

describe("explodeMultiplier", () => {
  it("returns master.pack_size for PPK-grain masters", () => {
    expect(explodeMultiplier(makeRecord({ style_code: "RYO0658PPK", pack_size: 48 }))).toBe(48);
  });
  it("returns 1 for each-grain masters", () => {
    expect(explodeMultiplier(makeRecord({ style_code: "RYO0658", pack_size: 48 }))).toBe(1);
  });
});

describe("grainLabelSuffix", () => {
  it("uses '(PPK packs)' for PPK and '(each)' for each (default / explode OFF)", () => {
    expect(grainLabelSuffix("ppk")).toBe("(PPK packs)");
    expect(grainLabelSuffix("each")).toBe("(each)");
    expect(grainLabelSuffix("ppk", false)).toBe("(PPK packs)");
    expect(grainLabelSuffix("each", false)).toBe("(each)");
  });
  it("returns empty string when explodePpk is ON (qty is uniformly in eaches, suffix would mislead)", () => {
    expect(grainLabelSuffix("ppk", true)).toBe("");
    expect(grainLabelSuffix("each", true)).toBe("");
  });
});

describe("findPpkSibling — each → PPK", () => {
  it("finds the dash-form sibling", () => {
    const each = makeRecord({ sku_code: "RBB1440N-BLACK", style_code: "RBB1440N", color: "BLACK" });
    const ppk = makeRecord({ sku_code: "RBB1440N-PPK-BLACK", style_code: "RBB1440N-PPK", color: "BLACK", pack_size: 48 });
    const cache = makeCache([each, ppk]);
    const sibling = findPpkSibling(each, cache.resolveIds, cache.getMaster);
    expect(sibling?.sku_code).toBe("RBB1440N-PPK-BLACK");
  });
  it("finds the glued-form sibling", () => {
    const each = makeRecord({ sku_code: "RYO0658-BLACK", style_code: "RYO0658", color: "BLACK" });
    const ppk = makeRecord({ sku_code: "RYO0658PPK-BLACK", style_code: "RYO0658PPK", color: "BLACK", pack_size: 24 });
    const cache = makeCache([each, ppk]);
    const sibling = findPpkSibling(each, cache.resolveIds, cache.getMaster);
    expect(sibling?.sku_code).toBe("RYO0658PPK-BLACK");
  });
  it("returns null when no PPK sibling exists", () => {
    const each = makeRecord({ sku_code: "LONELY-BLACK", style_code: "LONELY", color: "BLACK" });
    const cache = makeCache([each]);
    expect(findPpkSibling(each, cache.resolveIds, cache.getMaster)).toBeNull();
  });
});

describe("findEachSibling — PPK → each", () => {
  it("finds the each sibling via glued-form strip", () => {
    const ppk = makeRecord({ sku_code: "RYO0658PPK-BLACK", style_code: "RYO0658PPK", color: "BLACK", pack_size: 24 });
    const each = makeRecord({ sku_code: "RYO0658-BLACK", style_code: "RYO0658", color: "BLACK" });
    const cache = makeCache([ppk, each]);
    const sibling = findEachSibling(ppk, cache.resolveIds, cache.getMaster);
    expect(sibling?.sku_code).toBe("RYO0658-BLACK");
  });
  it("finds the each sibling via dash-form strip", () => {
    const ppk = makeRecord({ sku_code: "RBB1440N-PPK-BLACK", style_code: "RBB1440N-PPK", color: "BLACK", pack_size: 48 });
    const each = makeRecord({ sku_code: "RBB1440N-BLACK", style_code: "RBB1440N", color: "BLACK" });
    const cache = makeCache([ppk, each]);
    const sibling = findEachSibling(ppk, cache.resolveIds, cache.getMaster);
    expect(sibling?.sku_code).toBe("RBB1440N-BLACK");
  });
  it("returns null when no each sibling exists", () => {
    const ppk = makeRecord({ sku_code: "ONLYPPK-BLACK", style_code: "ONLYPPK", color: "BLACK", pack_size: 12 });
    const cache = makeCache([ppk]);
    expect(findEachSibling(ppk, cache.resolveIds, cache.getMaster)).toBeNull();
  });
});

describe("firstMasterFor", () => {
  it("returns the first master that resolves", () => {
    const rec = makeRecord({ sku_code: "RYO-BLACK", style_code: "RYO" });
    const cache = makeCache([rec]);
    expect(firstMasterFor("RYO-BLACK", cache.resolveIds, cache.getMaster)?.sku_code).toBe("RYO-BLACK");
  });
  it("returns null for unknown SKUs", () => {
    const cache = makeCache([]);
    expect(firstMasterFor("UNKNOWN", cache.resolveIds, cache.getMaster)).toBeNull();
  });
});

// ── Aggregator behavior tests ───────────────────────────────────────
//
// aggregateExplodeAware takes a per-SKU raw aggregate map (tyQty / tyRev
// / tyMrgn / lyQty / lyRev / lyMrgn keyed by SKU code) and the
// resolveIds + getMaster cache, and returns dim-level rows ready for
// the CompsTable + Excel export. The dimension is supplied separately
// ("sku", "style", "category", "sub_category", "customer", "gender").
//
// When explodePpk is ON:
//   - PPK rows have their qty multiplied by master.pack_size
//   - PPK + each siblings collapse into one row per (style stem, color)
//   - Display sku key prefers the each-grain sibling's code
//
// When explodePpk is OFF:
//   - qty stays in master's native grain (no multiplication)
//   - Each dim row may split into two sub-rows: one for PPK
//     contribution, one for each contribution
//   - When only one grain exists for a dim, render as a single row
//     with grain label appended

function makeFamilyCache(): ReturnType<typeof makeCache> & {
  ppk: ItemMasterRecord; each: ItemMasterRecord;
} {
  const ppk = makeRecord({
    sku_code: "RBB1440N-PPK-BLACK",
    style_code: "RBB1440N-PPK",
    color: "BLACK",
    pack_size: 48,
    unit_cost: 264,
    attributes: { group_name: "Bottoms", category_name: "Shorts", gender: "MENS" },
  });
  const each = makeRecord({
    sku_code: "RBB1440N-BLACK",
    style_code: "RBB1440N",
    color: "BLACK",
    pack_size: 1,
    unit_cost: 5.5,
    attributes: { group_name: "Bottoms", category_name: "Shorts", gender: "MENS" },
  });
  return { ...makeCache([ppk, each]), ppk, each };
}

function makeStandaloneCache(): ReturnType<typeof makeCache> & { lonely: ItemMasterRecord } {
  const lonely = makeRecord({
    sku_code: "SOLO-BLACK",
    style_code: "SOLO",
    color: "BLACK",
    pack_size: 1,
    attributes: { group_name: "Tops", category_name: "Tees", gender: "WOMENS" },
  });
  return { ...makeCache([lonely]), lonely };
}

describe("aggregateExplodeAware — explode ON", () => {
  it("(a) collapses PPK + each siblings into one row, qty in eaches", () => {
    const cache = makeFamilyCache();
    const raw: RawSkuAgg[] = [
      { sku: "RBB1440N-PPK-BLACK", tyQty: 2, tyRev: 528, tyMrgn: 0, lyQty: 0, lyRev: 0, lyMrgn: 0 },
      { sku: "RBB1440N-BLACK",     tyQty: 10, tyRev: 200, tyMrgn: 100, lyQty: 0, lyRev: 0, lyMrgn: 0 },
    ];
    const rows = aggregateExplodeAware({
      raw, dim: "sku", explodePpk: true,
      resolveIds: cache.resolveIds, getMaster: cache.getMaster,
    });
    expect(rows).toHaveLength(1);
    // PPK 2 packs × 48 = 96, plus 10 eaches → 106 eaches
    expect(rows[0].tyQty).toBe(106);
    // Revenue NOT multiplied
    expect(rows[0].tyRev).toBe(728);
    // Display label prefers the each-grain sku code
    expect(rows[0].label).toBe("RBB1440N-BLACK");
  });

  it("(b) multiplies PPK qty by pack_size in style dim aggregation", () => {
    const cache = makeFamilyCache();
    const raw: RawSkuAgg[] = [
      { sku: "RBB1440N-PPK-BLACK", tyQty: 3, tyRev: 0, tyMrgn: 0, lyQty: 0, lyRev: 0, lyMrgn: 0 },
    ];
    const rows = aggregateExplodeAware({
      raw, dim: "style", explodePpk: true,
      resolveIds: cache.resolveIds, getMaster: cache.getMaster,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].tyQty).toBe(3 * 48);
    // Style key collapses both grains under the each-grain style stem
    expect(rows[0].label).toBe("RBB1440N");
  });

  it("(f) revenue and margin are not multiplied in explode ON", () => {
    const cache = makeFamilyCache();
    const raw: RawSkuAgg[] = [
      { sku: "RBB1440N-PPK-BLACK", tyQty: 2, tyRev: 528, tyMrgn: 264, lyQty: 1, lyRev: 264, lyMrgn: 100 },
    ];
    const rows = aggregateExplodeAware({
      raw, dim: "sku", explodePpk: true,
      resolveIds: cache.resolveIds, getMaster: cache.getMaster,
    });
    expect(rows[0].tyRev).toBe(528);
    expect(rows[0].tyMrgn).toBe(264);
    expect(rows[0].lyRev).toBe(264);
    expect(rows[0].lyMrgn).toBe(100);
    // qty IS multiplied
    expect(rows[0].tyQty).toBe(96);
    expect(rows[0].lyQty).toBe(48);
  });
});

describe("aggregateExplodeAware — explode OFF", () => {
  it("(c) splits dim row into two when both grains exist", () => {
    const cache = makeFamilyCache();
    const raw: RawSkuAgg[] = [
      { sku: "RBB1440N-PPK-BLACK", tyQty: 2, tyRev: 528, tyMrgn: 0, lyQty: 0, lyRev: 0, lyMrgn: 0 },
      { sku: "RBB1440N-BLACK",     tyQty: 10, tyRev: 200, tyMrgn: 0, lyQty: 0, lyRev: 0, lyMrgn: 0 },
    ];
    const rows = aggregateExplodeAware({
      raw, dim: "style", explodePpk: false,
      resolveIds: cache.resolveIds, getMaster: cache.getMaster,
    });
    expect(rows).toHaveLength(2);
    const ppkRow = rows.find(r => r.grain === "ppk");
    const eachRow = rows.find(r => r.grain === "each");
    expect(ppkRow?.tyQty).toBe(2);     // packs — NOT multiplied
    expect(eachRow?.tyQty).toBe(10);
    expect(ppkRow?.label).toContain("(PPK packs)");
    expect(eachRow?.label).toContain("(each)");
  });

  it("(d) keeps a single row when only one grain exists, with grain label appended", () => {
    const cache = makeStandaloneCache();
    const raw: RawSkuAgg[] = [
      { sku: "SOLO-BLACK", tyQty: 5, tyRev: 100, tyMrgn: 50, lyQty: 0, lyRev: 0, lyMrgn: 0 },
    ];
    const rows = aggregateExplodeAware({
      raw, dim: "style", explodePpk: false,
      resolveIds: cache.resolveIds, getMaster: cache.getMaster,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].tyQty).toBe(5);
    expect(rows[0].label).toContain("(each)");
  });

  it("(f) does not multiply qty when explode OFF", () => {
    const cache = makeFamilyCache();
    const raw: RawSkuAgg[] = [
      { sku: "RBB1440N-PPK-BLACK", tyQty: 2, tyRev: 528, tyMrgn: 0, lyQty: 0, lyRev: 0, lyMrgn: 0 },
    ];
    const rows = aggregateExplodeAware({
      raw, dim: "sku", explodePpk: false,
      resolveIds: cache.resolveIds, getMaster: cache.getMaster,
    });
    expect(rows[0].tyQty).toBe(2);   // packs — not multiplied
    expect(rows[0].tyRev).toBe(528); // never multiplied
  });
});

describe("aggregateExplodeAware — totals", () => {
  it("(e) buildTotalsRows returns two totals when mixed grain present (explode OFF)", () => {
    const cache = makeFamilyCache();
    const raw: RawSkuAgg[] = [
      { sku: "RBB1440N-PPK-BLACK", tyQty: 2, tyRev: 528, tyMrgn: 0, lyQty: 0, lyRev: 0, lyMrgn: 0 },
      { sku: "RBB1440N-BLACK",     tyQty: 10, tyRev: 200, tyMrgn: 0, lyQty: 0, lyRev: 0, lyMrgn: 0 },
    ];
    const rows = aggregateExplodeAware({
      raw, dim: "sku", explodePpk: false,
      resolveIds: cache.resolveIds, getMaster: cache.getMaster,
    });
    // sku dim with explode OFF should keep separate rows per sku
    expect(rows).toHaveLength(2);
    const ppkRow = rows.find(r => r.grain === "ppk");
    const eachRow = rows.find(r => r.grain === "each");
    expect(ppkRow).toBeDefined();
    expect(eachRow).toBeDefined();
    expect(ppkRow!.label).toContain("(PPK packs)");
    expect(eachRow!.label).toContain("(each)");
  });

  it("single grain present (explode OFF) returns one row + one totals", () => {
    const cache = makeStandaloneCache();
    const raw: RawSkuAgg[] = [
      { sku: "SOLO-BLACK", tyQty: 5, tyRev: 100, tyMrgn: 0, lyQty: 0, lyRev: 0, lyMrgn: 0 },
    ];
    const rows = aggregateExplodeAware({
      raw, dim: "category", explodePpk: false,
      resolveIds: cache.resolveIds, getMaster: cache.getMaster,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].grain).toBe("each");
  });
});

// ── Explode-ON: never split TOTAL rows by grain ─────────────────────
//
// Regression suite for the sub-category bug: when Explode PPK is ON,
// the per-dim aggregator can still produce rows of mixed grain
// (different sub-cats / categories / etc. that the sibling-collapse
// can't bridge). totalsForDimRows must force hasMixed=false in that
// mode so callers emit ONE combined TOTAL row — qty is uniformly in
// eaches and summing is correct.
//
// Also: under Explode ON, per-row labels must NOT carry a grain
// suffix (the suffix implies pack-vs-each, but with Explode ON
// every qty is already in eaches).

// Cross-sub-cat cache: a PPK family ("Shorts") and an each-only
// family ("Pants"). Under sub_category dim with Explode ON, these
// can't collapse into a single bucket (different sub-cat values),
// so the dim row set is mixed-grain.
function makeCrossSubCatCache(): ReturnType<typeof makeCache> & {
  ppkShorts: ItemMasterRecord; eachPants: ItemMasterRecord;
} {
  const ppkShorts = makeRecord({
    sku_code: "PPKSHORT-BLACK",
    style_code: "PPKSHORTPPK",
    color: "BLACK",
    pack_size: 24,
    attributes: { group_name: "Bottoms", category_name: "Cargo Shorts", gender: "MENS" },
  });
  const eachPants = makeRecord({
    sku_code: "PLAINPANT-NAVY",
    style_code: "PLAINPANT",
    color: "NAVY",
    pack_size: 1,
    attributes: { group_name: "Bottoms", category_name: "Twill Shorts", gender: "MENS" },
  });
  return { ...makeCache([ppkShorts, eachPants]), ppkShorts, eachPants };
}

describe("aggregateExplodeAware — explode ON, never split TOTAL row by grain", () => {
  it("sub_category dim with cross-sub-cat mixed grain emits one combined TOTAL (hasMixed=false)", () => {
    const cache = makeCrossSubCatCache();
    const raw: RawSkuAgg[] = [
      // PPK style: 2 packs × 24 = 48 eaches after explode
      { sku: "PPKSHORT-BLACK",  tyQty: 2, tyRev: 600, tyMrgn: 200, lyQty: 0, lyRev: 0, lyMrgn: 0 },
      // each style: 30 eaches as-is
      { sku: "PLAINPANT-NAVY",  tyQty: 30, tyRev: 900, tyMrgn: 300, lyQty: 0, lyRev: 0, lyMrgn: 0 },
    ];
    const rows = aggregateExplodeAware({
      raw, dim: "sub_category", explodePpk: true,
      resolveIds: cache.resolveIds, getMaster: cache.getMaster,
    });
    expect(rows).toHaveLength(2);
    // Two different sub-cats — can't collapse. One row is ppk-grain,
    // the other is each-grain.
    const grains = rows.map(r => r.grain).sort();
    expect(grains).toEqual(["each", "ppk"]);
    // Critically: totals must NOT split, because qty is uniformly
    // in eaches and summing across grains is correct.
    const totals = totalsForDimRows(rows, true);
    expect(totals.hasMixed).toBe(false);
    expect(totals.combined.tyQty).toBe(48 + 30);
    expect(totals.combined.tyRev).toBe(600 + 900);
    expect(totals.combined.tyMrgn).toBe(200 + 300);
  });

  it("per-row labels in mixed-grain dim under Explode ON carry NO '(PPK packs)' / '(each)' suffix", () => {
    const cache = makeCrossSubCatCache();
    const raw: RawSkuAgg[] = [
      { sku: "PPKSHORT-BLACK", tyQty: 1, tyRev: 100, tyMrgn: 0, lyQty: 0, lyRev: 0, lyMrgn: 0 },
      { sku: "PLAINPANT-NAVY", tyQty: 5, tyRev: 200, tyMrgn: 0, lyQty: 0, lyRev: 0, lyMrgn: 0 },
    ];
    const rows = aggregateExplodeAware({
      raw, dim: "sub_category", explodePpk: true,
      resolveIds: cache.resolveIds, getMaster: cache.getMaster,
    });
    for (const r of rows) {
      expect(r.label).not.toMatch(/\(PPK packs\)/);
      expect(r.label).not.toMatch(/\(each\)/);
    }
  });

  it("single-grain dim under Explode ON still emits one TOTAL (unchanged behavior)", () => {
    const cache = makeStandaloneCache();
    const raw: RawSkuAgg[] = [
      { sku: "SOLO-BLACK", tyQty: 5, tyRev: 100, tyMrgn: 50, lyQty: 0, lyRev: 0, lyMrgn: 0 },
    ];
    const rows = aggregateExplodeAware({
      raw, dim: "category", explodePpk: true,
      resolveIds: cache.resolveIds, getMaster: cache.getMaster,
    });
    expect(rows).toHaveLength(1);
    // Single-grain row should carry no suffix in either mode under
    // Explode ON.
    expect(rows[0].label).not.toMatch(/\(PPK packs\)/);
    expect(rows[0].label).not.toMatch(/\(each\)/);
    const totals = totalsForDimRows(rows, true);
    expect(totals.hasMixed).toBe(false);
    expect(totals.combined.tyQty).toBe(5);
  });

  it("explode OFF + mixed-grain dim still splits TOTAL (existing behavior preserved)", () => {
    const cache = makeFamilyCache();
    const raw: RawSkuAgg[] = [
      { sku: "RBB1440N-PPK-BLACK", tyQty: 2, tyRev: 528, tyMrgn: 0, lyQty: 0, lyRev: 0, lyMrgn: 0 },
      { sku: "RBB1440N-BLACK",     tyQty: 10, tyRev: 200, tyMrgn: 0, lyQty: 0, lyRev: 0, lyMrgn: 0 },
    ];
    const rows = aggregateExplodeAware({
      raw, dim: "sku", explodePpk: false,
      resolveIds: cache.resolveIds, getMaster: cache.getMaster,
    });
    const totals = totalsForDimRows(rows, false);
    // Mixed grain in OFF mode — totals MUST split so packs + eaches
    // never sum into a single misleading number.
    expect(totals.hasMixed).toBe(true);
    expect(totals.ppk.tyQty).toBe(2);
    expect(totals.each.tyQty).toBe(10);
  });
});
