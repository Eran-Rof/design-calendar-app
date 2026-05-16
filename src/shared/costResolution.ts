// src/shared/costResolution.ts
//
// Per-SKU avg unit cost lookup with the fallback cascade the planner asked
// for after the 2026-05-15 -1700% margin bug. The bug surfaced because the
// ATS export's synthetic-row builder pulled `unit_cost` from ip_item_master,
// which is poisoned for some prepack SKUs (carries StandardUnitCost ×
// MasterCaseQty from historical Excel uploads — e.g. RYB059430 shows
// $160.80 when the real unit cost is $6.70).
//
// The Xoro Item Costing Report — ingested nightly to ip_item_avg_cost
// (source='xoro') by /api/xoro/sync-item-costing — is the new source of
// truth. This helper layers a cascade on top so a SKU missing from the
// direct table still gets a reasonable cost number:
//
//   1. direct  — ip_item_avg_cost.avg_cost for this SKU
//   2. sibling — avg_cost from another child SKU in the same base part
//                (e.g. same style, different color)
//   3. po      — average unit cost across this SKU's open POs
//   4. margin  — derived from sale price × (1 − generalMarginPct/100)
//                when the caller provides a sale price
//   5. unknown — none of the above produced a value
//
// All inputs are pre-loaded maps. The helper is pure (no I/O) so it can be
// called from any client- or server-side code path. Consumers prepare
// whatever maps they have access to and pass null for the rest — the
// cascade silently falls through missing layers.

export type CostSource = "direct" | "sibling" | "po" | "margin" | "unknown";

export interface ResolveCostInput {
  /** Map of sku_code → avg_cost from ip_item_avg_cost. */
  avgCostMap?: Map<string, number> | null;
  /** Map of sku_code → list of sibling sku_codes that share a base part.
   *  Used to find a fallback cost when the SKU itself has no avg_cost. */
  siblingsBySku?: Map<string, string[]> | null;
  /** Map of sku_code → array of open-PO unit costs (already filtered to
   *  rows where the PO carries a usable cost). The cascade averages these. */
  openPoCostsBySku?: Map<string, number[]> | null;
  /** Optional fallback: caller's chosen general margin %, expressed as a
   *  percentage from 0–100 (e.g. 21 = 21%). When > 0 and a salePrice is
   *  supplied, the cascade derives cost as salePrice × (1 − pct/100). */
  generalMarginPct?: number | null;
  /** Optional sale price for the margin-derived fallback. */
  salePrice?: number | null;
}

export interface ResolvedCost {
  /** The resolved cost, or null when every cascade step came up empty. */
  cost: number | null;
  /** Which step of the cascade produced the value. "unknown" means cost is null. */
  source: CostSource;
}

const POSITIVE = (n: number | null | undefined): n is number =>
  typeof n === "number" && isFinite(n) && n > 0;

export function resolveCost(sku: string, input: ResolveCostInput): ResolvedCost {
  if (!sku) return { cost: null, source: "unknown" };

  // 1. Direct hit.
  const direct = input.avgCostMap?.get(sku);
  if (POSITIVE(direct)) return { cost: direct, source: "direct" };

  // 2. Sibling fallback. Walk sibling list and take the first one with a
  //    direct avg_cost. Ordering within the sibling list is the caller's
  //    choice (closest variant first is the typical preference).
  const siblings = input.siblingsBySku?.get(sku);
  if (siblings && input.avgCostMap) {
    for (const sib of siblings) {
      if (sib === sku) continue;
      const sibCost = input.avgCostMap.get(sib);
      if (POSITIVE(sibCost)) return { cost: sibCost, source: "sibling" };
    }
  }

  // 3. Open-PO average.
  const poCosts = input.openPoCostsBySku?.get(sku);
  if (poCosts && poCosts.length > 0) {
    let sum = 0;
    let count = 0;
    for (const c of poCosts) {
      if (POSITIVE(c)) { sum += c; count += 1; }
    }
    if (count > 0) return { cost: sum / count, source: "po" };
  }

  // 4. Margin-derived (only when caller supplied a sale price). Margin
  //    is captured in the grid (atsTypes.generalMarginPct, default 21%)
  //    and on the export modal — the resolver doesn't care which.
  if (POSITIVE(input.salePrice) && POSITIVE(input.generalMarginPct) && input.generalMarginPct < 100) {
    const derived = input.salePrice * (1 - input.generalMarginPct / 100);
    if (POSITIVE(derived)) return { cost: derived, source: "margin" };
  }

  return { cost: null, source: "unknown" };
}

// Build a sku → siblings map from a flat list of {sku, basePart} records.
// The "base part" is the style code (or whatever grouping the caller uses).
// Siblings are every other SKU sharing that base part, ordered by the
// caller's input order so the resolver picks the first usable one.
export function buildSiblingMap(
  records: Array<{ sku: string; basePart: string | null | undefined }>,
): Map<string, string[]> {
  const byBase = new Map<string, string[]>();
  for (const r of records) {
    if (!r.sku || !r.basePart) continue;
    const list = byBase.get(r.basePart) ?? [];
    list.push(r.sku);
    byBase.set(r.basePart, list);
  }
  const out = new Map<string, string[]>();
  for (const [, group] of byBase) {
    if (group.length < 2) continue;
    for (const sku of group) {
      out.set(sku, group);
    }
  }
  return out;
}
