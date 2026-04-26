// Wholesale planning types — Phase 1 MVP.
//
// These mirror the SQL columns in 20260419820000_inventory_planning_phase1.sql.
// Keep the enum unions in sync with the CHECK constraints; the compiler
// then catches typos at call sites.

import type { IpIsoDate, IpIsoDateTime } from "./entities";

export type IpConfidenceLevel = "committed" | "probable" | "possible" | "estimate";

export type IpRequestType =
  | "buyer_request"
  | "expected_reorder"
  | "program_fill_in"
  | "seasonal_estimate"
  | "planner_estimate"
  | "customer_expansion";

export type IpRequestStatus = "open" | "applied" | "archived";

export type IpOverrideReasonCode =
  | "buyer_request"
  | "planner_estimate"
  | "management_input"
  | "launch_expectation"
  | "customer_expansion"
  | "supply_adjustment";

export type IpForecastMethod =
  | "ly_sales"
  | "trailing_avg_sku"
  | "weighted_recent_sku"
  | "cadence_sku"
  | "category_fallback"
  | "customer_category_fallback"
  | "zero_floor";

// The three planner-visible method choices stored on ip_planning_runs.
// Maps to the compute layer's preferred first-branch; fallbacks are automatic.
export type IpForecastMethodPreference = "ly_sales" | "weighted_recent" | "cadence";

export const FORECAST_METHOD_LABELS: Record<IpForecastMethodPreference, string> = {
  ly_sales:        "Same Period LY",
  weighted_recent: "Weighted Recent Demand",
  cadence:         "Reorder Cadence",
};

export type IpRecommendedAction = "buy" | "hold" | "monitor" | "reduce" | "expedite";

export type IpPlanningScope = "wholesale" | "ecom" | "all";
export type IpPlanningRunStatus = "draft" | "active" | "archived";

export interface IpPlanningRun {
  id: string;
  name: string;
  planning_scope: IpPlanningScope;
  status: IpPlanningRunStatus;
  source_snapshot_date: IpIsoDate;
  horizon_start: IpIsoDate | null;
  horizon_end: IpIsoDate | null;
  forecast_method_preference: IpForecastMethodPreference;
  // Phase 3 cross-scope pointers (non-null on "all"-scope runs).
  wholesale_source_run_id: string | null;
  ecom_source_run_id: string | null;
  note: string | null;
  created_by: string | null;
  created_at: IpIsoDateTime;
  updated_at: IpIsoDateTime;
}

export interface IpWholesaleForecast {
  id: string;
  planning_run_id: string;
  customer_id: string;
  category_id: string | null;
  sku_id: string;
  period_start: IpIsoDate;
  period_end: IpIsoDate;
  period_code: string;
  system_forecast_qty: number;
  buyer_request_qty: number;
  override_qty: number;
  final_forecast_qty: number;
  confidence_level: IpConfidenceLevel;
  forecast_method: IpForecastMethod;
  history_months_used: number | null;
  ly_reference_qty: number | null;
  planned_buy_qty: number | null;
  unit_cost_override: number | null;
  notes: string | null;
  created_at: IpIsoDateTime;
  updated_at: IpIsoDateTime;
}

export interface IpFutureDemandRequest {
  id: string;
  customer_id: string;
  category_id: string | null;
  sku_id: string;
  target_period_start: IpIsoDate;
  target_period_end: IpIsoDate;
  requested_qty: number;
  confidence_level: IpConfidenceLevel;
  request_type: IpRequestType;
  request_status: IpRequestStatus;
  note: string | null;
  created_by: string | null;
  created_at: IpIsoDateTime;
  updated_at: IpIsoDateTime;
}

export interface IpPlannerOverride {
  id: string;
  planning_run_id: string;
  customer_id: string;
  category_id: string | null;
  sku_id: string;
  period_start: IpIsoDate;
  period_end: IpIsoDate;
  override_qty: number;
  reason_code: IpOverrideReasonCode;
  note: string | null;
  created_by: string | null;
  created_at: IpIsoDateTime;
  updated_at: IpIsoDateTime;
}

