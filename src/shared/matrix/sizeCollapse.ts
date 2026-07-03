// src/shared/matrix/sizeCollapse.ts
//
// Shared size-column collapse model — the "SO grid" behavior: once any size
// column carries a quantity, the leading and trailing all-zero size columns can
// be hidden (collapsed) so the grid shows only the range actually in play, and
// the first VISIBLE size column is highlighted green + made clickable to toggle.
//
// Extracted as a pure helper so every size matrix (the editable SO / PO entry
// grid via EditableSizeMatrix AND the read-only Inventory Matrix) computes the
// identical visible range from the same code — guaranteeing they collapse the
// same way and show the same green first column.

export type SizeCollapseModel = {
  /** The size columns to actually render (collapsed range, or all sizes). */
  visibleSizes: string[];
  /** Any size column carries a non-zero total (drives the green highlight). */
  hasQty: boolean;
  /** Index of the first / last size column with a non-zero total (−1 = none). */
  firstIdx: number;
  lastIdx: number;
  /** There ARE leading/trailing empty columns that collapsing would hide. */
  canCollapse: boolean;
  /** Collapse is currently applied (visibleSizes is the narrowed range). */
  collapsedActive: boolean;
  /** The first size column should be clickable to toggle collapse. */
  canToggle: boolean;
  /** How many leading / trailing columns are hidden while collapsed (for the ⋯). */
  hiddenLeading: number;
  hiddenTrailing: number;
};

/**
 * Compute the collapse view model for a size axis.
 *
 * @param sizes     Size columns in scale order.
 * @param colTotals Per-size total quantity (key = size). Missing = 0.
 * @param opts      `enabled` gates the whole behavior (opt-in); `collapsed` is
 *                  the current toggle state owned by the caller.
 */
export function computeSizeCollapse(
  sizes: string[],
  colTotals: Record<string, number>,
  opts: { enabled: boolean; collapsed: boolean },
): SizeCollapseModel {
  const { enabled, collapsed } = opts;
  let grand = 0;
  let firstIdx = -1;
  let lastIdx = -1;
  for (let i = 0; i < sizes.length; i++) {
    const q = colTotals[sizes[i]] || 0;
    grand += q;
    if (q > 0) { if (firstIdx < 0) firstIdx = i; lastIdx = i; }
  }
  const hasQty = grand > 0;
  const canCollapse = enabled && hasQty && firstIdx >= 0 && (firstIdx > 0 || lastIdx < sizes.length - 1);
  const collapsedActive = enabled && collapsed && firstIdx >= 0;
  const visibleSizes = collapsedActive ? sizes.slice(firstIdx, lastIdx + 1) : sizes;
  const canToggle = enabled && (collapsedActive || canCollapse);
  const hiddenLeading = collapsedActive ? firstIdx : 0;
  const hiddenTrailing = collapsedActive ? sizes.length - 1 - lastIdx : 0;
  return { visibleSizes, hasQty, firstIdx, lastIdx, canCollapse, collapsedActive, canToggle, hiddenLeading, hiddenTrailing };
}
