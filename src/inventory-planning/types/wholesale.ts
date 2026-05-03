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
  // Optional planner override of the system value. When non-null the
  // grid displays this in place of system_forecast_qty and shows a
  // "changed from X to Y on DATE" tooltip on the cell.
  system_forecast_qty_override: number | null;
  system_forecast_qty_overridden_at: IpIsoDateTime | null;
  system_forecast_qty_overridden_by: string | null;
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
  // Item-master derived classification (Xoro: GroupName / CategoryName).
  // Rendered in the grid as the "Category" and "Sub Cat" columns. Optional
  // because legacy rows may not have these populated yet.
  group_name: string | null;
  sub_category_name: string | null;
  // Item-master GenderCode. Filter-only — no grid column rendered.
  gender: string | null;
  sku_id: string;
  sku_code: string;
  sku_description: string | null;
  sku_style: string | null;
  sku_color: string | null;
  // True when sku_color was derived from the sku_code suffix because
  // the variant's own item-master color was missing. The grid renders
  // a "⚠ inferred" hint on these rows so the planner sees the data
  // gap instead of trusting it as authoritative.
  sku_color_inferred?: boolean;
  // True when the row is a synthetic "(Supply Only) TBD" stock-buy
  // row from ip_wholesale_forecast_tbd. The grid lets the planner
  // edit color / customer / qty fields directly on these rows; all
  // aggregate Buyer / Override / Buy edits at any rollup grain are
  // routed here instead of distributed across real customer rows.
  is_tbd?: boolean;
  // True ONLY when the planner created the row via "+ Add row" (as
  // opposed to the per-style and per-period catch-all lines the
  // build pipeline auto-synthesizes). Drives three UI affordances:
  // visual distinction (left accent border), editable STYLE cell
  // (so the row can be promoted from "TBD" into a real style), and
  // a delete button at the row's tail. Auto-synthesized rows stay
  // is_user_added=false and remain non-deletable / non-editable in
  // the style cell.
  is_user_added?: boolean;
  // Mirror of ip_wholesale_forecast_tbd.is_new_color — true when the
  // planner has typed a color string that no item_master variant of
  // the style currently carries. Cleared on next build when the
  // master catches up. Surfaced as an orange "NEW COLOR" badge.
  is_new_color?: boolean;
  // For TBD rows: id of the underlying ip_wholesale_forecast_tbd
  // record so edit handlers can patch it directly. forecast_id stays
  // a synthetic prefix ("tbd:<style>:<period>") so it can't collide
  // with real ip_wholesale_forecast ids in mutedById and friends.
  tbd_id?: string;
  // Size from item.size (Option 2 Value column in Excel). Used as a
  // fallback PPK-multiplier source when color doesn't carry "PPKn".
  sku_size: string | null;
  // Set on rows produced by the grid's collapse/aggregate modes — disables
  // inline-edit cells and renders read-only tallies.
  is_aggregate?: boolean;
  aggregate_count?: number;
  // Stable bucket grain key for aggregate rows — derived from the
  // grouping key in aggregateRows (e.g. "cust-all:CUST123:2026-04").
  // Used as the expansion identity in the grid so search/filter/page
  // changes don't auto-collapse expanded rows when the synthetic
  // forecast_id (which embeds bucket.length) changes shape.
  aggregate_key?: string;
  // Server-side updated_at on the underlying TBD row (only set on
  // is_tbd rows). Lets the routing logic prefer the most recently
  // edited TBD row in a bucket EVEN AFTER LOGOUT/LOGIN, when the
  // client's in-memory rowEditOrderRef is empty. Without this, a
  // freshly-logged-in planner's first aggregate edit could land on
  // an arbitrary user-added row instead of the one they touched
  // most recently last session.
  tbd_updated_at?: string;
  // The underlying forecast_id list for an aggregate row. The Buy cell
  // uses these to distribute a typed total across the constituent
  // forecast rows proportional to final_forecast_qty.
  aggregate_underlying_ids?: string[];
  period_code: string;
  period_start: IpIsoDate;
  period_end: IpIsoDate;
  historical_trailing_qty: number;
  system_forecast_qty: number;
  // Original computed system value before any override. Equal to
  // system_forecast_qty when no override is set; otherwise carries
  // the original so the cell tooltip can render "from X to Y".
  system_forecast_qty_original: number;
  system_forecast_qty_overridden_at: IpIsoDateTime | null;
  system_forecast_qty_overridden_by: string | null;
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
  // Future inbound: open POs scheduled to land in the period (expected_date
  // in [period_start, period_end]). Drives supply math.
  receipts_due_qty: number | null;
  // Past actual receipts that landed in the period — display only,
  // already reflected in on_hand_qty so does not feed supply math.
  historical_receipts_qty: number | null;
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
