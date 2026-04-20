import { describe, it, expect } from "vitest";
import { validateAction, validateActions, hasBlockingErrors } from "../execution/utils/validation";
import type { IpExecutionAction } from "../execution/types/execution";

function action(partial: Partial<IpExecutionAction>): IpExecutionAction {
  return {
    id: "a-1", execution_batch_id: "b-1", recommendation_id: null,
    action_type: "create_buy_request", sku_id: "sku-a",
    vendor_id: null, customer_id: null, channel_id: null,
    po_number: null, period_start: null,
    suggested_qty: 100, approved_qty: null,
    execution_status: "pending", execution_method: "export_only",
    action_reason: null, payload_json: {}, response_json: null,
    error_message: null, created_by: null,
    created_at: "", updated_at: "",
    ...partial,
  };
}

describe("validateAction", () => {
  it("buy with no vendor → warning (not error)", () => {
    const issues = validateAction(action({ action_type: "create_buy_request", approved_qty: 50 }));
    expect(issues.some((i) => i.severity === "warning" && i.field === "vendor_id")).toBe(true);
    expect(hasBlockingErrors(issues)).toBe(false);
  });
  it("increase_po with no po_number → blocking error", () => {
    const issues = validateAction(action({ action_type: "increase_po", approved_qty: 50 }));
    expect(issues.some((i) => i.severity === "error" && i.field === "po_number")).toBe(true);
    expect(hasBlockingErrors(issues)).toBe(true);
  });
  it("cancel_po_line tolerates zero qty (no qty > 0 requirement)", () => {
    const issues = validateAction(action({ action_type: "cancel_po_line", po_number: "PO-1", approved_qty: 0 }));
    expect(hasBlockingErrors(issues)).toBe(false);
  });
  it("qty ≤ 0 blocks buy", () => {
    const issues = validateAction(action({ action_type: "create_buy_request", vendor_id: "v-1", approved_qty: 0 }));
    expect(hasBlockingErrors(issues)).toBe(true);
  });
  it("reserve with no scope → warning only", () => {
    const issues = validateAction(action({ action_type: "reserve_inventory", approved_qty: 50 }));
    expect(issues.some((i) => i.severity === "warning")).toBe(true);
    expect(hasBlockingErrors(issues)).toBe(false);
  });
});

describe("validateActions + hasBlockingErrors", () => {
  it("aggregates across many actions", () => {
    const issues = validateActions([
      action({ id: "a1", action_type: "increase_po" }),                                // error (no po_number + 0)
      action({ id: "a2", action_type: "create_buy_request", vendor_id: "v", approved_qty: 100 }), // clean
    ]);
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(hasBlockingErrors(issues)).toBe(true);
  });
});