export interface IpWholesaleRecommendation {
  id: string;
  planning_run_id: string;
  customer_id: string;
  category_id: string | null;
  sku_id: string;
  period_start: IpIsoDate;
  period_end: IpIsoDate;
  final_forecast_qty: number;
  available_supply_qty: number;
  projected_shortage_qty: number;
  projected_excess_qty: number;
  recommended_action: IpRecommendedAction;
  recommended_qty: number | null;
  action_reason: string | null;
  created_at: IpIsoDateTime;
}

// ── Working types (not persisted) ──────────────────────────────────────────
// The row shape the grid/workbench holds in memory: forecast + denorm names
// + supply context + recommendation. Keeps the UI props flat.
export interface IpPlanningGridRow {
  forecast_id: string;
  planning_run_id: string;
  customer_id: string;
  customer_name: string;
  category_id: string | null;
  category_name: string | null;
  sku_id: string;
  sku_code: string;
  sku_description: string | null;
  sku_style: string | null;
  sku_color: string | null;
  period_code: string;
  period_start: IpIsoDate;
  period_end: IpIsoDate;
  historical_trailing_qty: number;
  system_forecast_qty: number;
  buyer_request_qty: number;
  override_qty: number;
  final_forecast_qty: number;
  confidence_level: IpConfidenceLevel;
  forecast_method: IpForecastMethod;
  ly_reference_qty: number | null;
  item_cost: number | null;
  ats_avg_cost: number | null;
  // Canonical avg cost from ip_item_avg_cost (Xoro/Excel ingest). Static
  // in the grid; auto-fills the editable Unit Cost cell.
  avg_cost: number | null;
  unit_cost_override: number | null;
  // Effective unit cost used for Buy $: override → avg_cost → ats_avg_cost → item_cost.
  unit_cost: number | null;
  planned_buy_qty: number | null;
  on_hand_qty: number | null;
  on_so_qty: number;
  on_po_qty: number | null;
  receipts_due_qty: number | null;
  available_supply_qty: number;
  projected_shortage_qty: number;
  projected_excess_qty: number;
  recommended_action: IpRecommendedAction;
  recommended_qty: number | null;
  action_reason: string | null;
  notes: string | null;
}

// Inputs for the forecast compute step. Kept small on purpose — the
// service layer is responsible for loading masters and passing only what
// the pure function needs.
export interface IpForecastComputeInput {
  planning_run_id: string;
  source_snapshot_date: IpIsoDate;
  // Planner-selected method preference. The compute layer attempts this
  // branch first; if data is insufficient it falls through the normal
  // waterfall and records the method that was actually used.
  methodPreference?: IpForecastMethodPreference;
  // Inclusive horizon the caller wants filled. The compute iterates every
  // month in [horizon_start, horizon_end].
  horizon_start: IpIsoDate;
  horizon_end: IpIsoDate;
  // Candidate (customer, sku) pairs to forecast. Typically derived from
  // the last N months of history plus any future-demand requests.
  pairs: Array<{ customer_id: string; sku_id: string; category_id: string | null }>;
  // Normalized Xoro sales history, filtered to wholesale rows. Compute
  // treats all rows equally — the caller is responsible for trimming to
  // the lookback window it wants (default 12 months before snapshot).
  history: Array<{
    customer_id: string;
    sku_id: string;
    category_id: string | null;
    txn_date: IpIsoDate;
    qty: number;
  }>;
  // Open future-demand requests already converted to monthly buckets.
  requests: Array<{
    customer_id: string;
    sku_id: string;
    period_code: string;
    period_start: IpIsoDate;
    period_end: IpIsoDate;
    requested_qty: number;
    confidence_level: IpConfidenceLevel;
  }>;
  // Current override values keyed by the natural grain.
  overrides: Array<{
    customer_id: string;
    sku_id: string;
    period_start: IpIsoDate;
    override_qty: number;
  }>;
}

export type IpForecastComputeOutput = Omit<
  IpWholesaleForecast,
  "id" | "created_at" | "updated_at"
>;

export interface IpSupplyContext {
  sku_id: string;
  // As-of snapshot values — already netted if the caller wants "ATS".
  on_hand_qty: number;
  on_po_qty: number;
  receipts_due_qty: number;
  // Available for planning in the period: on_hand + on_po scheduled in or
  // before the period + receipts confirmed in the period. Compute layer
  // picks the combination the business wants.
  available_supply_qty: number;
}
