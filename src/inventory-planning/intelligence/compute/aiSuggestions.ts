// Explainable suggestion engine. Heuristic-only, no model. Every
// suggestion carries:
//   • suggestion_type         — what the planner should consider doing
//   • suggested_qty_delta     — signed number, or null if action-only
//   • suggested_final_qty     — target qty if planner accepts
//   • confidence_score        — 0..1; always visible
//   • rationale               — one-sentence explanation
//   • input_summary_json      — exact numbers the heuristic saw
//
// Suggestions are proposals. The service layer persists them as
// untouched (accepted_flag=null). A planner clicks accept/ignore from
// the drawer.

import type {
  IpAiSuggestion,
  IpSuggestionType,
} from "../types/intelligence";
import type { IpForecastAccuracy, IpForecastType } from "../../accuracy/types/accuracy";

export const CONSISTENT_OVER_STREAK = 3;
export const CONSISTENT_UNDER_STREAK = 3;
export const OVER_UNDER_THRESHOLD_PCT = 0.15;
export const RETURN_RATE_REVIEW = 0.35;

type Out = Omit<IpAiSuggestion, "id" | "created_at">;

function build(
  forecast_type: IpForecastType | null,
  sku_id: string,
  period_start: string,
  period_end: string,
  period_code: string,
  type: IpSuggestionType,
  qty_delta: number | null,
  suggested_final: number | null,
  confidence: number,
  rationale: string,
  summary: Record<string, unknown>,
  planning_run_id: string | null = null,
): Out {
  return {
    planning_run_id,
    scenario_id: null,
    forecast_type,
    sku_id,
    customer_id: null,
    channel_id: null,
    category_id: null,
    period_start,
    period_end,
    period_code,
    suggestion_type: type,
    suggested_qty_delta: qty_delta,
    suggested_final_qty: suggested_final,
    confidence_score: confidence,
    rationale,
    input_summary_json: summary,
    accepted_flag: null,
    accepted_by: null,
    accepted_at: null,
  };
}

export function suggestForecastAdjustment(
  acc: IpForecastAccuracy[], // newest last, ≥ CONSISTENT_OVER_STREAK
  currentFinal: number,
  planning_run_id: string | null = null,
): Out[] {
  if (acc.length < CONSISTENT_OVER_STREAK) return [];
  const recent = acc.slice(-CONSISTENT_OVER_STREAK);
  const latest = recent[recent.length - 1];

  // Consistent overforecast → suggest a downward adjustment.
  const allOver = recent.every((r) => {
    const denom = Math.max(r.actual_qty, 1);
    return r.pct_error_final != null && r.pct_error_final > OVER_UNDER_THRESHOLD_PCT;
  });
  const allUnder = recent.every((r) => {
    const denom = Math.max(r.actual_qty, 1);
    return r.pct_error_final != null && r.pct_error_final < -OVER_UNDER_THRESHOLD_PCT;
  });
  if (allOver) {
    // Average signed pct error → apply as a downward correction.
    const avgPctErr = recent.reduce((a, b) => a + (b.pct_error_final ?? 0), 0) / recent.length;
    const delta = -Math.round(currentFinal * avgPctErr);
    const suggested = Math.max(0, currentFinal + delta);
    return [build(
      latest.forecast_type, latest.sku_id, latest.period_start, latest.period_end, latest.period_code,
      "decrease_forecast",
      delta,
      suggested,
      Math.min(0.9, 0.4 + Math.abs(avgPctErr)),
      `Final forecast has overshot by ~${(avgPctErr * 100).toFixed(0)}% for ${CONSISTENT_OVER_STREAK} periods. Suggest ${delta} to land near actuals.`,
      { recent_pct_errors: recent.map((r) => r.pct_error_final), avg_pct_err: avgPctErr },
      planning_run_id,
    )];
  }
  if (allUnder) {
    const avgPctErr = recent.reduce((a, b) => a + (b.pct_error_final ?? 0), 0) / recent.length;
    const delta = -Math.round(currentFinal * avgPctErr); // avgPctErr negative → delta positive
    const suggested = Math.max(0, currentFinal + delta);
    return [build(
      latest.forecast_type, latest.sku_id, latest.period_start, latest.period_end, latest.period_code,
      "increase_forecast",
      delta,
      suggested,
      Math.min(0.9, 0.4 + Math.abs(avgPctErr)),
      `Final forecast has undershot by ~${(Math.abs(avgPctErr) * 100).toFixed(0)}% for ${CONSISTENT_UNDER_STREAK} periods. Suggest +${delta} to match trend.`,
      { recent_pct_errors: recent.map((r) => r.pct_error_final), avg_pct_err: avgPctErr },
      planning_run_id,
    )];
  }
  return [];
}

