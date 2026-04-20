// Approval state machine:
//
//   draft → in_review → approved | rejected → archived
//
//   from:          to:
//   draft          → in_review
//   in_review      → approved | rejected | draft (send back)
//   approved       → archived | in_review (reopen)
//   rejected       → draft (revise)
//   archived       → (terminal)
//
// The service just validates the transition, writes the approval row,
// updates the denormalized status on ip_scenarios, and audits.

import type { IpApprovalStatus, IpScenario } from "../types/scenarios";
import { scenarioRepo } from "./scenarioRepo";
import { logChange } from "./auditLogService";

const TRANSITIONS: Record<IpApprovalStatus, IpApprovalStatus[]> = {
  draft:     ["in_review"],
  in_review: ["approved", "rejected", "draft"],
  approved:  ["archived", "in_review"],
  rejected:  ["draft"],
  archived:  [],
};

export function canTransition(from: IpApprovalStatus, to: IpApprovalStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export interface TransitionArgs {
  scenario: IpScenario;
  to: IpApprovalStatus;
  note?: string | null;
  approved_by?: string | null;
}

export async function transitionScenario(args: TransitionArgs): Promise<IpScenario> {
  const { scenario, to, note, approved_by } = args;
  if (!canTransition(scenario.status, to)) {
    throw new Error(`Invalid transition: ${scenario.status} → ${to}`);
  }
  // Record the approval event.
  await scenarioRepo.createApproval({
    planning_run_id: scenario.planning_run_id,
    scenario_id: scenario.id,
    approval_status: to,
    approved_by: approved_by ?? null,
    approved_at: to === "approved" ? new Date().toISOString() : null,
    note: note ?? null,
  });
  // Patch the denormalized status.
  const updated = await scenarioRepo.updateScenario(scenario.id, { status: to });
  await logChange({
    entity_type: "approval",
    entity_id: scenario.id,
    changed_field: "approval_status",
    old_value: scenario.status,
    new_value: to,
    changed_by: approved_by ?? null,
    change_reason: note ?? null,
    planning_run_id: scenario.planning_run_id,
    scenario_id: scenario.id,
  });
  return updated;
}

// Helpful UI guard — approved scenarios should not allow destructive
// edits without a reopen-to-in_review first. The caller decides what
// "edit" means; this helper just answers yes/no.
export function isReadOnly(scenario: IpScenario): boolean {
  return scenario.status === "approved" || scenario.status === "archived";
}
