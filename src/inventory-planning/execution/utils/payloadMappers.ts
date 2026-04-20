// Maps an internal execution action into the payload an ERP writeback
// endpoint would accept. Pure, tested, isolated from UI.
//
// For Phase 6 the Xoro writeback endpoints are stubs — the mappers still
// produce complete payloads so the dry-run flow and the exported xlsx can
// surface what would be sent.

import type { IpExecutionAction, IpExecutionActionType } from "../types/execution";

export interface XoroCreateBuyRequestPayload {
  vendor_id: string | null;
  sku_id: string;
  qty: number;
  period_start: string | null;
  reason: string | null;
}
export interface XoroUpdatePoPayload {
  po_number: string;
  sku_id: string;
  new_qty: number;       // absolute qty after the update
  delta: number;         // signed delta for auditability
  reason: string | null;
}
export interface XoroCancelPoLinePayload {
  po_number: string;
  sku_id: string;
  reason: string | null;
}
export interface XoroExpeditePoPayload {
  po_number: string;
  sku_id: string;
  new_expected_date: string | null;
  reason: string | null;
}
export interface XoroReserveUpdatePayload {
  sku_id: string;
  customer_id: string | null;
  channel_id: string | null;
  qty: number;
  operation: "reserve" | "release" | "set_protection";
  reason: string | null;
}

export type XoroPayload =
  | { type: "create_buy_request"; data: XoroCreateBuyRequestPayload }
  | { type: "update_po"; data: XoroUpdatePoPayload }
  | { type: "cancel_po_line"; data: XoroCancelPoLinePayload }
  | { type: "expedite_po"; data: XoroExpeditePoPayload }
  | { type: "reserve_update"; data: XoroReserveUpdatePayload }
  | { type: "export_only"; data: { action_type: IpExecutionActionType; sku_id: string; qty: number; reason: string | null } };

function approvedQtyOrSuggested(a: IpExecutionAction): number {
  return a.approved_qty != null ? a.approved_qty : a.suggested_qty;
}

export function mapActionToXoroPayload(action: IpExecutionAction): XoroPayload {
  const qty = approvedQtyOrSuggested(action);
  const reason = action.action_reason;

  switch (action.action_type) {
    case "create_buy_request":
      return {
        type: "create_buy_request",
        data: {
          vendor_id: action.vendor_id,
          sku_id: action.sku_id,
          qty,
          period_start: action.period_start,
          reason,
        },
      };
    case "increase_po":
      return {
        type: "update_po",
        data: {
          po_number: action.po_number ?? "",
          sku_id: action.sku_id,
          new_qty: qty,
          delta: qty, // positive delta — the qty is the increase
          reason,
        },
      };
    case "reduce_po":
      return {
        type: "update_po",
        data: {
          po_number: action.po_number ?? "",
          sku_id: action.sku_id,
          new_qty: qty,
          delta: -qty, // signed for audit
          reason,
        },
      };
    case "cancel_po_line":
      return {
        type: "cancel_po_line",
        data: {
          po_number: action.po_number ?? "",
          sku_id: action.sku_id,
          reason,
        },
      };
    case "expedite_po":
      return {
        type: "expedite_po",
        data: {
          po_number: action.po_number ?? "",
          sku_id: action.sku_id,
          new_expected_date: action.period_start, // target period start as the new land-by date
          reason,
        },
      };
    case "reserve_inventory":
      return {
        type: "reserve_update",
        data: {
          sku_id: action.sku_id,
          customer_id: action.customer_id,
          channel_id: action.channel_id,
          qty,
          operation: "reserve",
          reason,
        },
      };
    case "release_reserve":
      return {
        type: "reserve_update",
        data: {
          sku_id: action.sku_id,
          customer_id: action.customer_id,
          channel_id: action.channel_id,
          qty,
          operation: "release",
          reason,
        },
      };
    case "update_protection_qty":
      return {
        type: "reserve_update",
        data: {
          sku_id: action.sku_id,
          customer_id: action.customer_id,
          channel_id: action.channel_id,
          qty,
          operation: "set_protection",
          reason,
        },
      };
    case "shift_inventory":
      // No safe Xoro endpoint for this — export-only.
      return {
        type: "export_only",
        data: { action_type: action.action_type, sku_id: action.sku_id, qty, reason },
      };
  }
}
