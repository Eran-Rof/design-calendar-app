// src/ats/exportCostCascade.ts
//
// ATS export cost-cascade utilities. Two consumer sites in NavBar.tsx
// were running near-identical cost-resolution loops:
//   1. Out-of-stock-row hydration (regular grid rows where the ATS
//      Inventory Snapshot didn't carry an Avg Cost — typically SKUs
//      with high On PO but 0 On Hand).
//   2. Cross-grid synthetic rows (customers' historical sales for SKUs
//      that aren't in the current grid at all).
//
// Both paths call resolveCost() and then divide by ppkMult to convert
// the cascade's pack-grain result (ip_item_avg_cost stores prepack cost
// at pack grain) into per-unit cost (the export's contract — costMul
// inside exportExcel.ts multiplies back up if explodePpk is off).
//
// Concentrating that divide here ensures a future cost-cascade bug fix
// only needs to land in one place. The 2026-05-16 incident where the
// cross-grid path was fixed but the out-of-stock path still showed
// $136.80 instead of $5.70 motivated this extraction.
//
// The full hydrateRowsAvgCost() also wraps the Block 1 flow — fetching
// avg-cost + open-PO maps, building the sibling map across all rows,
// and applying the cascade to each row needing hydration. Block 2's
// per-group orchestration stays in NavBar.tsx since its input shape
// (cached ip_item_master records + sales aggregates) differs from a
// flat ATSRow[]; it just calls resolveCostPerUnit() per group.

import type { ATSRow } from "./types";
import { canonSku, canonStyleColor } from "../inventory-planning/utils/skuCanon";
import {
  resolveCost,
  buildSiblingMap,
  type ResolveCostInput,
  type CostSource,
} from "../shared/costResolution";

export interface CostSourceCounts {
  direct: number;
  sibling: number;
  po: number;
  margin: number;
  unknown: number;
}

export function emptyCostSourceCounts(): CostSourceCounts {
  return { direct: 0, sibling: 0, po: 0, margin: 0, unknown: 0 };
}

export interface ResolvedPerUnit {
  cost: number | null;
  source: CostSource;
}

/** Convert a pack-grain cost to per-unit by dividing by ppkMult.
 *  ip_item_avg_cost stores prepack cost at pack grain (Xoro's Item
 *  Costing Report inherits the master's grain), and the export expects
 *  r.avgCost in per-unit grain. Non-prepack inputs (ppkMult <= 1) pass
 *  through unchanged. Null / non-positive inputs pass through unchanged.
 *
 *  Use this for already-resolved costs. For the resolve + divide combo
 *  in one call, use resolveCostPerUnit() below. */
export function toUnitGrainCost(
  cost: number | null,
  ppkMult: number | null | undefined,
): number | null {
  if (cost == null || cost <= 0) return cost;
  const mult = typeof ppkMult === "number" && ppkMult > 1 ? ppkMult : 1;
  return cost / mult;
}

/** Run the cost cascade and convert the result from pack-grain to
 *  per-unit grain via ppkMult. Callers that don't care about grain
 *  (e.g. inventory-planning whose rows are already at BASE-COLOR grain)
 *  can pass ppkMult = 1. */
export function resolveCostPerUnit(
  sku: string,
  ppkMult: number,
  input: ResolveCostInput,
): ResolvedPerUnit {
  const resolved = resolveCost(sku, input);
  return {
    cost: toUnitGrainCost(resolved.cost, ppkMult),
    source: resolved.source,
  };
}

export interface HydrateRowsAvgCostInput {
  /** All export rows (in-stock + out-of-stock). The hydration step only
   *  modifies rows whose avgCost is missing/zero, but the full set is
   *  used to source siblings + augment the avg-cost map with rows that
   *  already have a known cost. */
  rows: ATSRow[];
  /** Pre-fetched avg-cost map from ip_item_avg_cost, keyed by canonical
   *  sku_code (canonStyleColor). */
  avgCostMap: Map<string, number>;
  /** Pre-fetched open-PO unit-cost lists, keyed by canonical sku_code. */
  openPoCostsBySku: Map<string, number[]>;
  /** General margin % from the grid / export modal (0–100). Used as the
   *  margin-derived fallback when a sale price is available — currently
   *  not applied here since regular-grid rows don't carry a sale price,
   *  but accepted so the helper signature can extend later. */
  generalMarginPct?: number;
}

export interface HydrateRowsAvgCostResult {
  rows: ATSRow[];
  hydrated: number;
  needed: number;
  sourceCounts: CostSourceCounts;
}

/** Hydrate avgCost on every export row whose ATS-snapshot value was
 *  missing (typically out-of-stock SKUs). Apply the shared cascade
 *  (direct → sibling → po → margin) and convert pack-grain results
 *  to per-unit via ppkMult. Returns a fresh row array; in-stock rows
 *  pass through unchanged. */
export function hydrateRowsAvgCost(
  input: HydrateRowsAvgCostInput,
): HydrateRowsAvgCostResult {
  const { rows, avgCostMap: fetched, openPoCostsBySku, generalMarginPct } = input;
  const sourceCounts = emptyCostSourceCounts();
  const needsHydrate = rows.filter(
    (r) => !(typeof r.avgCost === "number" && r.avgCost > 0),
  );
  if (needsHydrate.length === 0) {
    return { rows, hydrated: 0, needed: 0, sourceCounts };
  }

  const canonByRow = new Map<ATSRow, string>();
  for (const r of needsHydrate) {
    const c = canonStyleColor(r.sku);
    if (c) canonByRow.set(r, c);
  }

  // Sibling map across ALL rows' canonical style codes so a missing
  // row can borrow cost from its in-stock variants too.
  const siblingsBySku = buildSiblingMap(
    rows
      .map((r) => {
        const canonical = canonStyleColor(r.sku);
        const style = canonical ? canonical.split("-")[0] : null;
        return { sku: canonical, basePart: style };
      })
      .filter((x) => !!x.sku),
  );

  // Include in-stock rows' avgCost in the avg-cost map — they're not
  // in ip_item_avg_cost but are equally valid for sibling-step lookups.
  const merged = new Map<string, number>(fetched);
  for (const r of rows) {
    const c = canonSku(r.sku);
    if (c && typeof r.avgCost === "number" && r.avgCost > 0 && !merged.has(c)) {
      merged.set(c, r.avgCost);
    }
  }

  let hydrated = 0;
  const out = rows.map((r) => {
    if (typeof r.avgCost === "number" && r.avgCost > 0) return r;
    const canonical = canonByRow.get(r);
    if (!canonical) return r;
    const resolved = resolveCostPerUnit(canonical, r.ppkMult ?? 1, {
      avgCostMap: merged,
      siblingsBySku,
      openPoCostsBySku,
      generalMarginPct,
    });
    sourceCounts[resolved.source]++;
    if (resolved.cost && resolved.cost > 0) {
      hydrated++;
      return { ...r, avgCost: resolved.cost };
    }
    return r;
  });

  return { rows: out, hydrated, needed: needsHydrate.length, sourceCounts };
}
