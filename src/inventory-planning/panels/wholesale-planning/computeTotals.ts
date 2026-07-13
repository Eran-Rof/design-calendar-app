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
  /** Per-column sums for the optional column-totals header row, keyed by the
   *  Th column key. Demand/buy columns sum per row; supply columns are deduped
   *  per (sku, period) so a SKU shared across customers isn't multiplied. */
  columns: Record<string, number>;
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
  const t: GridTotals = { final: 0, shortage: 0, excess: 0, actions: {}, methods: {}, columns: {} };
  const c = t.columns;
  const add = (k: string, v: number | null | undefined) => { c[k] = (c[k] ?? 0) + (v ?? 0); };
  const seenSupply = new Set<string>(); // (sku, period) — supply is per-grain, not per-row
  for (const r of rows) {
    t.final += r.final_forecast_qty;
    t.actions[r.recommended_action] = (t.actions[r.recommended_action] ?? 0) + 1;
    t.methods[r.forecast_method]    = (t.methods[r.forecast_method]    ?? 0) + 1;
    // Demand + buy — genuinely per (customer, sku, period) row, so summing is right.
    add("histT3", r.historical_trailing_qty);
    add("histLY", r.ly_reference_qty);
    add("system", r.system_forecast_qty);
    add("buyer", r.buyer_request_qty);
    add("override", r.override_qty);
    add("final", r.final_forecast_qty);
    add("buy", r.planned_buy_qty);
    add("buyDollars", (r.planned_buy_qty ?? 0) * (r.unit_cost ?? 0));
    // Supply columns are per (sku, period) — count each grain once so a SKU
    // shared across several customer rows isn't multiplied.
    const sp = `${r.sku_id}:${r.period_code}`;
    if (!seenSupply.has(sp)) {
      seenSupply.add(sp);
      add("onHand", r.on_hand_qty);
      add("onSo", r.on_so_qty);
      add("receipts", r.receipts_due_qty);
      add("histRecv", r.historical_receipts_qty);
      add("ats", r.available_supply_qty);
    }
  }
  // Σ Excess / Σ Shortage = sum across unique (sku, period) grains
  // from the pre-computed rolling-pool map. Single source of truth
  // shared with per-row display.
  for (const { excess, shortage } of skuPeriodMath.values()) {
    t.excess   += excess;
    t.shortage += shortage;
  }
  c.shortage = t.shortage;
  c.excess = t.excess;
  return t;
}
