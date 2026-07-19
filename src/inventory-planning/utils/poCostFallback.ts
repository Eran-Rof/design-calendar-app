// src/inventory-planning/utils/poCostFallback.ts
//
// Planning-specific open-PO cost fallback for the wholesale grid.
//
// BUG (RYB0412PPK et al): a prepack/PPK style whose only cost signal is an
// open PO showed a BLANK Unit Cost. Two reasons:
//   1. shared resolveCost's open-PO step matches only the row's EXACT
//      sku_code. A PO sitting on the pack-grain PPK sibling
//      (RYB0412PPK-<color>) never reaches the each-grain style rows
//      (RYB0412-<color>).
//   2. a PPK PO price is a per-PACK price, not per-each.
//
// This module keeps resolveCost's exact-sku behavior intact (ATS relies on
// it) and adds a planning-only fallback that is grain-aware via ONE formula:
//
//     rowPoCost = poUnitCost * (rowPackSize / poPackSize)
//
// which, factored through a canonical per-each cost, is:
//
//     perEach   = poUnitCost / poPackSize            (aggregated by BASE-COLOR)
//     rowPoCost = perEach * rowPackSize
//
// An each-grain row (rowPackSize=1) therefore shows the per-each price
// (pack ÷ packSize); a pack-grain row shows the pack price. Same formula,
// "depends on the row's grain".
//
// PRECEDENCE: this is a FALLBACK ONLY. The caller applies it strictly after
// the direct-avg → sibling-avg cascade in resolveCost — a PO price never
// overrides an existing avg cost.

import { canonSku, SIZE_SUFFIX_RE } from "./skuCanon";

const POSITIVE = (n: number | null | undefined): n is number =>
  typeof n === "number" && Number.isFinite(n) && n > 0;

// Canonical BASE-COLOR key: strip the trailing size suffix (incl. a
// `-PPK24`-style suffix) AND any glued `PPK`/`PPK<n>` token in the style
// portion, leaving `<style>-<color>`. Groups a PO on `RYB0412PPK-BLACK`
// (or `RYB0412-BLACK-PPK24`) onto the each-grain `RYB0412-BLACK` row.
//
// Mirrors the PPK-token stripping the suite uses elsewhere
// (utils/skuCanon.ts SIZE_SUFFIX_RE + api/_lib/sales-grain.js PPK_TOKEN_RE),
// kept here so the planning grid derives the same style+color base.
export function baseColorKey(sku: string | null | undefined): string {
  let s = canonSku(sku);
  if (!s) return s;
  // 1. trailing size suffix (also catches a `-PPK<n>` size suffix form).
  s = s.replace(SIZE_SUFFIX_RE, "");
  // 2. glued PPK token in the style portion — `RYB0412PPK-BLACK` →
  //    `RYB0412-BLACK`, and bare `RYB0412PPK` → `RYB0412`.
  s = s.replace(/PPK\d*(?=-|$)/g, "");
  return s;
}

// The prepack-matrix lookup key for a SKU: the style portion (everything
// before the first dash, or the whole SKU when there is no dash),
// lowercased — matches listPrepackUnitsPerPack()'s lowercased
// ppk_style_code keys (e.g. "ryb0412ppk").
export function ppkStyleKeyOf(sku: string | null | undefined): string {
  const s = canonSku(sku);
  if (!s) return "";
  const dash = s.indexOf("-");
  return (dash > 0 ? s.slice(0, dash) : s).toLowerCase();
}

// Resolve a SKU's pack size: prefer the active prepack matrix (keyed by
// lowercased ppk style code), then the item-master pack_size column,
// else 1. Only values > 1 count as a real pack size.
export function resolvePackSize(
  sku: string | null | undefined,
  itemPackSize: number | null | undefined,
  prepackUnitsPerPack: Map<string, number> | null | undefined,
): number {
  const key = ppkStyleKeyOf(sku);
  const fromMatrix = key ? prepackUnitsPerPack?.get(key) : undefined;
  if (POSITIVE(fromMatrix) && fromMatrix > 1) return fromMatrix;
  if (POSITIVE(itemPackSize) && itemPackSize > 1) return itemPackSize;
  return 1;
}

// One open-PO row's cost input for the fallback. pack_size is the already-
// resolved pack size for THIS PO's sku (via resolvePackSize).
export interface PoCostRow {
  sku_code: string;
  unit_cost: number | null;
  qty_open: number | null;
  pack_size: number | null;
}

// Weighted-average PER-EACH open-PO cost keyed by BASE-COLOR. Each PO's
// per-each cost is poUnitCost / poPackSize; the weighted average is by
// qty_open. Rows with a non-positive cost or qty are skipped.
export function buildPoEachCostByBaseColor(rows: PoCostRow[]): Map<string, number> {
  const acc = new Map<string, { num: number; den: number }>();
  for (const r of rows) {
    if (!POSITIVE(r.unit_cost)) continue;
    const qty = typeof r.qty_open === "number" ? r.qty_open : 0;
    if (!POSITIVE(qty)) continue;
    const packSize = POSITIVE(r.pack_size) ? r.pack_size : 1;
    const perEach = r.unit_cost / packSize;
    if (!POSITIVE(perEach)) continue;
    const key = baseColorKey(r.sku_code);
    if (!key) continue;
    const a = acc.get(key) ?? { num: 0, den: 0 };
    a.num += perEach * qty;
    a.den += qty;
    acc.set(key, a);
  }
  const out = new Map<string, number>();
  for (const [k, { num, den }] of acc) {
    if (den > 0) out.set(k, num / den);
  }
  return out;
}

// Re-grain a BASE-COLOR per-each cost to a specific grid row. Returns null
// when there is no PO cost for the row's base-color bucket.
export function poFallbackCostForRow(
  rowSku: string | null | undefined,
  rowPackSize: number | null | undefined,
  poEachByBaseColor: Map<string, number>,
): number | null {
  const key = baseColorKey(rowSku);
  if (!key) return null;
  const perEach = poEachByBaseColor.get(key);
  if (!POSITIVE(perEach)) return null;
  const packSize = POSITIVE(rowPackSize) ? rowPackSize : 1;
  return perEach * packSize;
}

// Precedence helper: a direct/sibling avg cost always wins; the PO
// fallback only fills when the avg cascade came up empty. Mirrors the
// service's `resolvedCost == null ? poFallback : resolvedCost` decision so
// the "PO ignored when an avg cost exists" rule is unit-testable.
export function resolvePlanningRowCost(
  avgCascadeCost: number | null,
  poFallbackCost: number | null,
): number | null {
  if (avgCascadeCost != null) return avgCascadeCost;
  return poFallbackCost ?? null;
}
