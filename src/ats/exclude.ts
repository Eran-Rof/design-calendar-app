// Exclusion ("X" column) helpers.
//
// A row is excluded when its SKU is in the operator-managed excluded set
// (toggled via the grid's "X" checkbox). Excluded rows stay VISIBLE in the
// grid (greyed) but drop out of every aggregation, total, and report. These
// two pure helpers centralize that split so the half-dozen call sites in
// ATS.tsx stay consistent.

import type { ATSRow } from "./types";

/** Rows that COUNT — the input minus any excluded SKUs. Returns the input
 *  array unchanged (same reference) when nothing is excluded, so callers
 *  that memoize on it don't churn. */
export function excludeRows(rows: ATSRow[], excluded: ReadonlySet<string>): ATSRow[] {
  if (excluded.size === 0) return rows;
  return rows.filter(r => !excluded.has(r.sku));
}

/** The excluded rows only — drives the pre-report warning list. Empty when
 *  nothing is excluded. */
export function onlyExcluded(rows: ATSRow[], excluded: ReadonlySet<string>): ATSRow[] {
  if (excluded.size === 0) return [];
  return rows.filter(r => excluded.has(r.sku));
}
