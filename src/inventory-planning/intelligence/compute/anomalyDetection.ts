// Anomaly detection — deterministic, rule-based. Every anomaly carries
// a human-readable message + a details_json with the triggering numbers.
//
// Thresholds live as exported constants so reviewers can argue with
// them. A Phase 6 upgrade could replace any one of these with a learned
// threshold per category / lane without changing the rule shape.
//
// Inputs come from:
//   • ip_forecast_accuracy   (system/final/actual + pre-computed errors)
//   • ip_sales_history_*     (for spike/collapse baselines)
//   • ip_ecom_forecast       (for return_rate + protected coverage tests)
//   • ip_projected_inventory (for stockout streaks)

import type {
  IpAnomalyType,
  IpAnomalySeverity,
  IpPlanningAnomaly,
} from "../types/intelligence";
import type { IpForecastAccuracy } from "../../accuracy/types/accuracy";

export const SPIKE_MULTIPLIER       = 2.0;   // actual ≥ 2× trailing avg → spike
export const COLLAPSE_MULTIPLIER    = 0.25;  // actual ≤ 25% of trailing avg → collapse
export const REPEATED_MISS_PCT      = 0.25;  // >25% error
export const REPEATED_MISS_STREAK   = 3;     // 3 periods in a row
export const CHRONIC_OVERBUY_STREAK = 3;     // 3 periods in a row with bias > 25% of actual
export const CHRONIC_STOCKOUT_STREAK = 3;    // 3 periods flagged stockout
export const RETURN_RATE_SPIKE      = 0.4;   // return_rate jumps above 40%
export const VOLATILITY_CV          = 1.0;   // coefficient of variation > 1.0 → volatile

export interface AnomalyContext {
  // A per-sku running trail of last N actuals keyed by sku_id → array
  // newest-last. Used to detect spike/collapse.
  actualsBySku: Map<string, number[]>;
  // Accuracy rows keyed by sku_id → newest-last (any forecast_type).
  accuracyBySku: Map<string, IpForecastAccuracy[]>;
  // Projected stockout flags keyed by sku → newest-last booleans.
  stockoutsBySku: Map<string, boolean[]>;
  // Ecom return rate series by sku_id → newest-last.
  returnRateBySku: Map<string, number[]>;
  // Protected ecom uncovered flags by sku_id → newest-last booleans.
  protectedUncoveredBySku: Map<string, boolean[]>;
  // Optional — planning_run_id used when persisting the rows.
  planning_run_id?: string | null;
}

type Out = Omit<IpPlanningAnomaly, "id" | "created_at">;

function build(
  forecastType: IpForecastAccuracy["forecast_type"] | null,
  sku_id: string,
  period_start: string,
  period_end: string,
  period_code: string,
  type: IpAnomalyType,
  severity: IpAnomalySeverity,
  confidence: number,
  message: string,
  details: Record<string, unknown>,
  planning_run_id: string | null = null,
): Out {
  return {
    planning_run_id,
    scenario_id: null,
    forecast_type: forecastType,
    sku_id,
    customer_id: null,
    channel_id: null,
    category_id: null,
    period_start,
    period_end,
    period_code,
    anomaly_type: type,
    severity,
    confidence_score: confidence,
    message,
    details_json: details,
  };
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length;
  return Math.sqrt(v);
}

// ── Individual detectors ───────────────────────────────────────────────────
export function detectDemandAnomalies(
  row: IpForecastAccuracy,
  actualsTrail: number[], // newest actual NOT included
  planning_run_id: string | null = null,
): Out[] {
  const out: Out[] = [];
  if (actualsTrail.length < 3) return out;
  const avg = mean(actualsTrail);
  const a = row.actual_qty;
  if (avg <= 0) return out;

  if (a >= SPIKE_MULTIPLIER * avg && a > 0) {
    out.push(build(
      row.forecast_type, row.sku_id, row.period_start, row.period_end, row.period_code,
      "demand_spike",
      a >= 3 * avg ? "high" : "medium",
      Math.min(1, (a / avg - SPIKE_MULTIPLIER) / SPIKE_MULTIPLIER + 0.6),
      `Demand ${Math.round(a)} is ${(a / avg).toFixed(1)}× the trailing avg (${Math.round(avg)}).`,
      { actual: a, trailing_avg: avg, ratio: a / avg },
      planning_run_id,
    ));
  }
  if (a <= COLLAPSE_MULTIPLIER * avg) {
    out.push(build(
      row.forecast_type, row.sku_id, row.period_start, row.period_end, row.period_code,
      "demand_collapse",
      a === 0 && avg > 10 ? "high" : "medium",
      Math.min(1, (1 - a / Math.max(avg, 1)) * 0.9 + 0.1),
      `Demand ${Math.round(a)} is only ${(100 * a / avg).toFixed(0)}% of trailing avg (${Math.round(avg)}).`,
      { actual: a, trailing_avg: avg, ratio: a / avg },
      planning_run_id,
    ));
  }
  return out;
}

