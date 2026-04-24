// Phase 5 — accuracy + override effectiveness types.
// Mirror the SQL in 20260419860000_inventory_planning_phase5.sql.

import type { IpIsoDate, IpIsoDateTime } from "../../types/entities";

export type IpForecastType = "wholesale" | "ecom";

export interface IpForecastActual {
  id: string;
  forecast_type: IpForecastType;
  sku_id: string;
  customer_id: string | null;
  channel_id: string | null;
  category_id: string | null;
  period_start: IpIsoDate;
  period_end: IpIsoDate;
  period_code: string;
  actual_qty: number;
  actual_net_sales: number | null;
  created_at: IpIsoDateTime;
}

export interface IpForecastAccuracy {
  id: string;
  planning_run_id: string | null;
  scenario_id: string | null;
  forecast_type: IpForecastType;
  sku_id: string;
  customer_id: string | null;
  channel_id: string | null;
  category_id: string | null;
  period_start: IpIsoDate;
  period_end: IpIsoDate;
  period_code: string;
  forecast_method: string | null;
  system_forecast_qty: number;
  final_forecast_qty: number;
  actual_qty: number;
  abs_error_system: number;
  abs_error_final: number;
  pct_error_system: number | null;
  pct_error_final: number | null;
  bias_system: number;
  bias_final: number;
  weighted_error_system: number;
  weighted_error_final: number;
  created_at: IpIsoDateTime;
}

export interface IpOverrideEffectiveness {
  id: string;
  planning_run_id: string | null;
  scenario_id: string | null;
  forecast_type: IpForecastType;
  sku_id: string;
  customer_id: string | null;
  channel_id: string | null;
  category_id: string | null;
  period_start: IpIsoDate;
  period_end: IpIsoDate;
  period_code: string;
  override_reason: string | null;
  system_forecast_qty: number;
  final_forecast_qty: number;
  actual_qty: number;
  override_helped_flag: boolean | null;
  error_delta: number | null;
  created_at: IpIsoDateTime;
}

// ── Rollup shape used by the dashboard ────────────────────────────────────
export interface IpAccuracyRollup {
  // Rollup scope: "sku" | "category" | "customer" | "channel" | "all".
  grain: string;
  key: string;         // id of the grouping entity (or "*" for "all")
  label: string;       // human label (name)
  forecast_type: IpForecastType | "all";
  // Counts.
  row_count: number;
  total_actual: number;
  // System metrics
  mae_system: number;          // mean absolute error
  wape_system: number;         // weighted absolute percent error (Σ|F−A| / ΣA)
  bias_system: number;         // mean signed bias
  // Final metrics
  mae_final: number;
  wape_final: number;
  bias_final: number;
  // Net benefit of overrides: (mae_system − mae_final). Positive = overrides helped.
  mae_delta: number;
}

export interface IpOverrideRollup {
  // Bucket by override_reason (or planner).
  grain: "override_reason" | "forecast_type" | "category" | "customer" | "channel";
  key: string;
  label: string;
  helped_count: number;
  hurt_count: number;
  neutral_count: number;
  total_count: number;
  // Positive = overall the overrides of this reason helped.
  avg_error_delta: number;
}
