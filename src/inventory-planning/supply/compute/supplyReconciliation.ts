// Core reconciliation math. Pure — no IO. The service layer gathers
// inputs and feeds this.
//
// Key formula (kept visible so anyone can verify a cell in the grid):
//
//   total_available_supply_qty =
//     available_qty + inbound_receipts_qty + inbound_po_qty + wip_qty
//
//   where available_qty =
//     ats_qty  (month 1 — snapshot value, net of existing SO commitments)
//     OR beginning_on_hand_qty  (months 2+ — rolled ending balance, already net)
//
//   Using ATS rather than raw on_hand ensures inventory already committed to
//   existing SOs is not double-counted against new forecasted demand.
//
// The allocation waterfall is handled by allocationEngine.ts; this
// module just supplies the inputs and computes derived fields.

import type {
  DemandInputsForSku,
  IpAllocationRule,
  IpProjectedInventory,
  ReconciliationInput,
  SupplyInputsForSku,
} from "../types/supply";
import { computeAllocation } from "./allocationEngine";

export function totalAvailableSupply(s: SupplyInputsForSku): number {
  const safe = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
  // Month 1: ats_qty is set from the Xoro snapshot (net of existing SO commitments).
  // Months 2+: ats_qty is 0 and beginning_on_hand_qty is the rolled ending balance,
  // which is already net. Either way we pick the right available figure.
  const onHand = s.ats_qty > 0 ? safe(s.ats_qty) : safe(s.beginning_on_hand_qty);
  return (
    onHand +
    safe(s.inbound_receipts_qty) +
    safe(s.inbound_po_qty) +
    safe(s.wip_qty)
  );
}

export function totalDemand(d: DemandInputsForSku): number {
  const safe = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
  return safe(d.wholesale_demand_qty) + safe(d.ecom_demand_qty);
}

export function buildProjectedInventory(
  input: ReconciliationInput,
): Omit<IpProjectedInventory, "id" | "created_at"> {
  const supply = input.supply;
  const demand = input.demand;
  const totalSupply = totalAvailableSupply(supply);
  const alloc = computeAllocation(totalSupply, demand, input.rules);
  return {
    planning_run_id: input.planning_run_id,
    sku_id: input.sku_id,
    category_id: input.category_id,
    period_start: input.period_start,
    period_end: input.period_end,
    period_code: input.period_code,
    beginning_on_hand_qty: Math.max(0, supply.beginning_on_hand_qty),
    ats_qty: Math.max(0, supply.ats_qty),
    inbound_receipts_qty: Math.max(0, supply.inbound_receipts_qty),
    inbound_po_qty: Math.max(0, supply.inbound_po_qty),
    wip_qty: Math.max(0, supply.wip_qty),
    total_available_supply_qty: totalSupply,
    wholesale_demand_qty: Math.max(0, demand.wholesale_demand_qty),
    ecom_demand_qty: Math.max(0, demand.ecom_demand_qty),
    protected_ecom_qty: alloc.protected_ecom_qty,
    reserved_wholesale_qty: alloc.reserved_wholesale_qty,
    allocated_total_qty: alloc.allocated_total_qty,
    allocated_wholesale_qty: alloc.allocated_wholesale_qty,
    allocated_ecom_qty: alloc.allocated_ecom_qty,
    ending_inventory_qty: alloc.ending_inventory_qty,
    shortage_qty: alloc.shortage_qty,
    excess_qty: alloc.excess_qty,
    projected_stockout_flag: alloc.projected_stockout_flag,
  };
}

// Convenience: sum supply inputs with guards. Exposed for the service
// layer unit tests.
export function mergeSupply(a: SupplyInputsForSku, b: SupplyInputsForSku): SupplyInputsForSku {
  return {
    sku_id: a.sku_id,
    beginning_on_hand_qty: a.beginning_on_hand_qty + b.beginning_on_hand_qty,
    ats_qty: a.ats_qty + b.ats_qty,
    inbound_receipts_qty: a.inbound_receipts_qty + b.inbound_receipts_qty,
    inbound_po_qty: a.inbound_po_qty + b.inbound_po_qty,
    wip_qty: a.wip_qty + b.wip_qty,
  };
}

// Active rules that could apply to a given (sku, category) — the
// channel/customer filter happens inside the allocation engine based on
// the demand breakdown.
export function activeRulesForSku(
  rules: IpAllocationRule[],
  skuId: string,
  categoryId: string | null,
): IpAllocationRule[] {
  return rules.filter((r) => {
    if (!r.active) return false;
    if (r.applies_to_sku_id && r.applies_to_sku_id !== skuId) return false;
    if (r.applies_to_category_id && r.applies_to_category_id !== categoryId) return false;
    return true;
  });
}
