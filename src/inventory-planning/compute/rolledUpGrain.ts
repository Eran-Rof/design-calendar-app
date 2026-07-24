// One-line-per-style/colour collapse for wholesale planning (CEO, 2026-07-24).
//
// INVARIANT (CEO): the wholesale grid shows exactly ONE line per
// (customer, style, colour, period). Size is not a planning line — the PO module
// spreads a style/colour total across sizes at order time.
//
// The forecast build seeds a row per SKU, and a style/colour is held in
// ip_item_master as a rolled-up (size-NULL) SKU and/or many sized SKUs, with the
// family forecast number REPLICATED onto each size (verified: RYB1505 GRAYWOLF
// had 6 sizes all = 882; RYB1787 Black Sands = 195 on the rolled-up + 6×882 on
// the sizes). So one style/colour rendered as up to 7 identical lines. This
// collapses each (customer, style, colour) group to a single representative SKU:
//
//   • if the group has a rolled-up (size-NULL) SKU forecast, that wins (its value
//     is the style/colour-level number);
//   • otherwise the sized SKU with the greatest total forecast wins — and because
//     the sizes are replicated, that equals the family number (summing them would
//     over-count). Deterministic tiebreak so a rebuild is stable.
//
// Every non-representative row in the group is dropped. A group with a single SKU
// is untouched. Pure/deterministic so the build and the one-off data cleanup
// share exactly one rule.

export interface RolledUpItem {
  style_code?: string | null;
  sku_code?: string | null;
  color?: string | null;
  size?: string | null;
}

const norm = (s: string | null | undefined) => (s ?? "").trim();
const styleOf = (it: RolledUpItem) => norm(it.style_code) || norm(it.sku_code);
const isRolledUp = (it: RolledUpItem | undefined) => !!it && norm(it.size) === "";
const groupKey = (customerId: string, it: RolledUpItem) =>
  `${customerId}|${styleOf(it).toUpperCase()}|${norm(it.color).toUpperCase()}`;

/**
 * Collapse forecast rows to one representative SKU per (customer, style, colour).
 * `qtyOf` reads a row's forecast quantity (used to pick the representative and to
 * break ties deterministically). Rows whose SKU is missing from `itemBySku`, or
 * whose (customer, style, colour) group has only one SKU, are passed through.
 * Order-preserving; returns a new array.
 */
export function collapseToRolledUpGrain<T extends { customer_id: string; sku_id: string }>(
  rows: T[],
  itemBySku: Map<string, RolledUpItem>,
  qtyOf: (row: T) => number = () => 0,
): T[] {
  // Per (customer, style, colour) group, gather each SKU's total qty + whether
  // it is the rolled-up SKU, so we can choose one representative per group.
  interface SkuAgg { skuId: string; total: number; rolledUp: boolean; }
  const groups = new Map<string, Map<string, SkuAgg>>();
  for (const r of rows) {
    const it = itemBySku.get(r.sku_id);
    if (!it) continue;                       // unclassifiable SKU — never collapsed
    const gk = groupKey(r.customer_id, it);
    let byS = groups.get(gk);
    if (!byS) { byS = new Map(); groups.set(gk, byS); }
    let agg = byS.get(r.sku_id);
    if (!agg) { agg = { skuId: r.sku_id, total: 0, rolledUp: isRolledUp(it) }; byS.set(r.sku_id, agg); }
    agg.total += qtyOf(r);
  }

  // Choose the winning SKU per group (only groups with 2+ SKUs need a choice).
  const winnerBySku = new Map<string, string>(); // gk → winning sku_id
  for (const [gk, byS] of groups) {
    if (byS.size < 2) continue;
    const rolled = [...byS.values()].filter((a) => a.rolledUp);
    const pool = rolled.length ? rolled : [...byS.values()];
    // Highest total wins; ties → lowest sku_id, so the pick is stable across runs.
    pool.sort((a, b) => b.total - a.total || (a.skuId < b.skuId ? -1 : a.skuId > b.skuId ? 1 : 0));
    winnerBySku.set(gk, pool[0].skuId);
  }
  if (winnerBySku.size === 0) return rows.slice();

  return rows.filter((r) => {
    const it = itemBySku.get(r.sku_id);
    if (!it) return true;                    // unclassifiable — keep
    const winner = winnerBySku.get(groupKey(r.customer_id, it));
    if (winner === undefined) return true;   // single-SKU group — keep
    return r.sku_id === winner;              // multi-SKU group — keep only the representative
  });
}
