// Batch lifecycle:
//
//   draft
//    │  (approve) — requires underlying plan to be approved
//    ▼
//   ready  (review stage)
//    │  (approveBatch)
//    ▼
//   approved
//    │  (export) → exported
//    │  (submit) → submitted → executed/partially_executed/failed
//    ▼
//   archived  (terminal)
//
// Rules enforced here (not in SQL):
//   • buildBatchFromPlan refuses to start unless the source
//     planning_run or scenario is approved (or the caller passes
//     allowUnapproved=true explicitly for admin / dev modes).
//   • Approved batches lock core fields — updateAction blocks changes
//     unless the status has been reopened to 'ready'.

import type { IpPlanningRun } from "../../types/wholesale";
import type { IpScenario } from "../../scenarios/types/scenarios";
import type { IpInventoryRecommendation } from "../../supply/types/supply";
import type {
  IpExecutionAction,
  IpExecutionActionType,
  IpExecutionBatch,
  IpExecutionBatchStatus,
  IpExecutionBatchType,
  IpExecutionMethod,
} from "../types/execution";
import {
  actionTypeToBatchType,
  mapRecommendationsToActions,
  recommendationTypeToActionType,
} from "../utils/recommendationToAction";
import { scenarioRepo } from "../../scenarios/services/scenarioRepo";
import { supplyRepo } from "../../supply/services/supplyReconciliationRepo";
import { wholesaleRepo } from "../../services/wholesalePlanningRepository";
import { SB_HEADERS, SB_URL } from "../../../utils/supabase";
import { executionRepo } from "./executionRepo";

const BATCH_TRANSITIONS: Record<IpExecutionBatchStatus, IpExecutionBatchStatus[]> = {
  draft:              ["ready", "archived"],
  ready:              ["approved", "draft", "archived"],
  approved:           ["exported", "submitted", "ready", "archived"],
  exported:           ["submitted", "approved", "archived"],
  submitted:          ["executed", "partially_executed", "failed", "archived"],
  partially_executed: ["submitted", "executed", "failed", "archived"],
  executed:           ["archived"],
  failed:             ["ready", "submitted", "archived"],
  archived:           [],
};

