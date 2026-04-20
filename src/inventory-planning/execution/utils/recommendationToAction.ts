// Translate Phase 3 recommendations into executable actions.
// Pure. One rec maps to at most one action (or zero for non-actionable
// rec types like hold/monitor).

import type { IpInventoryRecommendation, IpRecommendationType } from "../../supply/types/supply";
import type { IpExecutionAction, IpExecutionActionType, IpExecutionBatchType } from "../types/execution";

// Rec type → action type. `null` means "skip — nothing to execute".
export function recommendationTypeToActionType(r: IpRecommendationType): IpExecutionActionType | null {
  switch (r) {
    case "buy":               return "create_buy_request";
    case "expedite":          return "expedite_po"; // when PO exists; buy otherwise (decided per-row below)
    case "reduce":            return "reduce_po";   // when PO exists; skip otherwise
    case "cancel_receipt":    return "cancel_po_line";
    case "push_receipt":      return "expedite_po"; // actually "push" — same endpoint with a later date
    case "reallocate":        return "shift_inventory";
    case "protect_inventory": return "update_protection_qty";
    case "hold":              return null;
    case "monitor":           return null;
  }
}

// Which batch_type a given action type belongs in.
export function actionTypeToBatchType(a: IpExecutionActionType): IpExecutionBatchType {
  switch (a) {
    case "create_buy_request": return "buy_plan";
    case "increase_po":        return "buy_plan";
    case "reduce_po":          return "reduce_plan";
    case "cancel_po_line":     return "cancel_plan";
    case "expedite_po":        return "expedite_plan";
    case "shift_inventory":    return "reallocation_plan";
    case "reserve_inventory":  return "reserve_update";
    case "release_reserve":    return "reserve_update";
    case "update_protection_qty": return "protection_update";
  }
}

export interface MapRecommendationsInput {
  execution_batch_id: string;
  batch_type: IpExecutionBatchType;
  recommendations: IpInventoryRecommendation[];
  // Per-sku last known open PO — lets the mapper decide between
  // create_buy_request vs increase_po / expedite_po vs create-new.
  openPoBySku?: Map<string, { po_number: string; vendor_id: string | null }>;
}

export function mapRecommendationsToActions(
  input: MapRecommendationsInput,
): Array<Omit<IpExecutionAction, "id" | "created_at" | "updated_at">> {
  const out: Array<Omit<IpExecutionAction, "id" | "created_at" | "updated_at">> = [];
  for (const r of input.recommendations) {
    const baseType = recommendationTypeToActionType(r.recommendation_type);
    if (!baseType) continue;
    // Filter by batch_type: a buy_plan batch includes buy + increase_po
    // actions; an expedite_plan batch only includes expedite / push.
    const bt = actionTypeToBatchType(baseType);
    if (bt !== input.batch_type) {
      // Special cases — buy + increase_po both land in buy_plan already,
      // but if the batch is expedite_plan we still allow buy → expedite
      // mapping when there's no PO. Skipping keeps the MVP simple:
      // operators build one batch per type.
      continue;
    }

    const existingPo = input.openPoBySku?.get(r.sku_id) ?? null;

    // Resolve final action type: if we have an existing PO and the base
    // action targets a PO, that takes priority.
    let action_type: IpExecutionActionType = baseType;
    let po_number: string | null = null;
    let vendor_id: string | null = null;

    if (baseType === "create_buy_request" && existingPo && r.recommendation_type !== "expedite") {
      action_type = "increase_po";
      po_number = existingPo.po_number;
      vendor_id = existingPo.vendor_id;
    } else if ((baseType === "expedite_po" || baseType === "reduce_po" || baseType === "cancel_po_line") && existingPo) {
      po_number = existingPo.po_number;
      vendor_id = existingPo.vendor_id;
    } else if (baseType === "expedite_po" && !existingPo) {
      // No PO to expedite — fall back to create_buy_request so the need
      // is still captured.
      action_type = "create_buy_request";
    } else if (baseType === "reduce_po" && !existingPo) {
      // No PO to reduce — skip. We'd have to log a warning; for MVP we just drop.
      continue;
    }

    out.push({
      execution_batch_id: input.execution_batch_id,
      recommendation_id: r.id,
      action_type,
      sku_id: r.sku_id,
      vendor_id,
      customer_id: null,
      channel_id: null,
      po_number,
      period_start: r.period_start,
      suggested_qty: r.recommendation_qty ?? 0,
      approved_qty: null,
      execution_status: "pending",
      execution_method: "export_only",
      action_reason: r.action_reason,
      payload_json: {},
      response_json: null,
      error_message: null,
      created_by: null,
    });
  }
  return out;
}
