import { describe, it, expect } from "vitest";
import {
  checkPlanFreshness,
  checkScenarioApproved,
  detectOrphanReferences,
  checkExecutionGate,
  hasBlocking,
} from "../governance/services/planningSafetyService";
import type { IpPlanningRun } from "../types/wholesale";
import type { IpScenario } from "../scenarios/types/scenarios";
import type { IpFreshnessSignal } from "../admin/types/admin";

function run(snapshot: string): IpPlanningRun {
  return {
    id: "r", name: "t", planning_scope: "all", status: "active",
    source_snapshot_date: snapshot,
    horizon_start: null, horizon_end: null,
    note: null, created_by: null,
    created_at: "2026-04-20T00:00:00Z", updated_at: "2026-04-20T00:00:00Z",
  };
}

function scenario(status: IpScenario["status"]): IpScenario {
  return {
    id: "s", planning_run_id: "r", scenario_name: "t",
    scenario_type: "what_if", status,
    base_run_reference_id: null, note: null, created_by: null,
    created_at: "", updated_at: "",
  };
}

function freshness(threshold: number, severity: IpFreshnessSignal["severity"] = "warning"): IpFreshnessSignal {
  return {
    entity_type: "planning_run",
    last_updated_at: null, age_hours: null,
    threshold_hours: threshold,
    severity,
    note: null,
  };
}

describe("checkPlanFreshness", () => {
  it("fresh plan → no issues", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(checkPlanFreshness(run(today), freshness(168))).toHaveLength(0);
  });
  it("stale plan → warning issue", () => {
    expect(checkPlanFreshness(run("2020-01-01"), freshness(168)).length).toBeGreaterThan(0);
  });
  it("critical severity flag promotes", () => {
    const issues = checkPlanFreshness(run("2020-01-01"), freshness(168, "critical"));
    expect(issues[0].severity).toBe("critical");
  });
});

describe("checkScenarioApproved", () => {
  it("approved → no issues", () => {
    expect(checkScenarioApproved(scenario("approved"))).toHaveLength(0);
  });
  it("not approved → critical blocking issue", () => {
    const issues = checkScenarioApproved(scenario("draft"));
    expect(issues[0].severity).toBe("critical");
    expect(hasBlocking(issues)).toBe(true);
  });
  it("null scenario → no issues", () => {
    expect(checkScenarioApproved(null)).toHaveLength(0);
  });
});

describe("detectOrphanReferences", () => {
  it("flags SKUs not in master", () => {
    const out = detectOrphanReferences({
      skuIds: new Set(["a", "b"]),
      knownSkuIds: new Set(["a"]),
      customerIds: new Set(), knownCustomerIds: new Set(),
      channelIds: new Set(), knownChannelIds: new Set(),
    });
    expect(out).toHaveLength(1);
    expect(out[0].code).toBe("orphan_sku");
  });
  it("flags customers + channels independently", () => {
    const out = detectOrphanReferences({
      skuIds: new Set(), knownSkuIds: new Set(),
      customerIds: new Set(["c1"]), knownCustomerIds: new Set(),
      channelIds: new Set(["ch1"]), knownChannelIds: new Set(),
    });
    expect(out.map((i) => i.code).sort()).toEqual(["orphan_channel", "orphan_customer"]);
  });
});

describe("checkExecutionGate composes", () => {
  it("stops when scenario isn't approved", () => {
    const today = new Date().toISOString().slice(0, 10);
    const issues = checkExecutionGate({
      run: run(today), scenario: scenario("draft"), planningFreshness: freshness(168),
    });
    expect(hasBlocking(issues)).toBe(true);
  });
  it("passes when approved + fresh", () => {
    const today = new Date().toISOString().slice(0, 10);
    const issues = checkExecutionGate({
      run: run(today), scenario: scenario("approved"), planningFreshness: freshness(168),
    });
    expect(hasBlocking(issues)).toBe(false);
  });
});