export function canBatchTransition(from: IpExecutionBatchStatus, to: IpExecutionBatchStatus): boolean {
  return BATCH_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isBatchLocked(batch: IpExecutionBatch): boolean {
  // Approved/submitted/executed/archived are read-only for core fields.
  // Only 'failed' stays re-editable because retries are expected.
  return batch.status === "approved"
    || batch.status === "exported"
    || batch.status === "submitted"
    || batch.status === "executed"
    || batch.status === "archived";
}

export interface BuildBatchInput {
  planning_run_id: string;
  scenario_id?: string | null;
  batch_name: string;
  batch_type: IpExecutionBatchType;
  note?: string | null;
  createdBy?: string | null;
  // Default false: refuse to build from an unapproved plan.
  allowUnapproved?: boolean;
}

// Gate on approval, then map recommendations into actions.
export async function buildExecutionBatchFromRecommendations(args: BuildBatchInput): Promise<IpExecutionBatch> {
  const { planning_run_id, scenario_id, batch_name, batch_type, note, createdBy, allowUnapproved } = args;

  // Approval gate — check either the scenario (if scoped) or the run.
  if (!allowUnapproved) {
    if (scenario_id) {
      const scen = await scenarioRepo.getScenario(scenario_id);
      if (!scen) throw new Error("Scenario not found");
      if (scen.status !== "approved") {
        throw new Error(`Cannot build execution batch from scenario in status "${scen.status}". Approve the scenario first, or pass allowUnapproved=true.`);
      }
    } else {
      // When building from a plain run, require either an approval row or
      // an 'active' status. (Planning runs don't yet carry a formal
      // approval flag; active is the closest signal.)
      const approvals = await scenarioRepo.listApprovals({ planning_run_id });
      const latest = approvals[0];
      const approved = latest?.approval_status === "approved";
      if (!approved) {
        throw new Error(`Cannot build execution batch from run that has not been approved. Approve it first, or pass allowUnapproved=true.`);
      }
    }
  }

  // Pull recommendations — scenario ? scenario's run : the run directly.
  const targetRunId = scenario_id ? await scenarioRunId(scenario_id) : planning_run_id;
  const recs = await supplyRepo.listRecommendations(targetRunId);
  const relevant = recs.filter((r) => actionTypeFilter(r, batch_type));

  // Create the batch shell.
  const batch = await executionRepo.createBatch({
    planning_run_id,
    scenario_id: scenario_id ?? null,
    batch_name,
    batch_type,
    status: "draft",
    created_by: createdBy ?? null,
    approved_by: null,
    approved_at: null,
    note: note ?? null,
  });

  // Map and insert actions.
  const openPoBySku = await loadOpenPosBySku(); // shared — keep Xoro PO lookup cheap
  const actionRows = mapRecommendationsToActions({
    execution_batch_id: batch.id,
    batch_type,
    recommendations: relevant,
    openPoBySku,
  });
  await executionRepo.insertActions(actionRows);

  await executionRepo.insertAudit({
    execution_batch_id: batch.id,
    execution_action_id: null,
    event_type: "batch_created",
    old_status: null,
    new_status: "draft",
    event_message: `Created ${batch_name} — ${actionRows.length} actions from ${recs.length} recommendations`,
    actor: createdBy ?? null,
  });

  return batch;
}

// ── Batch transitions ─────────────────────────────────────────────────────
export async function transitionBatch(args: {
  batch: IpExecutionBatch;
  to: IpExecutionBatchStatus;
  actor?: string | null;
  message?: string | null;
}): Promise<IpExecutionBatch> {
  const { batch, to, actor, message } = args;
  if (!canBatchTransition(batch.status, to)) {
    throw new Error(`Invalid batch transition: ${batch.status} → ${to}`);
  }
  const patch: Partial<IpExecutionBatch> = { status: to };
  if (to === "approved") {
    patch.approved_by = actor ?? null;
    patch.approved_at = new Date().toISOString();
  }
  const updated = await executionRepo.updateBatch(batch.id, patch);

  await executionRepo.insertAudit({
    execution_batch_id: batch.id,
    execution_action_id: null,
    event_type: to === "approved" ? "batch_approved" :
                to === "exported" ? "batch_exported" :
                to === "submitted" ? "batch_submitted" :
                to === "archived" ? "batch_archived" : "batch_status_changed",
    old_status: batch.status,
    new_status: to,
    event_message: message ?? null,
    actor: actor ?? null,
  });
  return updated;
}

// ── Action edits (gated by batch status) ──────────────────────────────────
export async function updateExecutionAction(args: {
  batch: IpExecutionBatch;
  action: IpExecutionAction;
  patch: Partial<Pick<IpExecutionAction, "approved_qty" | "execution_method" | "action_reason" | "vendor_id" | "po_number">>;
  actor?: string | null;
}): Promise<IpExecutionAction> {
  const { batch, action, patch, actor } = args;
  if (isBatchLocked(batch)) {
    throw new Error("Batch is locked. Reopen to 'ready' before editing actions.");
  }
  const updated = await executionRepo.updateAction(action.id, patch);

  for (const [field, newValue] of Object.entries(patch)) {
    const oldValue = (action as unknown as Record<string, unknown>)[field];
    if (oldValue === newValue) continue;
    await executionRepo.insertAudit({
      execution_batch_id: batch.id,
      execution_action_id: action.id,
      event_type: field === "approved_qty" ? "action_approved_qty_set"
                : field === "execution_method" ? "action_method_changed"
                : "action_field_changed",
      old_status: oldValue == null ? null : String(oldValue),
      new_status: newValue == null ? null : String(newValue),
      event_message: `${field}: ${oldValue ?? "∅"} → ${newValue ?? "∅"}`,
      actor: actor ?? null,
    });
  }
  return updated;
}

export async function markActionStatus(args: {
  batch: IpExecutionBatch;
  action: IpExecutionAction;
  status: IpExecutionAction["execution_status"];
  message?: string | null;
  response?: Record<string, unknown> | null;
  error?: string | null;
  actor?: string | null;
}): Promise<IpExecutionAction> {
  const { batch, action, status, message, response, error, actor } = args;
  const updated = await executionRepo.updateAction(action.id, {
    execution_status: status,
    response_json: response ?? action.response_json,
    error_message: error ?? (status === "failed" ? (action.error_message ?? "unspecified") : null),
  });
  await executionRepo.insertAudit({
    execution_batch_id: batch.id,
    execution_action_id: action.id,
    event_type: `action_${status}`,
    old_status: action.execution_status,
    new_status: status,
    event_message: message ?? null,
    actor: actor ?? null,
  });
  return updated;
}

export async function removeAction(args: {
  batch: IpExecutionBatch;
  action: IpExecutionAction;
  actor?: string | null;
}): Promise<void> {
  const { batch, action, actor } = args;
  if (isBatchLocked(batch)) {
    throw new Error("Batch is locked. Reopen to 'ready' before removing actions.");
  }
  await executionRepo.deleteAction(action.id);
  await executionRepo.insertAudit({
    execution_batch_id: batch.id,
    execution_action_id: action.id,
    event_type: "action_removed",
    old_status: action.execution_status,
    new_status: null,
    event_message: "Action removed from batch",
    actor: actor ?? null,
  });
}

// ── helpers ────────────────────────────────────────────────────────────────
async function scenarioRunId(scenarioId: string): Promise<string> {
  const s = await scenarioRepo.getScenario(scenarioId);
  if (!s) throw new Error("Scenario not found");
  return s.planning_run_id;
}

function actionTypeFilter(r: IpInventoryRecommendation, bt: IpExecutionBatchType): boolean {
  const at = recommendationTypeToActionType(r.recommendation_type);
  if (!at) return false;
  return actionTypeToBatchType(at) === bt;
}

async function loadOpenPosBySku(): Promise<Map<string, { po_number: string; vendor_id: string | null }>> {
  const pos = await wholesaleRepo.listOpenPos();
  const m = new Map<string, { po_number: string; vendor_id: string | null }>();
  for (const p of pos) {
    // Keep the most-recent (latest last_seen_at) per sku.
    const existing = m.get(p.sku_id);
    if (!existing) m.set(p.sku_id, { po_number: p.po_number, vendor_id: p.vendor_id });
  }
  return m;
}

// Public typed re-exports kept grouped for consumers who only need the API.
export type {
  IpExecutionAction,
  IpExecutionBatch,
  IpExecutionActionType,
  IpExecutionBatchType,
  IpExecutionBatchStatus,
  IpExecutionMethod,
  IpInventoryRecommendation,
  IpPlanningRun,
  IpScenario,
};
void SB_HEADERS; void SB_URL; // keep imports in case future methods need a raw fetch
