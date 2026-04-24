// Ecom planning types — Phase 2 MVP.
//
// Mirrors the SQL in 20260419830000_inventory_planning_phase2.sql. Enum
// unions stay in lock-step with the DB CHECK constraints.

import type { IpIsoDate, IpIsoDateTime } from "../../types/entities";

export type IpEcomForecastMethod =
  | "trailing_4w"
  | "trailing_13w"
  | "weighted_recent"
  | "seasonality"
  | "launch_curve"
  | "category_fallback"
  | "zero_floor";

export type IpEcomOverrideReason =
  | "promotion"
  | "campaign"
  | "content_push"
  | "influencer"
  | "launch_expectation"
  | "markdown_strategy"
  | "planner_estimate";

export interface IpEcomForecast {
  id: string;
  planning_run_id: string;
  channel_id: string;
  category_id: string | null;
  sku_id: string;
  week_start: IpIsoDate;
  week_end: IpIsoDate;
  period_code: string;
  system_forecast_qty: number;
  override_qty: number;
  final_forecast_qty: number;
  protected_ecom_qty: number;
  promo_flag: boolean;
  launch_flag: boolean;
  markdown_flag: boolean;
  forecast_method: IpEcomForecastMethod;
  return_rate: number | null;
  seasonality_factor: number | null;
  promo_factor: number | null;
  launch_factor: number | null;
  markdown_factor: number | null;
  trailing_4w_qty: number | null;
  trailing_13w_qty: number | null;
  planned_buy_qty: number | null;
  notes: string | null;
  created_at: IpIsoDateTime;
  updated_at: IpIsoDateTime;
}

export interface IpEcomOverrideEvent {
  id: string;
  planning_run_id: string;
  channel_id: string;
  category_id: string | null;
  sku_id: string;
  week_start: IpIsoDate;
  week_end: IpIsoDate;
  override_qty: number;
  reason_code: IpEcomOverrideReason;
  note: string | null;
  created_by: string | null;
  created_at: IpIsoDateTime;
}

// Channel merchandising status (matches extended ip_product_channel_status).
export interface IpProductChannelStatusExt {
  id?: string;
  sku_id: string;
  channel_id: string;
  is_active: boolean | null;
  listed: boolean;
  status: string | null;
  launch_date: IpIsoDate | null;
  markdown_flag: boolean;
  inventory_policy: string | null;
  price: number | null;
  compare_at_price: number | null;
  currency: string | null;
  published_at: IpIsoDateTime | null;
  unpublished_at: IpIsoDateTime | null;
  observed_at: IpIsoDateTime;
}

// Working row for the ecom grid. Flat shape so the UI can render without
// joining on each paint.
export interface IpEcomGridRow {
  forecast_id: string;
  planning_run_id: string;
  channel_id: string;
  channel_name: string;
  category_id: string | null;
  category_name: string | null;
  sku_id: string;
  sku_code: string;
  sku_description: string | null;
  period_code: string;
  week_start: IpIsoDate;
  week_end: IpIsoDate;
  trailing_4w_qty: number;
  trailing_13w_qty: number;
  trend_pct: number | null;         // (4w_run_rate vs 13w_run_rate) - 1
  system_forecast_qty: number;
  override_qty: number;
  final_forecast_qty: number;
  protected_ecom_qty: number;
  promo_flag: boolean;
  launch_flag: boolean;
  markdown_flag: boolean;
  is_active: boolean;
  return_rate: number | null;
  forecast_method: IpEcomForecastMethod;
  planned_buy_qty: number | null;
  on_hand_qty: number;
  available_supply_qty: number;
  projected_shortage_qty: number;
  projected_excess_qty: number;
  notes: string | null;
}

// ── Compute inputs ─────────────────────────────────────────────────────────
export interface IpEcomForecastComputeInput {
  planning_run_id: string;
  source_snapshot_date: IpIsoDate;
  horizon_start: IpIsoDate;
  horizon_end: IpIsoDate;
  // Candidate (channel, sku, category) triples. Typically built from
  // product_channel_status rows where is_active OR the pair has history.
  triples: Array<{
    channel_id: string;
    sku_id: string;
    category_id: string | null;
    // From product_channel_status:
    launch_date: IpIsoDate | null;
    markdown_flag: boolean;
    is_active: boolean;
  }>;
  // Normalized ecom sales history, filtered to the lookback. Compute
  // bucketizes to weeks internally.
  history: Array<{
    channel_id: string;
    sku_id: string;
    category_id: string | null;
    order_date: IpIsoDate;
    qty: number;
    returned_qty: number;
  }>;
  // Active promo windows — applied to system_forecast_qty when a week
  // falls inside one.
  promos?: Array<{ channel_id: string; sku_id: string; start: IpIsoDate; end: IpIsoDate; uplift?: number }>;
  // Planner overrides keyed by grain. Latest per (run, channel, sku, week)
  // wins; the repository dedupes.
  overrides: Array<{
    channel_id: string;
    sku_id: string;
    week_start: IpIsoDate;
    override_qty: number;
  }>;
}

export type IpEcomForecastComputeOutput = Omit<
  IpEcomForecast,
  "id" | "created_at" | "updated_at"
>;
