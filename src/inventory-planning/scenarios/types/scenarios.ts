// Phase 4 — scenarios, approvals, audit, exports types.
// Mirror the SQL in 20260419850000_inventory_planning_phase4.sql.

import type { IpIsoDate, IpIsoDateTime } from "../../types/entities";

export type IpScenarioType =
  | "what_if" | "stretch" | "conservative" | "promo" | "supply_delay" | "override_review";

export type IpApprovalStatus = "draft" | "in_review" | "approved" | "rejected" | "archived";

export type IpAssumptionType =
  | "demand_uplift_percent"
  | "lead_time_days_override"
  | "receipt_delay_days"
  | "protection_percent"
  | "reserve_qty_override"
  | "override_qty"
  | "markdown_flag"
  | "promo_flag";

export type IpAssumptionUnit = "percent" | "days" | "qty" | "flag";

export interface IpScenario {
  id: string;
  planning_run_id: string;
  scenario_name: string;
  scenario_type: IpScenarioType;
  status: IpApprovalStatus;
  base_run_reference_id: string | null;
  note: string | null;
  created_by: string | null;
  created_at: IpIsoDateTime;
  updated_at: IpIsoDateTime;
}

export interface IpScenarioAssumption {
  id: string;
  scenario_id: string;
  assumption_type: IpAssumptionType;
  applies_to_customer_id: string | null;
  applies_to_channel_id: string | null;
  applies_to_category_id: string | null;
  applies_to_sku_id: string | null;
  period_start: IpIsoDate | null;
  assumption_value: number | null;
  assumption_unit: IpAssumptionUnit | null;
  note: string | null;
  created_by: string | null;
  created_at: IpIsoDateTime;
  updated_at: IpIsoDateTime;
}

export interface IpPlanningApproval {
  id: string;
  planning_run_id: string | null;
  scenario_id: string | null;
  approval_status: IpApprovalStatus;
  approved_by: string | null;
  approved_at: IpIsoDateTime | null;
  note: string | null;
  created_at: IpIsoDateTime;
  updated_at: IpIsoDateTime;
}

export type IpAuditEntityType =
  | "scenario" | "assumption" | "approval" | "override" | "buyer_request"
  | "allocation_rule" | "recommendation" | "planning_run" | "other";

export interface IpChangeAuditLog {
  id: string;
  entity_type: IpAuditEntityType;
  entity_id: string | null;
  changed_field: string | null;
  old_value: string | null;
  new_value: string | null;
  changed_by: string | null;
  change_reason: string | null;
  planning_run_id: string | null;
  scenario_id: string | null;
  created_at: IpIsoDateTime;
}

export type IpExportType =
  | "wholesale_buy_plan"
  | "ecom_buy_plan"
  | "shortage_report"
  | "excess_report"
  | "recommendations_report"
  | "scenario_comparison";

export interface IpExportJob {
  id: string;
  planning_run_id: string | null;
  scenario_id: string | null;
  export_type: IpExportType;
  export_status: "queued" | "completed" | "failed";
  file_name: string | null;
  row_count: number | null;
  note: string | null;
  created_by: string | null;
  created_at: IpIsoDateTime;
}

// ── Compute I/O ───────────────────────────────────────────────────────────
export interface ScenarioComparisonRow {
  sku_id: string;
  sku_code: string;
  sku_description: string | null;
  category_id: string | null;
  category_name: string | null;
  period_code: string;
  period_start: IpIsoDate;
  base_demand: number;
  scenario_demand: number;
  demand_delta: number;
  base_supply: number;
  scenario_supply: number;
  supply_delta: number;
  base_ending: number;
  scenario_ending: number;
  ending_delta: number;
  base_shortage: number;
  scenario_shortage: number;
  shortage_delta: number;
  base_excess: number;
  scenario_excess: number;
  excess_delta: number;
  base_stockout: boolean;
  scenario_stockout: boolean;
  base_top_rec: string | null;
  scenario_top_rec: string | null;
}

export interface ScenarioComparisonTotals {
  base_row_count: number;
  scenario_row_count: number;
  demand_delta_sum: number;
  supply_delta_sum: number;
  shortage_delta_sum: number;
  excess_delta_sum: number;
  stockouts_added: number;
  stockouts_removed: number;
  recs_changed: number;
}
