// Phase 3 (supply reconciliation / allocation) types. Mirrors the
// 20260419840000_inventory_planning_phase3.sql migration. Enum unions
// stay in lockstep with the DB CHECKs.

import type { IpIsoDate, IpIsoDateTime } from "../../types/entities";

export type IpRecommendationType =
  | "buy"
  | "expedite"
  | "hold"
  | "reduce"
  | "monitor"
  | "reallocate"
  | "cancel_receipt"
  | "push_receipt"
  | "protect_inventory";

export type IpPriorityLevel = "critical" | "high" | "medium" | "low";

export type IpAllocationRuleType =
  | "reserve_wholesale"
  | "protect_ecom"
  | "strategic_customer"
  | "cap_ecom";

export type IpSupplyExceptionType =
  | "projected_stockout"
  | "negative_ats"
  | "late_po"
  | "excess_inventory"
  | "supply_demand_mismatch"
  | "missing_supply_inputs"
  | "protected_not_covered"
  | "reserved_not_covered";

export interface IpProjectedInventory {
  id: string;
  planning_run_id: string;
  sku_id: string;
  category_id: string | null;
  period_start: IpIsoDate;
  period_end: IpIsoDate;
  period_code: string;
  beginning_on_hand_qty: number;
  ats_qty: number;
  inbound_receipts_qty: number;
  inbound_po_qty: number;
  // Phase 3 enhancement: bucket-summed Phase 1 planned_buy_qty for
  // (sku, period). Always populated for visibility; only counted
  // into total_available_supply_qty when the run's
  // recon_include_planned_buys flag is true.
  inbound_planned_buy_qty: number;
  wip_qty: number;
  total_available_supply_qty: number;
  wholesale_demand_qty: number;
  ecom_demand_qty: number;
  protected_ecom_qty: number;
  reserved_wholesale_qty: number;
  allocated_total_qty: number;
  allocated_wholesale_qty: number;
  allocated_ecom_qty: number;
  ending_inventory_qty: number;
  shortage_qty: number;
  excess_qty: number;
  projected_stockout_flag: boolean;
  created_at: IpIsoDateTime;
}

export interface IpInventoryRecommendation {
  id: string;
  planning_run_id: string;
  sku_id: string;
  category_id: string | null;
  period_start: IpIsoDate;
  period_end: IpIsoDate;
  period_code: string;
  recommendation_type: IpRecommendationType;
  recommendation_qty: number | null;
  action_reason: string | null;
  priority_level: IpPriorityLevel;
  shortage_qty: number | null;
  excess_qty: number | null;
  service_risk_flag: boolean;
  created_at: IpIsoDateTime;
}

export interface IpAllocationRule {
  id: string;
  rule_name: string;
  rule_type: IpAllocationRuleType;
  priority_rank: number;
  applies_to_customer_id: string | null;
  applies_to_channel_id: string | null;
  applies_to_category_id: string | null;
  applies_to_sku_id: string | null;
  reserve_qty: number | null;
  reserve_percent: number | null;
  protection_flag: boolean;
  note: string | null;
  active: boolean;
  created_at: IpIsoDateTime;
  updated_at: IpIsoDateTime;
}

export interface IpSupplyException {
  id: string;
  planning_run_id: string;
  sku_id: string;
  category_id: string | null;
  period_start: IpIsoDate;
  period_end: IpIsoDate;
  period_code: string;
  exception_type: IpSupplyExceptionType;
  severity: IpPriorityLevel;
  details: Record<string, unknown>;
  created_at: IpIsoDateTime;
}

export interface IpVendorTimingSignal {
  id: string;
  sku_id: string;
  vendor_id: string | null;
  avg_lead_time_days: number | null;
  receipt_variability_days: number | null;
  delay_risk_score: number | null;
  notes: string | null;
  created_at: IpIsoDateTime;
  updated_at: IpIsoDateTime;
}

