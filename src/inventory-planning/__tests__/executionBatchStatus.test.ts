import { describe, it, expect } from "vitest";
import { canBatchTransition, isBatchLocked } from "../execution/services/executionBatchService";
import { isBatchSubmittable } from "../execution/services/executionWritebackService";
import type { IpExecutionBatch, IpExecutionBatchStatus } from "../execution/types/execution";

function batch(status: IpExecutionBatchStatus): IpExecutionBatch {
  return {
    id: "b", planning_run_id: "r", scenario_id: null,
    batch_name: "t", batch_type: "buy_plan",
    status,
    created_by: null, approved_by: null, approved_at: null, note: null,
    created_at: "", updated_at: "",
  };
}

describe("canBatchTransition", () => {
  it("draft → ready; ready → approved; approved → exported/submitted/ready", () => {
    expect(canBatchTransition("draft", "ready")).toBe(true);
    expect(canBatchTransition("ready", "approved")).toBe(true);
    expect(canBatchTransition("approved", "exported")).toBe(true);
    expect(canBatchTransition("approved", "submitted")).toBe(true);
    expect(canBatchTransition("approved", "ready")).toBe(true);
  });
  it("archived is terminal", () => {
    expect(canBatchTransition("archived", "ready")).toBe(false);
  });
  it("submitted → executed/partially_executed/failed", () => {
    expect(canBatchTransition("submitted", "executed")).toBe(true);
    expect(canBatchTransition("submitted", "partially_executed")).toBe(true);
    expect(canBatchTransition("submitted", "failed")).toBe(true);
  });
  it("failed is re-editable (ready/submitted again)", () => {
    expect(canBatchTransition("failed", "ready")).toBe(true);
    expect(canBatchTransition("failed", "submitted")).toBe(true);
  });
});

describe("isBatchLocked", () => {
  it("approved/exported/submitted/executed/archived lock edits", () => {
    expect(isBatchLocked(batch("approved"))).toBe(true);
    expect(isBatchLocked(batch("exported"))).toBe(true);
    expect(isBatchLocked(batch("submitted"))).toBe(true);
    expect(isBatchLocked(batch("executed"))).toBe(true);
    expect(isBatchLocked(batch("archived"))).toBe(true);
  });
  it("draft/ready/failed remain editable", () => {
    expect(isBatchLocked(batch("draft"))).toBe(false);
    expect(isBatchLocked(batch("ready"))).toBe(false);
    expect(isBatchLocked(batch("failed"))).toBe(false);
  });
});

describe("isBatchSubmittable", () => {
  it("only approved or exported can be submitted for writeback", () => {
    expect(isBatchSubmittable(batch("approved"))).toBe(true);
    expect(isBatchSubmittable(batch("exported"))).toBe(true);
    expect(isBatchSubmittable(batch("draft"))).toBe(false);
    expect(isBatchSubmittable(batch("submitted"))).toBe(false);
  });
});
