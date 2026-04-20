import { describe, it, expect } from "vitest";
import { canTransition, isReadOnly } from "../scenarios/services/approvalService";
import type { IpScenario } from "../scenarios/types/scenarios";

function scenario(status: IpScenario["status"]): IpScenario {
  return {
    id: "s", planning_run_id: "r", scenario_name: "t", scenario_type: "what_if",
    status, base_run_reference_id: null, note: null, created_by: null,
    created_at: "", updated_at: "",
  };
}

describe("canTransition", () => {
  it("draft → in_review allowed; draft → approved forbidden", () => {
    expect(canTransition("draft", "in_review")).toBe(true);
    expect(canTransition("draft", "approved")).toBe(false);
  });
  it("in_review → approved/rejected/draft", () => {
    expect(canTransition("in_review", "approved")).toBe(true);
    expect(canTransition("in_review", "rejected")).toBe(true);
    expect(canTransition("in_review", "draft")).toBe(true);
    expect(canTransition("in_review", "archived")).toBe(false);
  });
  it("approved → archived or reopen to in_review", () => {
    expect(canTransition("approved", "archived")).toBe(true);
    expect(canTransition("approved", "in_review")).toBe(true);
    expect(canTransition("approved", "draft")).toBe(false);
  });
  it("rejected → draft to revise", () => {
    expect(canTransition("rejected", "draft")).toBe(true);
    expect(canTransition("rejected", "approved")).toBe(false);
  });
  it("archived is terminal", () => {
    expect(canTransition("archived", "in_review")).toBe(false);
    expect(canTransition("archived", "draft")).toBe(false);
  });
});

describe("isReadOnly", () => {
  it("draft/in_review/rejected are editable", () => {
    expect(isReadOnly(scenario("draft"))).toBe(false);
    expect(isReadOnly(scenario("in_review"))).toBe(false);
    expect(isReadOnly(scenario("rejected"))).toBe(false);
  });
  it("approved/archived are read-only", () => {
    expect(isReadOnly(scenario("approved"))).toBe(true);
    expect(isReadOnly(scenario("archived"))).toBe(true);
  });
});
