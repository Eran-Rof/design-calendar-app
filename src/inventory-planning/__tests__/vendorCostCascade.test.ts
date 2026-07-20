// Tests for the vendor-first unit-cost cascade (CEO ask: same style bought
// from multiple vendors at different true costs). See
// ../utils/vendorCostCascade.ts.
//
// The vendor wrapper layers two vendor-scoped tiers ON TOP of the existing
// cascade:
//   1. vendor OPEN-PO cost (qty-weighted per-each)
//   2. vendor most-recent RECEIVED-PO cost (price guide)
//   3. existing avg cascade (direct -> sibling)      \ delegated to
//   4. existing any-vendor open-PO grain-aware fallback / cascadePlanningCostForItem
// With no vendor selected the wrapper is byte-identical to the existing cascade.

import { describe, it, expect } from "vitest";
import {
  buildVendorCostMaps,
  cascadeVendorAwareCostForItem,
  type VendorPoCostRow,
} from "../utils/vendorCostCascade";
import {
  cascadePlanningCostForItem,
  buildPoEachCostByBaseColor,
  buildPoEachCostByStyle,
  type PoCostRow,
  type PlanningCostMaps,
} from "../utils/poCostFallback";

// The RYB0185PPK camo scenario from the CEO: pack size 24, two vendors.
const packMap = new Map<string, number>([["ryb0185ppk", 24]]);
const emptyMaps: PlanningCostMaps = {
  avgCostMap: new Map<string, number>(),
  siblingsBySku: new Map<string, string[]>(),
  openPoCostsBySku: new Map<string, number[]>(),
  poEachCostByBaseColor: new Map<string, number>(),
  poEachCostByStyle: new Map<string, number>(),
  prepackUnitsPerPack: packMap,
};

// Helper to build a vendor PO cost row (pack_size already resolved, like the
// service does before calling buildVendorCostMaps).
function vRow(p: Partial<VendorPoCostRow> & { sku_code: string; unit_cost: number }): VendorPoCostRow {
  return {
    sku_code: p.sku_code,
    unit_cost: p.unit_cost,
    qty_open: p.qty_open ?? 0,
    qty_received: p.qty_received ?? 0,
    pack_size: p.pack_size ?? 24,
    is_open: p.is_open ?? false,
    is_received: p.is_received ?? false,
    order_date: p.order_date ?? null,
  };
}

