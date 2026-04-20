// Phase 6 — execution types.
// Mirror SQL in 20260420100000_inventory_planning_phase6.sql.

import type { IpIsoDate, IpIsoDateTime } from "../../types/entities";

export type IpExecutionBatchType =
  | "buy_plan"
  | "expedite_plan"
  | "reduce_plan"
  | "cancel_plan"
  | "reserve_update"
  | "protection_update"
  | "reallocation_plan";

export type IpExecutionBatchStatus =
  | "draft" | "ready" | "approved" | "exported" | "submitted"
  | "partially_executed" | "executed" | "failed" | "archived";

export type IpExecutionActionType =
  | "create_buy_request" | "increase_po" | "reduce_po" | "cancel_po_line"
  | "expedite_po" | "shift_inventory" | "reserve_inventory"
  | "release_reserve" | "update_protection_qty";

export type IpExecutionActionStatus =
  | "pending" | "approved" | "exported" | "submitted"
  | "succeeded" | "failed" | "cancelled";

export type IpExecutionMethod = "export_only" | "manual_erp_entry" | "api_writeback";

export interface IpExecutionBatch {
  id: string;
  planning_run_id: string;
  scenario_id: string | null;
  batch_name: string;
  batch_type: IpExecutionBatchType;
  status: IpExecutionBatchStatus;
  created_by: string | null;
  approved_by: string | null;
  approved_at: IpIsoDateTime | null;
  note: string | null;
  created_at: IpIsoDateTime;
  updated_at: IpIsoDateTime;
}

export interface IpExecutionAction {
  id: string;
  execution_batch_id: string;
  recommendation_id: string | null;
  action_type: IpExecutionActionType;
  sku_id: string;
  vendor_id: string | null;
  customer_id: string | null;
  channel_id: string | null;
  po_number: string | null;
  period_start: IpIsoDate | null;
  suggested_qty: number;
  approved_qty: number | null;
  execution_status: IpExecutionActionStatus;
  execution_method: IpExecutionMethod;
  action_reason: string | null;
  payload_json: Record<string, unknown>;
  response_json: Record<string, unknown> | null;
  error_message: string | null;
  created_by: string | null;
  created_at: IpIsoDateTime;
  updated_at: IpIsoDateTime;
}

export interface IpExecutionAuditEntry {
  id: string;
  execution_batch_id: string;
  execution_action_id: string | null;
  event_type: string;
  old_status: string | null;
  new_status: string | null;
  event_message: string | null;
  actor: string | null;
  created_at: IpIsoDateTime;
}

export interface IpErpWritebackConfig {
  id: string;
  system_name: string;
  action_type: IpExecutionActionType;
  enabled: boolean;
  approval_required: boolean;
  dry_run_default: boolean;
  endpoint_reference: string | null;
  note: string | null;
  created_at: IpIsoDateTime;
  updated_at: IpIsoDateTime;
}

export interface IpActionTemplate {
  id: string;
  template_name: string;
  action_type: IpExecutionActionType;
  payload_template_json: Record<string, unknown>;
  active: boolean;
  created_at: IpIsoDateTime;
  updated_at: IpIsoDateTime;
}

// ── Writeback I/O ─────────────────────────────────────────────────────────
export interface WritebackResult {
  action_id: string;
  ok: boolean;
  dry_run: boolean;
  status: IpExecutionActionStatus;
  message: string;
  response?: Record<string, unknown>;
}

// Validation issues surfaced per-action before export/submit.
export interface ExecutionValidationIssue {
  action_id: string;
  severity: "error" | "warning";
  field: string | null;
  message: string;
}
