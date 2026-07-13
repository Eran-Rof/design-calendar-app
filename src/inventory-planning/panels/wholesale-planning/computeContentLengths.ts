// Pure row-scan that measures the longest displayed string per column.
// Output feeds computeColumnWidth (in this same folder) which turns
// the max char-count into a px width with CAP/FLOOR clamping.
//
// Extracted from the dynamicColWidths useMemo in
// WholesalePlanningGrid.tsx so the per-render loop is testable AND
// new columns can opt in by adding one line here + one entry in
// columns.ts.

import type { IpPlanningGridRow } from "../../types/wholesale";
import { formatQty, METHOD_LABEL, formatPeriodCode } from "../../components/styles";
import { COLUMN_LABEL } from "./columns";

const DASH = "—";

const numFmt = (v: number | null | undefined): string => (v == null ? DASH : formatQty(v));
const moneyFmt = (v: number | null | undefined): string => (v == null ? DASH : `$${v.toFixed(2)}`);
const pctFmt = (v: number | null | undefined): string => (v == null ? DASH : `${(v * 100).toFixed(1)}%`);

/**
 * Returns the max content length (in chars) per column key, seeded
 * with the header label length (+1 for the sort-arrow glyph). The
 * caller passes the result to `computeColumnWidth(key, len)` to get
 * the final px width.
 */
export function computeContentLengths(rows: IpPlanningGridRow[]): Record<string, number> {
  const lenByCol: Record<string, number> = {};
  // +1 reserves room for the sort-arrow glyph the header renders next to its label.
  for (const k of Object.keys(COLUMN_LABEL)) lenByCol[k] = COLUMN_LABEL[k].length + 1;

  const set = (k: string, t: string | null | undefined) => {
    const len = (t ?? DASH).length;
    if (len > lenByCol[k]) lenByCol[k] = len;
  };

  // Planner-added TBD rows render extra controls in the Customer cell —
  // the customer picker's ▾ plus an "Add to DB" (or "✓ in DB") button and a
  // ✕ delete button. None of that is in customer_name, so without a reserve
  // the column sizes to the name alone and the buttons overflow into Period.
  const CUSTOMER_CONTROLS_CHARS = 16;

  for (const r of rows) {
    set("category",    r.group_name);
    set("subCat",      r.sub_category_name);
    set("style",       r.sku_style ?? r.sku_code);
    set("description", r.sku_description);
    set("color",       r.sku_color);
    set("inseam",      r.sku_inseam ?? null);
    if (r.is_tbd && r.is_user_added && !r.is_aggregate) {
      const l = (r.customer_name ?? DASH).length + CUSTOMER_CONTROLS_CHARS;
      if (l > lenByCol.customer) lenByCol.customer = l;
    } else {
      set("customer", r.customer_name);
    }
    set("period",      formatPeriodCode(r.period_code));
    set("class",       `${r.abc_class ?? ""}${r.xyz_class ?? ""}`);
    set("histT3",      numFmt(r.historical_trailing_qty));
    set("histLY",      numFmt(r.ly_reference_qty));
    set("margin",      pctFmt(r.historical_margin_pct));
    set("system",      numFmt(r.system_forecast_qty));
    set("buyer",       numFmt(r.buyer_request_qty));
    set("override",    numFmt(r.override_qty));
    set("final",       numFmt(r.final_forecast_qty));
    set("confidence",  r.confidence_level);
    set("method",      METHOD_LABEL[r.forecast_method] ?? r.forecast_method);
    set("onHand",      numFmt(r.on_hand_qty));
    set("onSo",        numFmt(r.on_so_qty));
    set("receipts",    numFmt(r.receipts_due_qty));
    set("histRecv",    numFmt(r.historical_receipts_qty));
    set("ats",         numFmt(r.available_supply_qty));
    set("buy",         numFmt(r.planned_buy_qty));
    set("avgCost",     moneyFmt(r.avg_cost));
    set("unitCost",    moneyFmt(r.unit_cost));
    set("buyDollars",  moneyFmt((r.planned_buy_qty ?? 0) * (r.unit_cost ?? 0)));
    set("shortage",    numFmt(r.projected_shortage_qty));
    set("excess",      numFmt(r.projected_excess_qty));
    set("action",      r.recommended_action);
  }
  return lenByCol;
}
