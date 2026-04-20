// Accuracy compute. Pure. No IO.
//
// Definitions (kept visible so anyone can verify a cell in the UI):
//
//   abs_error    = |forecast − actual|
//   pct_error    = (forecast − actual) / actual      -- null if actual = 0
//   bias         = forecast − actual                 -- signed
//   weighted_err = abs_error × actual                -- for WAPE-style rollups
//
//   MAE  = mean(abs_error)                           -- averaged over rows
//   WAPE = Σ|forecast − actual| / Σ actual           -- demand-weighted
//   MAPE = mean(|pct_error|) for rows where actual > 0
//
// Divide-by-zero:
//   • pct_error / MAPE skip rows with actual = 0
//   • WAPE returns 0 when Σ actual = 0
//
// Override helped?
//   abs_error_system − abs_error_final > HELPED_EPSILON  → override helped
//   abs_error_system − abs_error_final < -HELPED_EPSILON → override hurt
//   otherwise neutral / no override

import type { IpForecastAccuracy, IpOverrideEffectiveness } from "../types/accuracy";

// A 1-unit tie-break so the 50/50 case isn't a coin flip for the UI badge.
export const HELPED_EPSILON = 1.0;

export interface PerRowInputs {
  system_forecast_qty: number;
  final_forecast_qty: number;
  actual_qty: number;
}

export function computePerRowMetrics(
  row: PerRowInputs,
): Pick<
  IpForecastAccuracy,
  | "abs_error_system" | "abs_error_final"
  | "pct_error_system" | "pct_error_final"
  | "bias_system" | "bias_final"
  | "weighted_error_system" | "weighted_error_final"
> {
  const s = safeNum(row.system_forecast_qty);
  const f = safeNum(row.final_forecast_qty);
  const a = safeNum(row.actual_qty);

  const absS = Math.abs(s - a);
  const absF = Math.abs(f - a);
  const biasS = s - a;
  const biasF = f - a;
  const pctS = a > 0 ? (s - a) / a : null;
  const pctF = a > 0 ? (f - a) / a : null;
  const wS = absS * a;
  const wF = absF * a;

  return {
    abs_error_system: absS,
    abs_error_final: absF,
    pct_error_system: pctS,
    pct_error_final: pctF,
    bias_system: biasS,
    bias_final: biasF,
    weighted_error_system: wS,
    weighted_error_final: wF,
  };
}

export function overrideHelped(row: PerRowInputs): boolean | null {
  const s = safeNum(row.system_forecast_qty);
  const f = safeNum(row.final_forecast_qty);
  const a = safeNum(row.actual_qty);
  // No override, or no actual yet → can't score.
  if (s === f) return null;
  if (a === 0 && s === 0 && f === 0) return null;
  const delta = Math.abs(s - a) - Math.abs(f - a);
  if (delta > HELPED_EPSILON) return true;
  if (delta < -HELPED_EPSILON) return false;
  return null;
}

export function errorDelta(row: PerRowInputs): number {
  const s = safeNum(row.system_forecast_qty);
  const f = safeNum(row.final_forecast_qty);
  const a = safeNum(row.actual_qty);
  return Math.abs(s - a) - Math.abs(f - a);
}

// ── Aggregations ──────────────────────────────────────────────────────────
export function aggregateAccuracy(rows: IpForecastAccuracy[]) {
  const n = rows.length;
  if (n === 0) {
    return {
      row_count: 0, total_actual: 0,
      mae_system: 0, mae_final: 0,
      wape_system: 0, wape_final: 0,
      bias_system: 0, bias_final: 0,
      mae_delta: 0,
    };
  }
  let sumAbsS = 0, sumAbsF = 0, sumActual = 0, sumBiasS = 0, sumBiasF = 0;
  for (const r of rows) {
    sumAbsS += r.abs_error_system;
    sumAbsF += r.abs_error_final;
    sumActual += r.actual_qty;
    sumBiasS += r.bias_system;
    sumBiasF += r.bias_final;
  }
  const mae_system = sumAbsS / n;
  const mae_final = sumAbsF / n;
  const wape_system = sumActual > 0 ? sumAbsS / sumActual : 0;
  const wape_final = sumActual > 0 ? sumAbsF / sumActual : 0;
  const bias_system = sumBiasS / n;
  const bias_final = sumBiasF / n;
  return {
    row_count: n,
    total_actual: sumActual,
    mae_system, mae_final,
    wape_system, wape_final,
    bias_system, bias_final,
    mae_delta: mae_system - mae_final,
  };
}

export function aggregateOverrideEffectiveness(rows: IpOverrideEffectiveness[]) {
  const by = new Map<string, { helped: number; hurt: number; neutral: number; total: number; sumDelta: number }>();
  for (const r of rows) {
    const k = r.override_reason ?? "(none)";
    const e = by.get(k) ?? { helped: 0, hurt: 0, neutral: 0, total: 0, sumDelta: 0 };
    e.total++;
    if (r.override_helped_flag === true) e.helped++;
    else if (r.override_helped_flag === false) e.hurt++;
    else e.neutral++;
    e.sumDelta += r.error_delta ?? 0;
    by.set(k, e);
  }
  return Array.from(by, ([key, v]) => ({
    key,
    label: key,
    helped_count: v.helped,
    hurt_count: v.hurt,
    neutral_count: v.neutral,
    total_count: v.total,
    avg_error_delta: v.total > 0 ? v.sumDelta / v.total : 0,
  })).sort((a, b) => b.avg_error_delta - a.avg_error_delta);
}

function safeNum(n: unknown): number {
  if (typeof n === "number" && Number.isFinite(n)) return n;
  return 0;
}
