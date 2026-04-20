// Phase 5 — anomaly + AI suggestion types.
// Mirror the SQL in 20260419860000_inventory_planning_phase5.sql.

import type { IpIsoDate, IpIsoDateTime } from "../../types/entities";
import type { IpForecastType } from "../../accuracy/types/accuracy";

export type IpAnomalyType =
  | "demand_spike"
  | "demand_collapse"
  | "repeated_forecast_miss"
  | "chronic_overbuy"
  | "chronic_stockout"
  | "return_rate_spike"
  | "protected_repeatedly_uncovered"
  | "buyer_request_conversion_miss"
  | "forecast_volatility";

export type IpAnomalySeverity = "critical" | "high" | "medium" | "low";

export interface IpPlanningAnomaly {
  id: string;
  planning_run_id: string | null;
  scenario_id: string | null;
  forecast_type: IpForecastType | null;
  sku_id: string;
  customer_id: string | null;
  channel_id: string | null;
  category_id: string | null;
  period_start: IpIsoDate;
  period_end: IpIsoDate;
  period_code: string;
  anomaly_type: IpAnomalyType;
  severity: IpAnomalySeverity;
  confidence_score: number | null;
  message: string;
  details_json: Record<string, unknown>;
  created_at: IpIsoDateTime;
}

export type IpSuggestionType =
  | "increase_forecast"
  | "decrease_forecast"
  | "increase_confidence"
  | "lower_confidence"
  | "protect_more_inventory"
  | "reduce_buy_recommendation"
  | "review_buyer_request"
  | "inspect_return_rate";

export interface IpAiSuggestion {
  id: string;
  planning_run_id: string | null;
  scenario_id: string | null;
  forecast_type: IpForecastType | null;
  sku_id: string;
  customer_id: string | null;
  channel_id: string | null;
  category_id: string | null;
  period_start: IpIsoDate;
  period_end: IpIsoDate;
  period_code: string;
  suggestion_type: IpSuggestionType;
  suggested_qty_delta: number | null;
  suggested_final_qty: number | null;
  confidence_score: number | null;
  rationale: string;
  input_summary_json: Record<string, unknown>;
  accepted_flag: boolean | null;
  accepted_by: string | null;
  accepted_at: IpIsoDateTime | null;
  created_at: IpIsoDateTime;
}
