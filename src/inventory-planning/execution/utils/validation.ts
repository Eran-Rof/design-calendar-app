// Pre-export / pre-submit validation. Returns issues per action so the
// UI can display them, block submission on errors, and warn planners
// about missing optional fields.

import type { ExecutionValidationIssue, IpExecutionAction } from "../types/execution";

export function validateAction(action: IpExecutionAction): ExecutionValidationIssue[] {
  const out: ExecutionValidationIssue[] = [];

  // Non-negative qty
  const qty = action.approved_qty != null ? action.approved_qty : action.suggested_qty;
  if (!(qty > 0) && action.action_type !== "cancel_po_line" && action.action_type !== "release_reserve") {
    out.push({ action_id: action.id, severity: "error", field: "approved_qty", message: "Qty must be > 0" });
  }

  // PO-based actions need a po_number
  const needsPo =
    action.action_type === "increase_po" ||
    action.action_type === "reduce_po" ||
    action.action_type === "cancel_po_line" ||
    action.action_type === "expedite_po";
  if (needsPo && !action.po_number) {
    out.push({ action_id: action.id, severity: "error", field: "po_number", message: "PO number is required for this action type" });
  }

  // Buy requests should have a vendor (warning, not error — operators may
  // assign the vendor downstream).
  if (action.action_type === "create_buy_request" && !action.vendor_id) {
    out.push({ action_id: action.id, severity: "warning", field: "vendor_id", message: "Vendor not assigned — operator will need to pick" });
  }

  // Reserve/release/protection actions need at least one target scope
  const reserveLike = action.action_type === "reserve_inventory"
    || action.action_type === "release_reserve"
    || action.action_type === "update_protection_qty";
  if (reserveLike && !action.customer_id && !action.channel_id) {
    out.push({ action_id: action.id, severity: "warning", field: "customer_id", message: "No customer or channel scope — reserve applies globally" });
  }

  return out;
}

export function validateActions(actions: IpExecutionAction[]): ExecutionValidationIssue[] {
  return actions.flatMap(validateAction);
}

export function hasBlockingErrors(issues: ExecutionValidationIssue[]): boolean {
  return issues.some((i) => i.severity === "error");
}
