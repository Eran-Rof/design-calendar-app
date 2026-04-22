// api/_lib/benchmark.js
//
// Pure helpers for the monthly benchmark_data compute job.
//
//   percentile(sorted, p)     → linear-interpolated percentile of a pre-sorted array
//   percentiles(values)       → { p25, p50, p75, p90, n } from any array of numbers
//   priorMonthRange(now)      → { period_start, period_end } ISO date strings for the
//                               full calendar month before `now` (UTC)
//   MIN_VENDORS_FOR_PUBLISH   → 5; skip publishing when fewer than this many distinct
//                               vendors contributed to a (category, metric) bucket
//
//   aggregateByCategory(rows, { valueField, vendorField, categoryField, minPositive })
//     → { [category]: { values: number[], vendorIds: Set<string> } }
//
// `aggregateByCategory` filters rows that have null/zero/NaN values (unless minPositive=false),
// keeps the latest unique (vendor, value) pair for dedup, and groups by category.

export const MIN_VENDORS_FOR_PUBLISH = 5;

export function percentile(sorted, p) {
  if (!sorted || sorted.length === 0) return null;
  if (sorted.length === 1) return Number(sorted[0]);
  const rank = p * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return Number(sorted[lo]);
  const frac = rank - lo;
  return Number(sorted[lo]) + frac * (Number(sorted[hi]) - Number(sorted[lo]));
}

export function percentiles(values) {
  const cleaned = (values || [])
    .filter((v) => v !== null && v !== undefined && v !== "")
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n));
  if (cleaned.length === 0) return { p25: null, p50: null, p75: null, p90: null, n: 0 };
  cleaned.sort((a, b) => a - b);
  return {
    p25: percentile(cleaned, 0.25),
    p50: percentile(cleaned, 0.50),
    p75: percentile(cleaned, 0.75),
    p90: percentile(cleaned, 0.90),
    n: cleaned.length,
  };
}

export function priorMonthRange(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const end   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(),     0)); // day 0 of current month = last day of prior
  const toDate = (d) => d.toISOString().slice(0, 10);
  return { period_start: toDate(start), period_end: toDate(end) };
}

export function aggregateByCategory(rows, {
  valueField = "unit_price",
  vendorField = "vendor_id",
  categoryField = "category",
  minPositive = true,
} = {}) {
  const out = {};
  for (const r of rows || []) {
    const cat = r?.[categoryField];
    const val = Number(r?.[valueField]);
    const vId = r?.[vendorField];
    if (!cat || !vId) continue;
    if (!Number.isFinite(val)) continue;
    if (minPositive && val <= 0) continue;
    const b = (out[cat] ||= { values: [], vendorIds: new Set() });
    b.values.push(val);
    b.vendorIds.add(vId);
  }
  return out;
}