export function detectRepeatedForecastMiss(
  accuracyTrail: IpForecastAccuracy[], // newest last, ≥ REPEATED_MISS_STREAK rows
  planning_run_id: string | null = null,
): Out[] {
  if (accuracyTrail.length < REPEATED_MISS_STREAK) return [];
  const recent = accuracyTrail.slice(-REPEATED_MISS_STREAK);
  const allMissed = recent.every((r) =>
    r.pct_error_final != null && Math.abs(r.pct_error_final) > REPEATED_MISS_PCT,
  );
  if (!allMissed) return [];
  const latest = recent[recent.length - 1];
  return [build(
    latest.forecast_type, latest.sku_id, latest.period_start, latest.period_end, latest.period_code,
    "repeated_forecast_miss",
    "high",
    0.85,
    `Final forecast has missed by > ${(REPEATED_MISS_PCT * 100).toFixed(0)}% for ${REPEATED_MISS_STREAK} periods in a row.`,
    {
      streak: REPEATED_MISS_STREAK,
      pct_errors: recent.map((r) => r.pct_error_final),
    },
    planning_run_id,
  )];
}

export function detectChronicOverbuy(
  accuracyTrail: IpForecastAccuracy[],
  planning_run_id: string | null = null,
): Out[] {
  if (accuracyTrail.length < CHRONIC_OVERBUY_STREAK) return [];
  const recent = accuracyTrail.slice(-CHRONIC_OVERBUY_STREAK);
  const allOver = recent.every((r) => {
    const denom = Math.max(r.actual_qty, 1);
    return r.bias_final > 0 && r.bias_final / denom > 0.25;
  });
  if (!allOver) return [];
  const latest = recent[recent.length - 1];
  return [build(
    latest.forecast_type, latest.sku_id, latest.period_start, latest.period_end, latest.period_code,
    "chronic_overbuy",
    "medium",
    0.8,
    `Final forecast has run hotter than actual by > 25% for ${CHRONIC_OVERBUY_STREAK} periods in a row.`,
    { biases: recent.map((r) => r.bias_final) },
    planning_run_id,
  )];
}

export function detectChronicStockout(
  sku_id: string,
  stockoutsTrail: boolean[],
  period_start: string,
  period_end: string,
  period_code: string,
  planning_run_id: string | null = null,
): Out[] {
  if (stockoutsTrail.length < CHRONIC_STOCKOUT_STREAK) return [];
  const recent = stockoutsTrail.slice(-CHRONIC_STOCKOUT_STREAK);
  if (!recent.every(Boolean)) return [];
  return [build(
    null, sku_id, period_start, period_end, period_code,
    "chronic_stockout",
    "high",
    0.9,
    `SKU has been in projected stockout for ${CHRONIC_STOCKOUT_STREAK} periods in a row.`,
    { streak: CHRONIC_STOCKOUT_STREAK },
    planning_run_id,
  )];
}

export function detectReturnRateSpike(
  sku_id: string,
  returnRateTrail: number[], // newest last
  period_start: string,
  period_end: string,
  period_code: string,
  planning_run_id: string | null = null,
): Out[] {
  if (returnRateTrail.length === 0) return [];
  const latest = returnRateTrail[returnRateTrail.length - 1];
  if (latest < RETURN_RATE_SPIKE) return [];
  const baseline = returnRateTrail.length > 1
    ? mean(returnRateTrail.slice(0, -1))
    : 0;
  return [build(
    "ecom", sku_id, period_start, period_end, period_code,
    "return_rate_spike",
    latest >= 0.6 ? "high" : "medium",
    Math.min(1, latest),
    `Return rate ${(latest * 100).toFixed(0)}% (baseline ${(baseline * 100).toFixed(0)}%).`,
    { latest, baseline },
    planning_run_id,
  )];
}

