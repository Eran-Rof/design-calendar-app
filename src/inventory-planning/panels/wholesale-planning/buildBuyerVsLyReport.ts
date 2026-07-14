// Pure builder for the "Buyer vs Last Year" grid report. Pivots planning rows
// into per-customer → per-style → per-color tables across the run's periods,
// with two quantity blocks — SP/LY (ly_reference_qty, "same period last year")
// and TY/Buyer (buyer_request_qty, this year) — plus a comparison the view /
// exports derive (Comp = TY − LY, % = Comp / LY).
//
// Side-effect free so the pivot is unit-tested; the modal + PDF/Excel exporters
// consume the returned shape.

import type { IpPlanningGridRow } from "../../types/wholesale";

export interface ReportPeriod {
  period_code: string;   // "2027-01"
  tyLabel: string;       // "Jan-27"
  lyLabel: string;       // "Jan-26"
}

export interface ReportColorRow {
  style: string;
  color: string;
  ly: number[];          // SP/LY qty per period (index-aligned to periods)
  ty: number[];          // TY/Buyer qty per period
  lyTotal: number;
  tyTotal: number;
}

export interface ReportStyle {
  style: string;
  colors: ReportColorRow[];
  lyTotals: number[];
  tyTotals: number[];
  lyTotal: number;
  tyTotal: number;
}

export interface ReportCustomer {
  customer: string;
  styles: ReportStyle[];
  lyTotals: number[];    // customer totals per period
  tyTotals: number[];
  lyTotal: number;
  tyTotal: number;
}

export interface BuyerVsLyReport {
  periods: ReportPeriod[];
  customers: ReportCustomer[];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function labelFor(periodCode: string, yearDelta: number): string {
  const [y, m] = periodCode.split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return periodCode;
  const yy = String(((y + yearDelta) % 100 + 100) % 100).padStart(2, "0");
  return `${MONTHS[m - 1]}-${yy}`;
}

const sumArr = (a: number[]): number => a.reduce((s, v) => s + v, 0);
const addInto = (target: number[], idx: number, v: number | null | undefined): void => {
  if (idx >= 0) target[idx] += v ?? 0;
};

/** Drop rows where BOTH the SP/LY and TY/Buyer totals are zero — a color row
 *  with nothing last year and nothing planned this year. Styles left with no
 *  colors, and customers left with no styles, drop too. Totals are unchanged
 *  (removed rows contributed 0 to every period). Pure — used by the report's
 *  "hide zero rows" toggle so the view AND its PDF/Excel exports stay in sync. */
export function filterOutZeroReportRows(report: BuyerVsLyReport): BuyerVsLyReport {
  const customers = report.customers
    .map((cust) => {
      const styles = cust.styles
        .map((sty) => ({ ...sty, colors: sty.colors.filter((c) => c.lyTotal !== 0 || c.tyTotal !== 0) }))
        .filter((sty) => sty.colors.length > 0);
      return { ...cust, styles };
    })
    .filter((cust) => cust.styles.length > 0);
  return { periods: report.periods, customers };
}

/** Comparison helpers shared by the view + exports. */
export function reportComp(ty: number, ly: number): number { return ty - ly; }
export function reportPct(ty: number, ly: number): number | null {
  if (ly !== 0) return (ty - ly) / ly;
  if (ty === 0) return null;      // 0 vs 0 → no meaningful %
  return 1;                        // brand-new (no LY) → +100%
}

/**
 * Build the report from planning rows (already scoped to whatever the caller
 * wants — full run or the current grid filter). Aggregate rows are skipped;
 * every leaf row contributes its ly_reference_qty (SP/LY) and buyer_request_qty
 * (TY) to its (customer, style, color, period) cell.
 */
export function buildBuyerVsLyReport(rows: IpPlanningGridRow[]): BuyerVsLyReport {
  const periodSet = new Set<string>();
  for (const r of rows) if (!r.is_aggregate && r.period_code) periodSet.add(r.period_code);
  const periodCodes = Array.from(periodSet).sort();
  const periodIdx = new Map(periodCodes.map((p, i) => [p, i] as const));
  const nP = periodCodes.length;
  const periods: ReportPeriod[] = periodCodes.map((p) => ({
    period_code: p, tyLabel: labelFor(p, 0), lyLabel: labelFor(p, -1),
  }));

  // customer → style → color → { ly[], ty[] }
  type Cell = { ly: number[]; ty: number[] };
  const custMap = new Map<string, Map<string, Map<string, Cell>>>();
  for (const r of rows) {
    if (r.is_aggregate || !r.period_code) continue;
    const idx = periodIdx.get(r.period_code) ?? -1;
    if (idx < 0) continue;
    const customer = r.customer_name || "(no customer)";
    const style = r.sku_style ?? r.sku_code ?? "(no style)";
    const color = r.sku_color ?? "(no color)";
    let styleMap = custMap.get(customer);
    if (!styleMap) { styleMap = new Map(); custMap.set(customer, styleMap); }
    let colorMap = styleMap.get(style);
    if (!colorMap) { colorMap = new Map(); styleMap.set(style, colorMap); }
    let cell = colorMap.get(color);
    if (!cell) { cell = { ly: new Array(nP).fill(0), ty: new Array(nP).fill(0) }; colorMap.set(color, cell); }
    addInto(cell.ly, idx, r.ly_reference_qty);
    addInto(cell.ty, idx, r.buyer_request_qty);
  }

  const customers: ReportCustomer[] = Array.from(custMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([customer, styleMap]) => {
      const custLy = new Array(nP).fill(0);
      const custTy = new Array(nP).fill(0);
      const styles: ReportStyle[] = Array.from(styleMap.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([style, colorMap]) => {
          const styLy = new Array(nP).fill(0);
          const styTy = new Array(nP).fill(0);
          const colors: ReportColorRow[] = Array.from(colorMap.entries())
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([color, cell]) => {
              for (let i = 0; i < nP; i++) { styLy[i] += cell.ly[i]; styTy[i] += cell.ty[i]; }
              return { style, color, ly: cell.ly, ty: cell.ty, lyTotal: sumArr(cell.ly), tyTotal: sumArr(cell.ty) };
            });
          for (let i = 0; i < nP; i++) { custLy[i] += styLy[i]; custTy[i] += styTy[i]; }
          return { style, colors, lyTotals: styLy, tyTotals: styTy, lyTotal: sumArr(styLy), tyTotal: sumArr(styTy) };
        });
      return { customer, styles, lyTotals: custLy, tyTotals: custTy, lyTotal: sumArr(custLy), tyTotal: sumArr(custTy) };
    });

  return { periods, customers };
}
