// Sales Comps customer dim — grain-aware aggregation tests.
//
// Filed under PR #292: extends the explode-PPK split that PR #291
// shipped for sku/style/category/sub_category/gender to the Customer
// dim too. Customer was the one dim previously rolled up server-side
// without per-SKU detail, so mixed-grain customers showed an
// "added packs + eaches" qty in a single row. PR #292 added a
// per-(customer, sku) breakdown to result.byCustomer.bySku (built
// in the same row scan as t3/ly — no extra DB query) and rewired
// the customer-dim aggregator to use it via aggregateExplodeAware
// with the customer dim.
//
// Covers the four required behaviors from the task:
//   * Explode ON: a mixed-grain customer collapses PPK + each
//     contributions into ONE row with qty in eaches
//   * Explode OFF: a mixed-grain customer splits into TWO rows
//     (one tagged "(PPK packs)", one tagged "(each)")
//   * Explode OFF: a PPK-only customer renders one row tagged
//     "(PPK packs)"
//   * Explode OFF: an each-only customer renders one row tagged
//     "(each)"
//
// Plus structural tests:
//   * Customer SO contribution applies the same grain-aware logic
//     (customerRawAggs combines result.byCustomer.bySku + open SOs)
//   * totalsForDimRows surfaces hasMixed when both grains are present
//
// Uses the same makeRecord / makeCache helper pattern as
// salesCompsExplodePpk.test.ts so the customer-dim tests stay readable
// alongside the existing sku/style/category coverage.

