// ABC / XYZ classification per SKU.
//
// ABC = volume rank against the trailing window's total qty:
//   A → SKUs whose cumulative share ≤ 80% of the trailing total
//   B → next slice up to 95%
//   C → the long tail
//
// XYZ = demand variability — coefficient of variation across months:
//   X → CV ≤ 0.5  (stable)
//   Y → CV ≤ 1.0  (medium)
//   Z → CV  > 1.0 (volatile)
//
// SKUs with zero trailing demand fall into "CZ" by convention so they
// stay grouped at the bottom of any sort. Used to differentiate
// service-level targets and forecast-method selection in later phases;
// for now it's a display-only column / filter.
//
// All computation is from a flat sales history list — no DB hits — so
// this can run inside buildGridRows on every grid build.

import type { IpSalesWholesaleRow, IpIsoDate } from "../types/entities";

export type IpAbcClass = "A" | "B" | "C";
export type IpXyzClass = "X" | "Y" | "Z";

export interface IpAbcXyz {
  abc: IpAbcClass;
  xyz: IpXyzClass;
  total_qty: number;
  // Coefficient of variation across monthly buckets in the window.
  cv: number;
  // 1-12 buckets — how many months had non-zero demand. Helps the UI
  // distinguish "always sells, just lumpy" from "almost never sells".
  active_months: number;
}

export interface ClassifyOptions {
  // Window in months. Default 12.
  monthsBack: number;
  // Cumulative share thresholds for ABC. Defaults match the standard
  // Pareto split (80 / 15 / 5).
  abcA: number;
  abcB: number;
  // CV thresholds for XYZ. Defaults pick fashion-apparel reasonable
  // values; tier-1 systems often use 0.25 / 0.5.
  xyzX: number;
  xyzY: number;
}

const DEFAULT_OPTIONS: ClassifyOptions = {
  monthsBack: 12,
  abcA: 0.80,
  abcB: 0.95,
  xyzX: 0.5,
  xyzY: 1.0,
};

function monthBucket(iso: IpIsoDate): string {
  // YYYY-MM
  return iso.slice(0, 7);
}

function priorMonthBuckets(asOfIso: IpIsoDate, monthsBack: number): string[] {
  const out: string[] = [];
  const [yStr, mStr] = asOfIso.split("-");
  let y = Number(yStr);
  let m = Number(mStr);
  for (let i = 0; i < monthsBack; i++) {
    out.push(`${y.toString().padStart(4, "0")}-${m.toString().padStart(2, "0")}`);
    m -= 1;
    if (m < 1) { m = 12; y -= 1; }
  }
  return out;
}

function meanAndCv(values: number[]): { mean: number; cv: number } {
  if (values.length === 0) return { mean: 0, cv: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return { mean: 0, cv: 0 };
  const sq = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length;
  const stdev = Math.sqrt(sq);
  return { mean, cv: stdev / mean };
}

export function classifyAbcXyz(
  sales: Pick<IpSalesWholesaleRow, "sku_id" | "qty" | "txn_date">[],
  asOfIso: IpIsoDate,
  options: Partial<ClassifyOptions> = {},
): Map<string, IpAbcXyz> {
  const opts: ClassifyOptions = { ...DEFAULT_OPTIONS, ...options };
  const windowMonths = priorMonthBuckets(asOfIso, opts.monthsBack);
  const windowSet = new Set(windowMonths);

  // Per-SKU monthly qty, keyed by `${sku}:${YYYY-MM}`.
  const monthlyBySkuMonth = new Map<string, number>();
  const skuTotal = new Map<string, number>();
  for (const s of sales) {
    if (!s.sku_id || !s.txn_date) continue;
    const month = monthBucket(s.txn_date);
    if (!windowSet.has(month)) continue;
    const k = `${s.sku_id}:${month}`;
    monthlyBySkuMonth.set(k, (monthlyBySkuMonth.get(k) ?? 0) + (s.qty ?? 0));
    skuTotal.set(s.sku_id, (skuTotal.get(s.sku_id) ?? 0) + (s.qty ?? 0));
  }

  // ABC ranking: sort SKUs descending by total_qty, walk cumulative
  // share against the grand total. A SKU joins bucket X when the
  // cumulative share BEFORE it is still under bucket X's threshold —
  // so the SKU that pushes cumulative past the threshold is the last
  // member of that bucket. Standard Pareto interpretation; ensures a
  // single dominant SKU (e.g. 60% of total) lands in A even with a
  // tight 50% A threshold.
  const grandTotal = Array.from(skuTotal.values()).reduce((a, b) => a + b, 0);
  const ranked = Array.from(skuTotal.entries()).sort((a, b) => b[1] - a[1]);
  const abcBySku = new Map<string, IpAbcClass>();
  let cumBefore = 0;
  for (const [sku, qty] of ranked) {
    const prevShare = grandTotal > 0 ? cumBefore / grandTotal : 0;
    abcBySku.set(sku, prevShare < opts.abcA ? "A" : prevShare < opts.abcB ? "B" : "C");
    cumBefore += qty;
  }

  // XYZ + assemble result. SKUs with zero trailing demand → CZ.
  const out = new Map<string, IpAbcXyz>();
  for (const [sku, total_qty] of skuTotal) {
    const monthlyValues = windowMonths.map((m) => monthlyBySkuMonth.get(`${sku}:${m}`) ?? 0);
    const active_months = monthlyValues.filter((v) => v > 0).length;
    const { cv } = meanAndCv(monthlyValues);
    const xyz: IpXyzClass = cv <= opts.xyzX ? "X" : cv <= opts.xyzY ? "Y" : "Z";
    const abc = total_qty > 0 ? (abcBySku.get(sku) ?? "C") : "C";
    const finalXyz: IpXyzClass = total_qty > 0 ? xyz : "Z";
    out.set(sku, { abc, xyz: finalXyz, total_qty, cv, active_months });
  }
  return out;
}