// ── Compute I/O ────────────────────────────────────────────────────────────
// Supply inputs, pre-bucketed to (sku, period).
export interface SupplyInputsForSku {
  sku_id: string;
  beginning_on_hand_qty: number;
  ats_qty: number;
  inbound_receipts_qty: number;
  inbound_po_qty: number;
  // Phase 3 enhancement: planned_buy_qty bucketed from Phase 1.
  // Counted toward totalAvailableSupply only when the orchestrator
  // sets `count_planned_buys` on the ReconciliationInput (driven by
  // the run's recon_include_planned_buys flag).
  inbound_planned_buy_qty: number;
  wip_qty: number;
}

// Demand inputs at the monthly grain. Ecom weekly rows are rolled up
// before this step.
export interface DemandInputsForSku {
  sku_id: string;
  wholesale_demand_qty: number;
  ecom_demand_qty: number;
  protected_ecom_qty: number;
  // Break-down preserved for the detail drawer.
  wholesale_by_customer: Array<{ customer_id: string; qty: number }>;
  ecom_by_channel: Array<{ channel_id: string; qty: number; protected: number }>;
}

export interface ReconciliationInput {
  planning_run_id: string;
  // A 'month' period. Same helper as Phase 1.
  period_start: IpIsoDate;
  period_end: IpIsoDate;
  period_code: string;
  sku_id: string;
  category_id: string | null;
  supply: SupplyInputsForSku;
  demand: DemandInputsForSku;
  // All active allocation rules that could apply. The compute filters
  // internally by sku / channel / category / customer.
  rules: IpAllocationRule[];
  // Optional — used by the late-PO exception check.
  po_detail?: Array<{ vendor_id: string | null; expected_date: IpIsoDate | null; qty: number }>;
  vendor_timing?: IpVendorTimingSignal[];
  // Phase 3 enhancement: when true, supply.inbound_planned_buy_qty is
  // added into totalAvailableSupply. Defaults to false so existing
  // call sites stay unchanged.
  count_planned_buys?: boolean;
}

export interface AllocationBreakdown {
  reserved_wholesale_qty: number;
  protected_ecom_qty: number;
  allocated_wholesale_qty: number;
  allocated_ecom_qty: number;
  allocated_total_qty: number;
  ending_inventory_qty: number;
  shortage_qty: number;
  excess_qty: number;
  projected_stockout_flag: boolean;
  // Waterfall steps for the detail drawer.
  trace: Array<{ step: string; supply_after: number; note?: string }>;
}

// Grid row the UI renders. Flat shape so the workbench doesn't join
// per-paint.
export interface IpReconciliationGridRow {
  projected_id: string;
  planning_run_id: string;
  sku_id: string;
  sku_code: string;
  sku_description: string | null;
  // Phase 3 grid filter dims pulled from item master so the
  // workbench can scope by Style / Sub Cat / Gender / Cat just like
  // the wholesale grid does. Nullable because not every sku has
  // these attributes set.
  //
  // group_name is the planner's "Cat" field (item.attributes.group_name)
  // — same source the wholesale grid filters on. category_name from
  // the ip_category_master FK is sparse, hence the parallel field.
  sku_style: string | null;
  sku_color: string | null;
  group_name: string | null;
  sub_category_name: string | null;
  gender: string | null;
  category_id: string | null;
  category_name: string | null;
  period_code: string;
  period_start: IpIsoDate;
  period_end: IpIsoDate;
  beginning_on_hand_qty: number;
  ats_qty: number;
  inbound_po_qty: number;
  inbound_planned_buy_qty: number;
  inbound_receipts_qty: number;
  wip_qty: number;
  total_available_supply_qty: number;
  wholesale_demand_qty: number;
  ecom_demand_qty: number;
  protected_ecom_qty: number;
  reserved_wholesale_qty: number;
  allocated_total_qty: number;
  ending_inventory_qty: number;
  shortage_qty: number;
  excess_qty: number;
  projected_stockout_flag: boolean;
  top_recommendation: IpRecommendationType | null;
  top_recommendation_qty: number | null;
  top_recommendation_priority: IpPriorityLevel | null;
  top_recommendation_reason: string | null;
  service_risk_flag: boolean;
}