import { describe, it, expect } from "vitest";
import {
  aggregateExplodeAware,
  totalsForDimRows,
  type AggregateExplodeAwareArgs,
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

// Shared cache: a single style family (RBB1440N) with both a PPK-grain
// row (pack_size=48) and an each-grain row. Matches the family pattern
// from salesCompsExplodePpk.test.ts so the customer-dim coverage stays
// alongside the existing sku/style/category coverage.
function makeFamilyCache() {
  const ppk = makeRecord({
    sku_code: "RBB1440N-PPK-BLACK",
    style_code: "RBB1440N-PPK",
    color: "BLACK",
    pack_size: 48,
  });
  const each = makeRecord({
    sku_code: "RBB1440N-BLACK",
    style_code: "RBB1440N",
    color: "BLACK",
    pack_size: 1,
  });
  return { ...makeCache([ppk, each]), ppk, each };
}

type CustomerRawArg = NonNullable<AggregateExplodeAwareArgs["customerRaw"]>[number];

describe("aggregateExplodeAware — customer dim, explode ON", () => {
  it("collapses a mixed-grain customer's PPK + each contributions into ONE row, qty in eaches", () => {
    const cache = makeFamilyCache();
    const customerRaw: CustomerRawArg[] = [
      // Ross bought 2 packs (= 96 eaches when exploded) of the PPK sku
      { customer: "Ross Procurement", sku: "RBB1440N-PPK-BLACK", tyQty: 2,  tyRev: 528, tyMrgn: 100, lyQty: 0, lyRev: 0,   lyMrgn: 0 },
      // and 10 individual eaches of the each-grain sibling
      { customer: "Ross Procurement", sku: "RBB1440N-BLACK",     tyQty: 10, tyRev: 200, tyMrgn: 50,  lyQty: 0, lyRev: 0,   lyMrgn: 0 },
    ];
    const rows = aggregateExplodeAware({
      raw: [], dim: "customer", explodePpk: true,
      resolveIds: cache.resolveIds, getMaster: cache.getMaster,
      customerRaw,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe("Ross Procurement");
    // 2 packs × 48 = 96 eaches + 10 eaches = 106 total eaches
    expect(rows[0].tyQty).toBe(106);
    // Revenue + margin never multiplied
    expect(rows[0].tyRev).toBe(728);
    expect(rows[0].tyMrgn).toBe(150);
  });

  it("includes LY contributions in the collapsed row", () => {
    const cache = makeFamilyCache();
    const customerRaw: CustomerRawArg[] = [
      { customer: "Ross Procurement", sku: "RBB1440N-PPK-BLACK", tyQty: 1, tyRev: 264, tyMrgn: 0, lyQty: 1, lyRev: 264, lyMrgn: 0 },
      { customer: "Ross Procurement", sku: "RBB1440N-BLACK",     tyQty: 5, tyRev: 100, tyMrgn: 0, lyQty: 4, lyRev: 80,  lyMrgn: 0 },
    ];
    const rows = aggregateExplodeAware({
      raw: [], dim: "customer", explodePpk: true,
      resolveIds: cache.resolveIds, getMaster: cache.getMaster,
      customerRaw,
    });
    expect(rows).toHaveLength(1);
    // TY: 1 × 48 + 5 = 53 eaches; LY: 1 × 48 + 4 = 52 eaches
    expect(rows[0].tyQty).toBe(53);
    expect(rows[0].lyQty).toBe(52);
    expect(rows[0].tyRev).toBe(364);
    expect(rows[0].lyRev).toBe(344);
  });
});

describe("aggregateExplodeAware — customer dim, explode OFF", () => {
  it("splits a mixed-grain customer into TWO rows tagged (PPK packs) and (each)", () => {
    const cache = makeFamilyCache();
    const customerRaw: CustomerRawArg[] = [
      { customer: "Ross Procurement", sku: "RBB1440N-PPK-BLACK", tyQty: 2,  tyRev: 528, tyMrgn: 0, lyQty: 1, lyRev: 264, lyMrgn: 0 },
      { customer: "Ross Procurement", sku: "RBB1440N-BLACK",     tyQty: 10, tyRev: 200, tyMrgn: 0, lyQty: 5, lyRev: 100, lyMrgn: 0 },
    ];
    const rows = aggregateExplodeAware({
      raw: [], dim: "customer", explodePpk: false,
      resolveIds: cache.resolveIds, getMaster: cache.getMaster,
      customerRaw,
    });
    expect(rows).toHaveLength(2);
    const ppkRow = rows.find(r => r.grain === "ppk");
    const eachRow = rows.find(r => r.grain === "each");
    expect(ppkRow).toBeDefined();
    expect(eachRow).toBeDefined();
    // PPK row: qty stays in packs, not multiplied
    expect(ppkRow!.tyQty).toBe(2);
    expect(ppkRow!.lyQty).toBe(1);
    expect(ppkRow!.label).toBe("Ross Procurement (PPK packs)");
    // Each row: qty stays in eaches
    expect(eachRow!.tyQty).toBe(10);
    expect(eachRow!.lyQty).toBe(5);
    expect(eachRow!.label).toBe("Ross Procurement (each)");
    // Revenue accumulates per grain (no double counting)
    expect(ppkRow!.tyRev).toBe(528);
    expect(eachRow!.tyRev).toBe(200);
  });

  it("renders a PPK-only customer as a single row tagged (PPK packs)", () => {
    const cache = makeFamilyCache();
    const customerRaw: CustomerRawArg[] = [
      { customer: "Heritage Surf", sku: "RBB1440N-PPK-BLACK", tyQty: 3, tyRev: 792, tyMrgn: 0, lyQty: 2, lyRev: 528, lyMrgn: 0 },
    ];
    const rows = aggregateExplodeAware({
      raw: [], dim: "customer", explodePpk: false,
      resolveIds: cache.resolveIds, getMaster: cache.getMaster,
      customerRaw,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].grain).toBe("ppk");
    expect(rows[0].label).toBe("Heritage Surf (PPK packs)");
    expect(rows[0].tyQty).toBe(3); // packs, not multiplied
    expect(rows[0].lyQty).toBe(2);
  });

  it("renders an each-only customer as a single row tagged (each)", () => {
    const cache = makeFamilyCache();
    const customerRaw: CustomerRawArg[] = [
      { customer: "Macy's", sku: "RBB1440N-BLACK", tyQty: 25, tyRev: 500, tyMrgn: 100, lyQty: 20, lyRev: 400, lyMrgn: 80 },
    ];
    const rows = aggregateExplodeAware({
      raw: [], dim: "customer", explodePpk: false,
      resolveIds: cache.resolveIds, getMaster: cache.getMaster,
      customerRaw,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].grain).toBe("each");
    expect(rows[0].label).toBe("Macy's (each)");
    expect(rows[0].tyQty).toBe(25);
    expect(rows[0].lyQty).toBe(20);
  });

  it("multiple customers each split independently by grain", () => {
    const cache = makeFamilyCache();
    const customerRaw: CustomerRawArg[] = [
      // Mixed customer — should produce 2 rows
      { customer: "Ross Procurement", sku: "RBB1440N-PPK-BLACK", tyQty: 1, tyRev: 264, tyMrgn: 0, lyQty: 0, lyRev: 0, lyMrgn: 0 },
      { customer: "Ross Procurement", sku: "RBB1440N-BLACK",     tyQty: 4, tyRev: 80,  tyMrgn: 0, lyQty: 0, lyRev: 0, lyMrgn: 0 },
      // PPK-only customer — 1 row
      { customer: "Heritage Surf", sku: "RBB1440N-PPK-BLACK", tyQty: 2, tyRev: 528, tyMrgn: 0, lyQty: 0, lyRev: 0, lyMrgn: 0 },
      // Each-only customer — 1 row
      { customer: "Macy's", sku: "RBB1440N-BLACK", tyQty: 7, tyRev: 140, tyMrgn: 0, lyQty: 0, lyRev: 0, lyMrgn: 0 },
    ];
    const rows = aggregateExplodeAware({
      raw: [], dim: "customer", explodePpk: false,
      resolveIds: cache.resolveIds, getMaster: cache.getMaster,
      customerRaw,
    });
    // 2 (Ross) + 1 (Heritage) + 1 (Macy's) = 4 rows
    expect(rows).toHaveLength(4);
    const labels = rows.map(r => r.label).sort();
    expect(labels).toEqual([
      "Heritage Surf (PPK packs)",
      "Macy's (each)",
      "Ross Procurement (PPK packs)",
      "Ross Procurement (each)",
    ]);
  });
});

describe("aggregateExplodeAware — customer dim totals", () => {
  it("totalsForDimRows surfaces hasMixed when a mixed-grain customer is in the set (explode OFF)", () => {
    const cache = makeFamilyCache();
    const customerRaw: CustomerRawArg[] = [
      { customer: "Ross Procurement", sku: "RBB1440N-PPK-BLACK", tyQty: 2, tyRev: 528, tyMrgn: 0, lyQty: 0, lyRev: 0, lyMrgn: 0 },
      { customer: "Ross Procurement", sku: "RBB1440N-BLACK",     tyQty: 10, tyRev: 200, tyMrgn: 0, lyQty: 0, lyRev: 0, lyMrgn: 0 },
    ];
    const rows = aggregateExplodeAware({
      raw: [], dim: "customer", explodePpk: false,
      resolveIds: cache.resolveIds, getMaster: cache.getMaster,
      customerRaw,
    });
    const totals = totalsForDimRows(rows);
    expect(totals.hasMixed).toBe(true);
    expect(totals.ppk.tyQty).toBe(2);
    expect(totals.each.tyQty).toBe(10);
    // combined.tyQty is 2 + 10 = 12 — used only when callers want a
    // grain-blended sum (explode-ON mode does this naturally because
    // the PPK qty is already multiplied to eaches in the rows).
    expect(totals.combined.tyQty).toBe(12);
  });

  it("totalsForDimRows returns hasMixed=false for a single-grain customer set", () => {
    const cache = makeFamilyCache();
    const customerRaw: CustomerRawArg[] = [
      { customer: "Macy's", sku: "RBB1440N-BLACK", tyQty: 25, tyRev: 500, tyMrgn: 0, lyQty: 20, lyRev: 400, lyMrgn: 0 },
    ];
    const rows = aggregateExplodeAware({
      raw: [], dim: "customer", explodePpk: false,
      resolveIds: cache.resolveIds, getMaster: cache.getMaster,
      customerRaw,
    });
    const totals = totalsForDimRows(rows);
    expect(totals.hasMixed).toBe(false);
    expect(totals.each.tyQty).toBe(25);
    expect(totals.ppk.tyQty).toBe(0);
  });
});

describe("aggregateExplodeAware — customer dim, SO contribution shape", () => {
  // The SalesCompsModal merges open-SO contributions per (customer,
  // sku_code) into the same customerRawAggs array consumed by the
  // aggregator. This test mimics that merge — same SKU appearing
  // twice for one customer should fold cleanly under (cust, sku)
  // without producing a duplicate row.
  it("merges duplicate (customer, sku) entries from history + SO", () => {
    const cache = makeFamilyCache();
    // Shipped history (from result.byCustomer.bySku):
    const fromHistory: CustomerRawArg = {
      customer: "Ross Procurement", sku: "RBB1440N-PPK-BLACK",
      tyQty: 2, tyRev: 528, tyMrgn: 100, lyQty: 1, lyRev: 264, lyMrgn: 50,
    };
    // Open SO contribution for the same (customer, sku):
    const fromSo: CustomerRawArg = {
      customer: "Ross Procurement", sku: "RBB1440N-PPK-BLACK",
      tyQty: 3, tyRev: 792, tyMrgn: 150, lyQty: 0, lyRev: 0, lyMrgn: 0,
    };
    const rows = aggregateExplodeAware({
      raw: [], dim: "customer", explodePpk: false,
      resolveIds: cache.resolveIds, getMaster: cache.getMaster,
      customerRaw: [fromHistory, fromSo],
    });
    // Aggregator buckets by (customer::grain) — so both PPK rows
    // collapse into one customer row.
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe("Ross Procurement (PPK packs)");
    expect(rows[0].tyQty).toBe(5);       // 2 + 3 packs
    expect(rows[0].tyRev).toBe(1320);    // 528 + 792
    expect(rows[0].tyMrgn).toBe(250);    // 100 + 150
    expect(rows[0].lyQty).toBe(1);
  });

  it("SO-only customer (no history) still shows up with TY contribution", () => {
    const cache = makeFamilyCache();
    const customerRaw: CustomerRawArg[] = [
      { customer: "New Account", sku: "RBB1440N-PPK-BLACK", tyQty: 4, tyRev: 1056, tyMrgn: 200, lyQty: 0, lyRev: 0, lyMrgn: 0 },
    ];
    const rows = aggregateExplodeAware({
      raw: [], dim: "customer", explodePpk: false,
      resolveIds: cache.resolveIds, getMaster: cache.getMaster,
      customerRaw,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe("New Account (PPK packs)");
    expect(rows[0].tyQty).toBe(4);
    expect(rows[0].lyQty).toBe(0);
  });
});

// Server-response shape test: result.byCustomer.bySku is the new
// per-(customer, sku_id) breakdown added in PR #292. The SalesCompsModal
// transforms it into customerRawAggs by resolving each sku_id to its
// master's sku_code (so the aggregator can resolve grain via
// resolveItemMasterIds). Mirrors that transform here to lock the shape
// contract — if the server starts emitting a different key per entry,
// or the transform drops a customer with only unresolvable sku_ids,
// these tests fail.
describe("byCustomer.bySku → customerRawAggs transform", () => {
  it("resolves sku_id → sku_code via the master cache and produces one (cust, sku_code) entry per pair", () => {
    const cache = makeFamilyCache();
    // Mock the server response shape after the row scan
    type ServerEntry = {
      customerName: string;
      bySku: Map<string, { t3: { qty: number; totalPrice: number; marginAmount: number }; ly: { qty: number; totalPrice: number; marginAmount: number } }>;
    };
    const ross: ServerEntry = {
      customerName: "Ross Procurement",
      bySku: new Map([
        [cache.ppk.id, { t3: { qty: 2, totalPrice: 528, marginAmount: 100 }, ly: { qty: 1, totalPrice: 264, marginAmount: 50 } }],
        [cache.each.id, { t3: { qty: 10, totalPrice: 200, marginAmount: 50 }, ly: { qty: 4, totalPrice: 80, marginAmount: 20 } }],
      ]),
    };
    // Apply the same transform the modal does
    const out: CustomerRawArg[] = [];
    for (const [skuId, agg] of ross.bySku) {
      const master = cache.getMaster(skuId);
      const skuKey = master?.sku_code ?? `__unresolved:${skuId.slice(0, 8)}`;
      out.push({
        customer: ross.customerName, sku: skuKey,
        tyQty: agg.t3.qty, tyRev: agg.t3.totalPrice, tyMrgn: agg.t3.marginAmount,
        lyQty: agg.ly.qty, lyRev: agg.ly.totalPrice, lyMrgn: agg.ly.marginAmount,
      });
    }
    expect(out).toHaveLength(2);
    const ppkEntry = out.find(e => e.sku === "RBB1440N-PPK-BLACK");
    const eachEntry = out.find(e => e.sku === "RBB1440N-BLACK");
    expect(ppkEntry).toBeDefined();
    expect(eachEntry).toBeDefined();
    expect(ppkEntry!.tyQty).toBe(2);
    expect(eachEntry!.lyQty).toBe(4);

    // Round-trip through the aggregator to lock the explode-OFF split
    const rows = aggregateExplodeAware({
      raw: [], dim: "customer", explodePpk: false,
      resolveIds: cache.resolveIds, getMaster: cache.getMaster,
      customerRaw: out,
    });
    expect(rows).toHaveLength(2);
    expect(rows.find(r => r.grain === "ppk")!.tyQty).toBe(2);
    expect(rows.find(r => r.grain === "each")!.tyQty).toBe(10);
  });

  it("falls back to a synthetic (unresolved) sku label when the master can't be resolved", () => {
    const cache = makeFamilyCache();
    const unresolvedId = "00000000-0000-0000-0000-000000000abc";
    const master = cache.getMaster(unresolvedId);
    expect(master).toBeNull();
    const skuKey = master?.sku_code ?? `__unresolved:${unresolvedId.slice(0, 8)}`;
    expect(skuKey).toBe("__unresolved:00000000");
    // Aggregator falls back to each grain for null masters — totals
    // stay correct even though grain-split detail isn't possible.
    const rows = aggregateExplodeAware({
      raw: [], dim: "customer", explodePpk: false,
      resolveIds: cache.resolveIds, getMaster: cache.getMaster,
      customerRaw: [
        { customer: "Mystery Customer", sku: skuKey, tyQty: 7, tyRev: 100, tyMrgn: 0, lyQty: 3, lyRev: 50, lyMrgn: 0 },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].grain).toBe("each");
    expect(rows[0].tyQty).toBe(7);
    expect(rows[0].lyQty).toBe(3);
  });
});