export function suggestConfidenceAdjustment(
  acc: IpForecastAccuracy[],
  planning_run_id: string | null = null,
): Out[] {
  if (acc.length < 4) return [];
  const recent = acc.slice(-4);
  const absErrs = recent.map((r) => r.abs_error_final);
  const avg = absErrs.reduce((a, b) => a + b, 0) / absErrs.length;
  const latest = recent[recent.length - 1];
  const avgActual = recent.reduce((a, b) => a + b.actual_qty, 0) / recent.length;
  if (avgActual <= 0) return [];
  const wape = avg / avgActual;

  if (wape < 0.1) {
    return [build(
      latest.forecast_type, latest.sku_id, latest.period_start, latest.period_end, latest.period_code,
      "increase_confidence",
      null, null,
      0.8,
      `WAPE over last 4 periods is ${(wape * 100).toFixed(1)}% — confidence can step up a notch.`,
      { wape, window: 4 },
      planning_run_id,
    )];
  }
  if (wape > 0.4) {
    return [build(
      latest.forecast_type, latest.sku_id, latest.period_start, latest.period_end, latest.period_code,
      "lower_confidence",
      null, null,
      0.7,
      `WAPE over last 4 periods is ${(wape * 100).toFixed(0)}% — suggest lowering confidence.`,
      { wape, window: 4 },
      planning_run_id,
    )];
  }
  return [];
}

export function suggestProtectionAdjustment(
  sku_id: string,
  period_start: string,
  period_end: string,
  period_code: string,
  protectedUncoveredStreak: number,
  currentProtected: number,
  planning_run_id: string | null = null,
): Out[] {
  if (protectedUncoveredStreak < 2) return [];
  return [build(
    "ecom", sku_id, period_start, period_end, period_code,
    "protect_more_inventory",
    Math.round(currentProtected * 0.2),
    Math.round(currentProtected * 1.2),
    Math.min(0.9, 0.5 + protectedUncoveredStreak * 0.1),
    `Protected ecom has been uncovered ${protectedUncoveredStreak} periods running — suggest bumping protection by ~20%.`,
    { protected_uncovered_streak: protectedUncoveredStreak },
    planning_run_id,
  )];
}

export function suggestInspectReturnRate(
  sku_id: string,
  period_start: string,
  period_end: string,
  period_code: string,
  latestReturnRate: number,
  planning_run_id: string | null = null,
): Out[] {
  if (latestReturnRate < RETURN_RATE_REVIEW) return [];
  return [build(
    "ecom", sku_id, period_start, period_end, period_code,
    "inspect_return_rate",
    null, null,
    Math.min(0.95, latestReturnRate),
    `Return rate ${(latestReturnRate * 100).toFixed(0)}% is above the ${(RETURN_RATE_REVIEW * 100).toFixed(0)}% review threshold — inspect sizing/quality before driving buys from the current forecast.`,
    { latest_return_rate: latestReturnRate },
    planning_run_id,
  )];
}

export function scoreBuyerRequestConfidence(
  sku_id: string,
  period_start: string,
  period_end: string,
  period_code: string,
  requestedQty: number,
  historicalAvg: number,
  planning_run_id: string | null = null,
): Out[] {
  if (requestedQty <= 0) return [];
  if (historicalAvg <= 0) {
    // No history at all — prompt the planner to double-check before
    // committing supply around a green-field request.
    return [build(
      "wholesale", sku_id, period_start, period_end, period_code,
      "review_buyer_request",
      null, null,
      0.5,
      `Buyer request of ${requestedQty} with no SKU history for this pair — review before allocating.`,
      { requested: requestedQty, historical_avg: historicalAvg },
      planning_run_id,
    )];
  }
  const ratio = requestedQty / historicalAvg;
  if (ratio >= 3) {
    return [build(
      "wholesale", sku_id, period_start, period_end, period_code,
      "review_buyer_request",
      null, null,
      Math.min(0.9, 0.4 + Math.log10(ratio) * 0.3),
      `Buyer request is ${ratio.toFixed(1)}× trailing average (${Math.round(historicalAvg)}) — worth a second look.`,
      { requested: requestedQty, historical_avg: historicalAvg, ratio },
      planning_run_id,
    )];
  }
  return [];
}
