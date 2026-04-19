// Recommendation compute: given a final forecast row and a supply view,
// classify the next action. Pure.
//
// Thresholds are explicit magic numbers so reviewers can argue with them.
// Defaults chosen for a wholesale apparel context where "a 10% cushion"
// is the informal planner rule.

import type {
  IpRecommendedAction,
  IpWholesaleForecast,
  IpWholesaleRecommendation,
} from "../types/wholesale";
import type { PeriodSupply } from "./supply";

export interface RecommendationThresholds {
  // Shortage > shortagePct × forecast → 'buy' (or 'expedite' if the period
  // starts very soon). Default 10%.
  shortagePct: number;
  // Excess > excessPct × forecast → 'reduce'. Default 25%.
  excessPct: number;
  // Days-from-today that flip a 'buy' into an 'expedite'. Default 30.
  expediteWithinDays: number;
  // Forecast below this quantity → always 'monitor' rather than 'buy'
  // (don't chase tiny demand). Default 6.
  monitorFloorQty: number;
}

export const DEFAULT_THRESHOLDS: RecommendationThresholds = {
  shortagePct: 0.1,
  excessPct: 0.25,
  expediteWithinDays: 30,
  monitorFloorQty: 6,
};

export interface RecommendationResult {
  available_supply_qty: number;
  projected_shortage_qty: number;
  projected_excess_qty: number;
  recommended_action: IpRecommendedAction;
  recommended_qty: number | null;
  action_reason: string;
}

function daysBetween(fromIso: string, toIso: string): number {
  const ms = Date.parse(toIso + "T00:00:00Z") - Date.parse(fromIso + "T00:00:00Z");
  return Math.round(ms / 86_400_000);
}

export function recommendForRow(
  forecast: Pick<
    IpWholesaleForecast,
    "final_forecast_qty" | "period_start" | "period_end"
  >,
  supply: PeriodSupply,
  asOfIso: string,
  thresholds: RecommendationThresholds = DEFAULT_THRESHOLDS,
): RecommendationResult {
  const final = forecast.final_forecast_qty;
  const avail = supply.available_supply_qty;
  const shortage = Math.max(0, final - avail);
  const excess = Math.max(0, avail - final);

  const daysToPeriodStart = daysBetween(asOfIso, forecast.period_start);
  const periodInPast = daysBetween(asOfIso, forecast.period_end) < 0;

  // No forecast → hold. Nothing to do.
  if (final <= 0 && avail <= 0) {
    return {
      available_supply_qty: avail,
      projected_shortage_qty: 0,
      projected_excess_qty: 0,
      recommended_action: "hold",
      recommended_qty: null,
      action_reason: "No forecast and no supply for this grain.",
    };
  }

  // Past periods are informational only — don't suggest buying yesterday.
  if (periodInPast) {
    return {
      available_supply_qty: avail,
      projected_shortage_qty: shortage,
      projected_excess_qty: excess,
      recommended_action: "monitor",
      recommended_qty: null,
      action_reason: "Period is in the past — showing retrospectively.",
    };
  }

  // Shortage path.
  if (shortage > 0 && shortage >= thresholds.shortagePct * Math.max(final, 1)) {
    if (final < thresholds.monitorFloorQty) {
      return {
        available_supply_qty: avail,
        projected_shortage_qty: shortage,
        projected_excess_qty: 0,
        recommended_action: "monitor",
        recommended_qty: null,
        action_reason: `Forecast ${final} below monitor floor (${thresholds.monitorFloorQty}); watch, don't chase.`,
      };
    }
    if (daysToPeriodStart >= 0 && daysToPeriodStart < thresholds.expediteWithinDays) {
      return {
        available_supply_qty: avail,
        projected_shortage_qty: shortage,
        projected_excess_qty: 0,
        recommended_action: "expedite",
        recommended_qty: shortage,
        action_reason: `Shortage of ${shortage} units ≤ ${thresholds.expediteWithinDays} days from period start.`,
      };
    }
    return {
      available_supply_qty: avail,
      projected_shortage_qty: shortage,
      projected_excess_qty: 0,
      recommended_action: "buy",
      recommended_qty: shortage,
      action_reason: `Shortage of ${shortage} units vs forecast ${final}.`,
    };
  }

  // Excess path.
  if (excess > 0 && excess >= thresholds.excessPct * Math.max(final, 1)) {
    return {
      available_supply_qty: avail,
      projected_shortage_qty: 0,
      projected_excess_qty: excess,
      recommended_action: "reduce",
      recommended_qty: excess,
      action_reason: `Excess of ${excess} units above forecast ${final} (> ${Math.round(thresholds.excessPct * 100)}%).`,
    };
  }

  return {
    available_supply_qty: avail,
    projected_shortage_qty: shortage,
    projected_excess_qty: excess,
    recommended_action: "hold",
    recommended_qty: null,
    action_reason: "Supply and forecast are within tolerance.",
  };
}

// Convenience for the service layer: build a full recommendation row
// ready to upsert into ip_wholesale_recommendations.
export function buildRecommendationRow(
  f: IpWholesaleForecast,
  supply: PeriodSupply,
  asOfIso: string,
  thresholds?: RecommendationThresholds,
): Omit<IpWholesaleRecommendation, "id" | "created_at"> {
  const r = recommendForRow(f, supply, asOfIso, thresholds);
  return {
    planning_run_id: f.planning_run_id,
    customer_id: f.customer_id,
    category_id: f.category_id,
    sku_id: f.sku_id,
    period_start: f.period_start,
    period_end: f.period_end,
    final_forecast_qty: f.final_forecast_qty,
    available_supply_qty: r.available_supply_qty,
    projected_shortage_qty: r.projected_shortage_qty,
    projected_excess_qty: r.projected_excess_qty,
    recommended_action: r.recommended_action,
    recommended_qty: r.recommended_qty,
    action_reason: r.action_reason,
  };
}

export function generateWholesaleRecommendations(
  forecasts: IpWholesaleForecast[],
  supplyBySkuPeriod: Map<string, PeriodSupply>,
  asOfIso: string,
  thresholds?: RecommendationThresholds,
): Array<Omit<IpWholesaleRecommendation, "id" | "created_at">> {
  return forecasts.map((f) => {
    const key = `${f.sku_id}:${f.period_start}`;
    const supply = supplyBySkuPeriod.get(key) ?? {
      on_hand_qty: 0,
      on_po_qty: 0,
      receipts_due_qty: 0,
      available_supply_qty: 0,
    };
    return buildRecommendationRow(f, supply, asOfIso, thresholds);
  });
}

export function supplyKey(skuId: string, periodStart: string): string {
  return `${skuId}:${periodStart}`;
}
