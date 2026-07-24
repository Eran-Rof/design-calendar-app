// Rolled-up grain collapse for wholesale planning (CEO decision, 2026-07-24).
//
// A style/colour can exist in ip_item_master as BOTH a rolled-up (size-NULL)
// SKU and several sized SKUs. The forecast build was emitting a row for the
// rolled-up AND for every size — with the family number replicated onto each
// size, not split — so one style/colour/customer/period rendered as 7 lines
// (RYB1787 Black Sands: 195 on the rolled-up + 6×882 on the sizes). That both
// inflated demand and cluttered the grid.
//
// The CEO chose "rolled-up only": plan at style/colour grain, where 100% of the
// sales history actually sits today; the size split happens at PO via a size
// curve. So whenever a (customer, style, colour) is forecast on its rolled-up
// (size-NULL) SKU, the sized siblings' rows are dropped. A (customer, style,
// colour) that has NO rolled-up row (the ~1,012 size-only groups) keeps its
// sized rows untouched — dropping them would leave it with no forecast at all.
//
// Pure and deterministic so it can be unit-tested and applied identically in the
// build (here) and in the one-off data cleanup of existing runs.

export interface RolledUpItem {
  style_code?: string | null;
  sku_code?: string | null;
  color?: string | null;
  size?: string | null;
}

const norm = (s: string | null | undefined) => (s ?? "").trim();
// Style identity mirrors the build elsewhere: style_code, or sku_code when a SKU
// has no style. Upper-cased so casing never splits a group.
const styleOf = (it: RolledUpItem) => norm(it.style_code) || norm(it.sku_code);
const isRolledUp = (it: RolledUpItem | undefined) => !!it && norm(it.size) === "";
const groupKey = (customerId: string, it: RolledUpItem) =>
  `${customerId}|${styleOf(it).toUpperCase()}|${norm(it.color).toUpperCase()}`;

/**
 * Drop sized-SKU rows whose (customer, style, colour) also has a rolled-up
 * (size-NULL) row. Rows for SKUs missing from `itemBySku` are kept (can't
 * classify them), as are all rolled-up rows and every row of a group that has no
 * rolled-up sibling. Order-preserving; returns a new array.
 */
export function collapseToRolledUpGrain<T extends { customer_id: string; sku_id: string }>(
  rows: T[],
  itemBySku: Map<string, RolledUpItem>,
): T[] {
  const rolledUpGroups = new Set<string>();
  for (const r of rows) {
    const it = itemBySku.get(r.sku_id);
    if (it && isRolledUp(it)) rolledUpGroups.add(groupKey(r.customer_id, it));
  }
  if (rolledUpGroups.size === 0) return rows.slice();
  return rows.filter((r) => {
    const it = itemBySku.get(r.sku_id);
    if (!it) return true;               // unknown SKU — keep, can't classify
    if (isRolledUp(it)) return true;    // the rolled-up row itself — keep
    return !rolledUpGroups.has(groupKey(r.customer_id, it)); // sized — drop iff a rolled-up sibling exists
  });
}
