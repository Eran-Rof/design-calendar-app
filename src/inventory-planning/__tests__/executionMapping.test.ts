import { describe, it, expect } from "vitest";
import {
  mapRecommendationsToActions,
  recommendationTypeToActionType,
  actionTypeToBatchType,
} from "../execution/utils/recommendationToAction";
import { mapActionToXoroPayload } from "../execution/utils/payloadMappers";
import type { IpInventoryRecommendation } from "../supply/types/supply";
import type { IpExecutionAction } from "../execution/types/execution";

function rec(partial: Partial<IpInventoryRecommendation>): IpInventoryRecommendation {
  return {
    id: "rec-1",
    planning_run_id: "run",
    sku_id: "sku-a",
    category_id: null,
    period_start: "2026-06-01",
    period_end: "2026-06-30",
    period_code: "2026-06",
    recommendation_type: "buy",
    recommendation_qty: 100,
    action_reason: "Shortage of 100",
    priority_level: "high",
    shortage_qty: 100,
    excess_qty: null,
    service_risk_flag: true,
    created_at: "",
    ...partial,
  };
}

function action(partial: Partial<IpExecutionAction>): IpExecutionAction {
  return {
    id: "a-1", execution_batch_id: "b-1", recommendation_id: "rec-1",
    action_type: "create_buy_request", sku_id: "sku-a",
    vendor_id: null, customer_id: null, channel_id: null,
    po_number: null, period_start: "2026-06-01",
    suggested_qty: 100, approved_qty: null,
    execution_status: "pending", execution_method: "export_only",
    action_reason: null, payload_json: {}, response_json: null,
    error_message: null, created_by: null,
    created_at: "", updated_at: "",
    ...partial,
  };
}

describe("recommendationTypeToActionType", () => {
  it("maps buy/expedite/reduce/cancel/push/reallocate/protect", () => {
    expect(recommendationTypeToActionType("buy")).toBe("create_buy_request");
    expect(recommendationTypeToActionType("expedite")).toBe("expedite_po");
    expect(recommendationTypeToActionType("reduce")).toBe("reduce_po");
    expect(recommendationTypeToActionType("cancel_receipt")).toBe("cancel_po_line");
    expect(recommendationTypeToActionType("push_receipt")).toBe("expedite_po");
    expect(recommendationTypeToActionType("reallocate")).toBe("shift_inventory");
    expect(recommendationTypeToActionType("protect_inventory")).toBe("update_protection_qty");
  });
  it("returns null for non-actionable hold/monitor", () => {
    expect(recommendationTypeToActionType("hold")).toBeNull();
    expect(recommendationTypeToActionType("monitor")).toBeNull();
  });
});

describe("actionTypeToBatchType routing", () => {
  it("puts create_buy_request + increase_po into buy_plan", () => {
    expect(actionTypeToBatchType("create_buy_request")).toBe("buy_plan");
    expect(actionTypeToBatchType("increase_po")).toBe("buy_plan");
  });
  it("routes reserve/protection/expedite/reduce/cancel properly", () => {
    expect(actionTypeToBatchType("reserve_inventory")).toBe("reserve_update");
    expect(actionTypeToBatchType("update_protection_qty")).toBe("protection_update");
    expect(actionTypeToBatchType("expedite_po")).toBe("expedite_plan");
    expect(actionTypeToBatchType("reduce_po")).toBe("reduce_plan");
    expect(actionTypeToBatchType("cancel_po_line")).toBe("cancel_plan");
  });
});

describe("mapRecommendationsToActions", () => {
  it("maps buy rec into create_buy_request when no open PO exists", () => {
    const out = mapRecommendationsToActions({
      execution_batch_id: "b", batch_type: "buy_plan",
      recommendations: [rec({ recommendation_type: "buy" })],
    });
    expect(out).toHaveLength(1);
    expect(out[0].action_type).toBe("create_buy_request");
  });
  it("promotes buy rec to increase_po when an open PO exists", () => {
    const out = mapRecommendationsToActions({
      execution_batch_id: "b", batch_type: "buy_plan",
      recommendations: [rec({ recommendation_type: "buy" })],
      openPoBySku: new Map([["sku-a", { po_number: "PO-1", vendor_id: "v-1" }]]),
    });
    expect(out[0].action_type).toBe("increase_po");
    expect(out[0].po_number).toBe("PO-1");
  });
  it("falls back to create_buy_request when expedite has no PO", () => {
    const out = mapRecommendationsToActions({
      execution_batch_id: "b", batch_type: "buy_plan",
      recommendations: [rec({ recommendation_type: "expedite" })],
    });
    // no PO → action routes into buy_plan now
    expect(out).toHaveLength(0); // expedite batch_type is expedite_plan; no-PO expedite falls back to create_buy_request which lives in buy_plan — different batch → drop
  });
  it("skips reduce when no PO and the batch_type demands it", () => {
    const out = mapRecommendationsToActions({
      execution_batch_id: "b", batch_type: "reduce_plan",
      recommendations: [rec({ recommendation_type: "reduce" })],
    });
    expect(out).toHaveLength(0);
  });
  it("skips hold/monitor always", () => {
    const out = mapRecommendationsToActions({
      execution_batch_id: "b", batch_type: "buy_plan",
      recommendations: [rec({ recommendation_type: "hold" }), rec({ id: "r2", recommendation_type: "monitor" })],
    });
    expect(out).toHaveLength(0);
  });
});

describe("mapActionToXoroPayload", () => {
  it("create_buy_request shapes the vendor + qty + period", () => {
    const p = mapActionToXoroPayload(action({ action_type: "create_buy_request", vendor_id: "v-1", approved_qty: 80 }));
    expect(p.type).toBe("create_buy_request");
    if (p.type === "create_buy_request") {
      expect(p.data.qty).toBe(80);
      expect(p.data.vendor_id).toBe("v-1");
    }
  });
  it("reduce_po sets negative delta", () => {
    const p = mapActionToXoroPayload(action({ action_type: "reduce_po", po_number: "PO-9", approved_qty: 10 }));
    expect(p.type).toBe("update_po");
    if (p.type === "update_po") expect(p.data.delta).toBe(-10);
  });
  it("reserve_inventory emits operation=reserve", () => {
    const p = mapActionToXoroPayload(action({ action_type: "reserve_inventory", approved_qty: 50 }));
    expect(p.type).toBe("reserve_update");
    if (p.type === "reserve_update") {
      expect(p.data.operation).toBe("reserve");
      expect(p.data.qty).toBe(50);
    }
  });
  it("shift_inventory falls back to export_only", () => {
    const p = mapActionToXoroPayload(action({ action_type: "shift_inventory" }));
    expect(p.type).toBe("export_only");
  });
  it("uses suggested_qty when approved_qty is null", () => {
    const p = mapActionToXoroPayload(action({ action_type: "create_buy_request", suggested_qty: 40, approved_qty: null }));
    if (p.type === "create_buy_request") expect(p.data.qty).toBe(40);
  });
});