export function detectProtectedRepeatedlyUncovered(
  sku_id: string,
  uncoveredTrail: boolean[],
  period_start: string,
  period_end: string,
  period_code: string,
  planning_run_id: string | null = null,
): Out[] {
  if (uncoveredTrail.length < 3) return [];
  const recent = uncoveredTrail.slice(-3);
  if (!recent.every(Boolean)) return [];
  return [build(
    "ecom", sku_id, period_start, period_end, period_code,
    "protected_repeatedly_uncovered",
    "high",
    0.85,
    "Protected ecom demand has been short 3 periods in a row.",
    { streak: 3 },
    planning_run_id,
  )];
}

export function detectForecastVolatility(
  accuracyTrail: IpForecastAccuracy[],
  planning_run_id: string | null = null,
): Out[] {
  if (accuracyTrail.length < 6) return [];
  const recent = accuracyTrail.slice(-6).map((r) => r.final_forecast_qty);
  const m = mean(recent);
  if (m <= 0) return [];
  const cv = stdev(recent) / m;
  if (cv < VOLATILITY_CV) return [];
  const latest = accuracyTrail[accuracyTrail.length - 1];
  return [build(
    latest.forecast_type, latest.sku_id, latest.period_start, latest.period_end, latest.period_code,
    "forecast_volatility",
    "medium",
    Math.min(1, cv / 2),
    `Final forecast varies wildly (CV=${cv.toFixed(2)}) — planner may be whipsawing.`,
    { series: recent, cv },
    planning_run_id,
  )];
}

export function detectBuyerRequestConversionMiss(
  row: IpForecastAccuracy & { buyer_request_qty?: number },
  planning_run_id: string | null = null,
): Out[] {
  // If a buyer requested N units, the final landed close to that (the
  // override was taken), but actuals fell far short → the buyer's
  // request was overstated and we should review.
  const requested = row.buyer_request_qty ?? 0;
  if (requested <= 0) return [];
  if (row.actual_qty >= 0.6 * requested) return [];
  return [build(
    row.forecast_type, row.sku_id, row.period_start, row.period_end, row.period_code,
    "buyer_request_conversion_miss",
    "medium",
    0.7,
    `Buyer requested ${requested}; actual was only ${Math.round(row.actual_qty)} (${Math.round(100 * row.actual_qty / requested)}%).`,
    { requested, actual: row.actual_qty },
    planning_run_id,
  )];
}

// ── Aggregate runner ──────────────────────────────────────────────────────
export function runAnomalyDetection(ctx: AnomalyContext, accuracyRows: IpForecastAccuracy[]): Out[] {
  const out: Out[] = [];
  for (const row of accuracyRows) {
    const trail = ctx.actualsBySku.get(row.sku_id) ?? [];
    // "trail" should exclude the current actual. The service caller
    // slices one short if needed; here we just consume it as-is.
    out.push(...detectDemandAnomalies(row, trail, ctx.planning_run_id ?? null));
  }
  // Streak detectors: iterate per-sku.
  for (const [sku_id, acc] of ctx.accuracyBySku) {
    out.push(...detectRepeatedForecastMiss(acc, ctx.planning_run_id ?? null));
    out.push(...detectChronicOverbuy(acc, ctx.planning_run_id ?? null));
    out.push(...detectForecastVolatility(acc, ctx.planning_run_id ?? null));

    const latest = acc[acc.length - 1];
    if (!latest) continue;
    const stock = ctx.stockoutsBySku.get(sku_id) ?? [];
    out.push(...detectChronicStockout(sku_id, stock, latest.period_start, latest.period_end, latest.period_code, ctx.planning_run_id ?? null));
    const ret = ctx.returnRateBySku.get(sku_id) ?? [];
    out.push(...detectReturnRateSpike(sku_id, ret, latest.period_start, latest.period_end, latest.period_code, ctx.planning_run_id ?? null));
    const prot = ctx.protectedUncoveredBySku.get(sku_id) ?? [];
    out.push(...detectProtectedRepeatedlyUncovered(sku_id, prot, latest.period_start, latest.period_end, latest.period_code, ctx.planning_run_id ?? null));
  }
  return out;
}
