// Small facade over the audit log so callers don't repeat the full row
// shape. Fire-and-forget — audit failures never break the parent write.

import type { IpAuditEntityType, IpChangeAuditLog } from "../types/scenarios";
import { scenarioRepo } from "./scenarioRepo";

export async function logChange(params: {
  entity_type: IpAuditEntityType;
  entity_id?: string | null;
  changed_field?: string | null;
  old_value?: unknown;
  new_value?: unknown;
  changed_by?: string | null;
  change_reason?: string | null;
  planning_run_id?: string | null;
  scenario_id?: string | null;
}): Promise<void> {
  try {
    const row: Omit<IpChangeAuditLog, "id" | "created_at"> = {
      entity_type: params.entity_type,
      entity_id: params.entity_id ?? null,
      changed_field: params.changed_field ?? null,
      old_value: params.old_value == null ? null : String(params.old_value),
      new_value: params.new_value == null ? null : String(params.new_value),
      changed_by: params.changed_by ?? null,
      change_reason: params.change_reason ?? null,
      planning_run_id: params.planning_run_id ?? null,
      scenario_id: params.scenario_id ?? null,
    };
    await scenarioRepo.createAudit(row);
  } catch {
    // swallow — audit is advisory, never block a write on its failure
  }
}
