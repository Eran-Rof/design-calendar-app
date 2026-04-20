// Consistency and safety checks called before sensitive operations.
// Pure-ish (no IO in the rule evaluators). The caller loads the signals
// once and passes them in — keeps the functions deterministic and
// cheap to unit test.

import type { IpPlanningRun } from "../../types/wholesale";
import type { IpScenario } from "../../scenarios/types/scenarios";
import type { IpFreshnessSignal } from "../../admin/types/admin";

export interface SafetyIssue {
  severity: "info" | "warning" | "critical";
  code: string;
  message: string;
  hint?: string;
}

const HOURS = 1000 * 60 * 60;

function ageHours(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / HOURS;
}

// Plan about to be used for execution — is it fresh enough?
export function checkPlanFreshness(
  run: IpPlanningRun,
  planningFreshness: IpFreshnessSignal | null,
): SafetyIssue[] {
  const issues: SafetyIssue[] = [];
  const age = ageHours(run.source_snapshot_date);
  const threshold = planningFreshness?.threshold_hours ?? 168;
  if (age != null && age > threshold) {
    issues.push({
      severity: planningFreshness?.severity === "critical" ? "critical" : "warning",
      code: "stale_plan",
      message: `Plan snapshot is ${Math.round(age)}h old (threshold ${threshold}h).`,
      hint: "Refresh the plan before executing.",
    });
  }
  return issues;
}

// Scenario about to be executed — must be approved (unless override).
export function checkScenarioApproved(scenario: IpScenario | null): SafetyIssue[] {
  if (!scenario) return [];
  if (scenario.status !== "approved") {
    return [{
      severity: "critical",
      code: "scenario_not_approved",
      message: `Scenario status is "${scenario.status}" — only approved scenarios should drive execution.`,
      hint: "Approve the scenario or pass allowUnapproved=true for admin override.",
    }];
  }
  return [];
}

// Basic orphan checks — called before recompute.
export interface OrphanCheckInput {
  skuIds: Set<string>;            // active SKUs in the plan
  knownSkuIds: Set<string>;       // SKUs present in ip_item_master
  customerIds: Set<string>;
  knownCustomerIds: Set<string>;
  channelIds: Set<string>;
  knownChannelIds: Set<string>;
}

export function detectOrphanReferences(input: OrphanCheckInput): SafetyIssue[] {
  const issues: SafetyIssue[] = [];
  for (const s of input.skuIds) {
    if (!input.knownSkuIds.has(s)) {
      issues.push({ severity: "warning", code: "orphan_sku", message: `SKU ${s.slice(0, 8)} referenced by plan but not in item_master.` });
    }
  }
  for (const c of input.customerIds) {
    if (!input.knownCustomerIds.has(c)) {
      issues.push({ severity: "warning", code: "orphan_customer", message: `Customer ${c.slice(0, 8)} referenced but not in customer_master.` });
    }
  }
  for (const c of input.channelIds) {
    if (!input.knownChannelIds.has(c)) {
      issues.push({ severity: "warning", code: "orphan_channel", message: `Channel ${c.slice(0, 8)} referenced but not in channel_master.` });
    }
  }
  return issues;
}

// "Are we OK to build an execution batch from this plan?" — caller-side
// aggregation of the individual checks.
export function checkExecutionGate(args: {
  run: IpPlanningRun;
  scenario?: IpScenario | null;
  planningFreshness: IpFreshnessSignal | null;
}): SafetyIssue[] {
  return [
    ...checkPlanFreshness(args.run, args.planningFreshness),
    ...checkScenarioApproved(args.scenario ?? null),
  ];
}

export function hasBlocking(issues: SafetyIssue[]): boolean {
  return issues.some((i) => i.severity === "critical");
}