describe("cascadeVendorAwareCostForItem", () => {
  const item = { sku_code: "RYB0185PPK-CHARCOAL", pack_size: 1 };

  it("tier 1: vendor OPEN-PO cost wins over everything below", () => {
    // Vendor has an open PO at $122.16/pack; there is ALSO a direct avg of
    // $121.20 — the vendor open PO must win (vendor-first).
    const vendorMaps = buildVendorCostMaps([
      vRow({ sku_code: "RYB0185PPK-CHARCOAL", unit_cost: 122.16, qty_open: 127, is_open: true, order_date: "2026-06-16" }),
    ]);
    const maps: PlanningCostMaps = { ...emptyMaps, avgCostMap: new Map([["RYB0185PPK-CHARCOAL", 121.2]]) };
    expect(cascadeVendorAwareCostForItem(item, maps, vendorMaps)).toBeCloseTo(122.16, 6);
  });

  it("tier 2: vendor RECEIVED price guide fills when the vendor has no open PO", () => {
    // No open PO for the vendor; most-recent received line is $118.00/pack.
    const vendorMaps = buildVendorCostMaps([
      vRow({ sku_code: "RYB0185PPK-CHARCOAL", unit_cost: 110.0, qty_received: 24, is_received: true, order_date: "2026-01-10" }),
      vRow({ sku_code: "RYB0185PPK-CHARCOAL", unit_cost: 118.0, qty_received: 24, is_received: true, order_date: "2026-05-01" }),
    ]);
    // A direct avg exists but must lose to the vendor tiers.
    const maps: PlanningCostMaps = { ...emptyMaps, avgCostMap: new Map([["RYB0185PPK-CHARCOAL", 121.2]]) };
    expect(cascadeVendorAwareCostForItem(item, maps, vendorMaps)).toBeCloseTo(118.0, 6);
  });

  it("tier 2 picks the MOST RECENT received cost, not an average", () => {
    const vendorMaps = buildVendorCostMaps([
      vRow({ sku_code: "RYB0185PPK-CHARCOAL", unit_cost: 100.0, qty_received: 240, is_received: true, order_date: "2025-12-01" }),
      vRow({ sku_code: "RYB0185PPK-CHARCOAL", unit_cost: 130.0, qty_received: 24, is_received: true, order_date: "2026-06-01" }),
    ]);
    // Weighted avg would be ~102.7; most-recent is 130.0.
    expect(cascadeVendorAwareCostForItem(item, emptyMaps, vendorMaps)).toBeCloseTo(130.0, 6);
  });

  it("tier 3: falls through to the avg cascade when the vendor has no PO for the style", () => {
    // Vendor maps built from a DIFFERENT style — no hit for RYB0185.
    const vendorMaps = buildVendorCostMaps([
      vRow({ sku_code: "RYB9999-BLUE", unit_cost: 50.0, qty_open: 10, is_open: true, order_date: "2026-06-16" }),
    ]);
    const maps: PlanningCostMaps = { ...emptyMaps, avgCostMap: new Map([["RYB0185PPK-CHARCOAL", 121.2]]) };
    expect(cascadeVendorAwareCostForItem(item, maps, vendorMaps)).toBeCloseTo(121.2, 6);
  });

  it("tier 4: falls through to the any-vendor open-PO fallback when vendor + avg both miss", () => {
    const vendorMaps = buildVendorCostMaps([]); // vendor has nothing
    const anyVendorPos: PoCostRow[] = [
      { sku_code: "RYB0185PPK-CHARCOAL", unit_cost: 117.36, qty_open: 163, pack_size: 24 },
    ];
    const maps: PlanningCostMaps = {
      ...emptyMaps,
      poEachCostByBaseColor: buildPoEachCostByBaseColor(anyVendorPos),
      poEachCostByStyle: buildPoEachCostByStyle(anyVendorPos),
    };
    expect(cascadeVendorAwareCostForItem(item, maps, vendorMaps)).toBeCloseTo(117.36, 6);
  });

  it("zero-PO vendor guard: empty vendor maps never block — cascade still resolves", () => {
    const vendorMaps = buildVendorCostMaps([]);
    const maps: PlanningCostMaps = { ...emptyMaps, avgCostMap: new Map([["RYB0185PPK-CHARCOAL", 121.2]]) };
    expect(cascadeVendorAwareCostForItem(item, maps, vendorMaps)).toBeCloseTo(121.2, 6);
  });

  it("no vendor (vendorMaps=null) is IDENTICAL to the existing cascade (regression)", () => {
    const anyVendorPos: PoCostRow[] = [
      { sku_code: "RYB0185PPK-CHARCOAL", unit_cost: 117.36, qty_open: 163, pack_size: 24 },
    ];
    const maps: PlanningCostMaps = {
      ...emptyMaps,
      avgCostMap: new Map([["RYB0185PPK-TONALBLACKCAMO", 121.2]]),
      siblingsBySku: new Map([["RYB0185PPK-CHARCOAL", ["RYB0185PPK-CHARCOAL", "RYB0185PPK-TONALBLACKCAMO"]]]),
      poEachCostByBaseColor: buildPoEachCostByBaseColor(anyVendorPos),
      poEachCostByStyle: buildPoEachCostByStyle(anyVendorPos),
    };
    for (const sku of ["RYB0185PPK-CHARCOAL", "RYB0185-CHARCOAL", "RYB0185PPK-TONALBLACKCAMO"]) {
      const it = { sku_code: sku, pack_size: 1 };
      expect(cascadeVendorAwareCostForItem(it, maps, null)).toEqual(cascadePlanningCostForItem(it, maps));
    }
  });

  it("vendor tier is grain-aware: an each-grain sibling row gets the per-each vendor price", () => {
    // Vendor open PO sits on the pack sku at $122.16/pack; the base garment
    // each-grain row (RYB0185-CHARCOAL, pack 1) reads per-each 122.16/24 = 5.09.
    const vendorMaps = buildVendorCostMaps([
      vRow({ sku_code: "RYB0185PPK-CHARCOAL", unit_cost: 122.16, qty_open: 127, is_open: true, order_date: "2026-06-16" }),
    ]);
    expect(
      cascadeVendorAwareCostForItem({ sku_code: "RYB0185-CHARCOAL", pack_size: 1 }, emptyMaps, vendorMaps),
    ).toBeCloseTo(5.09, 2);
  });

  it("tier 1 open cost is a qty-weighted average across the vendor's open lines", () => {
    const vendorMaps = buildVendorCostMaps([
      vRow({ sku_code: "RYB0185PPK-CHARCOAL", unit_cost: 120.0, qty_open: 100, is_open: true, order_date: "2026-06-01" }),
      vRow({ sku_code: "RYB0185PPK-CHARCOAL", unit_cost: 132.0, qty_open: 300, is_open: true, order_date: "2026-06-02" }),
    ]);
    // (120*100 + 132*300) / 400 = 129.0 per pack.
    expect(cascadeVendorAwareCostForItem(item, emptyMaps, vendorMaps)).toBeCloseTo(129.0, 6);
  });
});
