// Pure aggregation of the displayed rows for the totals strip + the
// action / method count chips. Extracted from WholesalePlanningGrid
// so the math is testable and the render closure doesn't carry a
// 15-line useMemo body.
//
// Shape mirrors the original inline object exactly so the call site
// can drop straight in (`const totals = computeTotals(mutedRows, skuPeriodMath)`).

import type { IpPlanningGridRow } from "../../types/wholesale";

export interface GridTotals {
  /** Σ final_forecast_qty across the (already muted) display rows. */
  final: number;
  /** Σ shortage across unique (sku, period) groups from skuPeriodMath. */
  shortage: number;
  /** Σ excess across unique (sku, period) groups from skuPeriodMath. */
  excess: number;
  /** Count of rows per recommended_action — fuels the action chip strip. */
  actions: Record<string, number>;
  /** Count of rows per forecast_method — fuels the method chip strip. */
  methods: Record<string, number>;
}

// Per-(sku, period) supply math the grid pre-computes — same Map as
// the call site passes in. We only read excess + shortage off the
// values; other fields exist on the real type but we don't depend on
// them, so the local shape stays narrow.
interface SkuPeriodMathLike {
  excess: number;
  shortage: number;
}

export function computeTotals(
  rows: IpPlanningGridRow[],
  skuPeriodMath: Map<string, SkuPeriodMathLike>,
): GridTotals {
  const t: GridTotals = { final: 0, shortage: 0, excess: 0, actions: {}, methods: {} };
  for (const r of rows) {
    t.final += r.final_forecast_qty;
    t.actions[r.recommended_action] = (t.actions[r.recommended_action] ?? 0) + 1;
    t.methods[r.forecast_method]    = (t.methods[r.forecast_method]    ?? 0) + 1;
  }
  // Σ Excess / Σ Shortage = sum across unique (sku, period) grains
  // from the pre-computed rolling-pool map. Single source of truth
  // shared with per-row display.
  for (const { excess, shortage } of skuPeriodMath.values()) {
    t.excess   += excess;
    t.shortage += shortage;
  }
  return t;
}
