// Exception engine: emits typed rows for the exception panel. Severities
// are deterministic — mapped from the magnitude of the condition.
//
// Exception types (must stay in sync with the DB CHECK in the Phase 3
// migration):
//
//   projected_stockout      supply < demand in a forward period
//   negative_ats            ats_qty < 0 (dirty data signal)
//   late_po                 any open PO with expected_date > period_end
//                           but need existed in-period (vendor risk)
//   excess_inventory        excess_qty ≥ EXCESS_PCT_TRIGGER × demand
//   supply_demand_mismatch  supply=0 AND demand>0 OR supply>0 AND demand=0
//                           (data alignment smell)
//   missing_supply_inputs   all four supply buckets = 0 AND demand > 0
//   protected_not_covered   protected_ecom not fully filled
//   reserved_not_covered    reserved_wholesale not fully filled

import type {
  IpPriorityLevel,
  IpProjectedInventory,
  IpSupplyException,
  IpSupplyExceptionType,
} from "../types/supply";

export const EXCESS_EXCEPTION_PCT = 0.3; // mirrors recommendationEngine

type Row = Omit<IpProjectedInventory, "id" | "created_at">;

function newException(
  row: Row,
  type: IpSupplyExceptionType,
  severity: IpPriorityLevel,
  details: Record<string, unknown>,
): Omit<IpSupplyException, "id" | "created_at"> {
  return {
    planning_run_id: row.planning_run_id,
    sku_id: row.sku_id,
    category_id: row.category_id,
    period_start: row.period_start,
    period_end: row.period_end,
    period_code: row.period_code,
    exception_type: type,
    severity,
    details,
  };
}

export interface ExceptionContext {
  // Pre-computed per-grain shortfalls so the engine doesn't re-run the
  // allocation math. Keyed by `${sku_id}:${period_start}`.
  protectedShortfall?: Map<string, number>;
  reserveShortfall?: Map<string, number>;
  // Optional PO-level breakdown for late_po detection.
  poByGrain?: Map<string, Array<{ po_number: string; expected_date: string | null; qty_open: number }>>;
}

export function generateSupplyExceptions(
  rows: Row[],
  ctx: ExceptionContext = {},
): Array<Omit<IpSupplyException, "id" | "created_at">> {
  const out: Array<Omit<IpSupplyException, "id" | "created_at">> = [];
  for (const row of rows) {
    const key = `${row.sku_id}:${row.period_start}`;
    const totalDemand = row.wholesale_demand_qty + row.ecom_demand_qty;
    const hasAnySupply =
      row.beginning_on_hand_qty + row.inbound_po_qty + row.inbound_receipts_qty + row.wip_qty > 0;

    if (row.shortage_qty > 0) {
      const frac = totalDemand > 0 ? row.shortage_qty / totalDemand : 1;
      const severity: IpPriorityLevel =
        frac >= 0.25 ? "critical" :
        frac >= 0.1  ? "high"     : "medium";
      out.push(newException(row, "projected_stockout", severity, {
        shortage_qty: row.shortage_qty,
        demand: totalDemand,
        supply: row.total_available_supply_qty,
      }));
    }

    if (row.ats_qty < 0) {
      out.push(newException(row, "negative_ats", "high", {
        ats_qty: row.ats_qty,
        beginning_on_hand_qty: row.beginning_on_hand_qty,
      }));
    }

    if (row.excess_qty >= EXCESS_EXCEPTION_PCT * Math.max(totalDemand, 1) && row.excess_qty > 0) {
      const severity: IpPriorityLevel =
        row.excess_qty >= totalDemand ? "high" : "medium";
      out.push(newException(row, "excess_inventory", severity, {
        excess_qty: row.excess_qty,
        demand: totalDemand,
      }));
    }

    if (!hasAnySupply && totalDemand > 0) {
      out.push(newException(row, "missing_supply_inputs", "high", {
        demand: totalDemand,
        supply: row.total_available_supply_qty,
      }));
    }

    if ((row.total_available_supply_qty === 0 && totalDemand > 0) ||
        (row.total_available_supply_qty > 0 && totalDemand === 0)) {
      out.push(newException(row, "supply_demand_mismatch", "low", {
        supply: row.total_available_supply_qty,
        demand: totalDemand,
      }));
    }

    const protShort = ctx.protectedShortfall?.get(key) ?? 0;
    if (protShort > 0) {
      out.push(newException(row, "protected_not_covered", "high", {
        shortfall: protShort,
        protected_ecom_qty: row.protected_ecom_qty,
        ecom_demand_qty: row.ecom_demand_qty,
      }));
    }

    const reserveShort = ctx.reserveShortfall?.get(key) ?? 0;
    if (reserveShort > 0) {
      out.push(newException(row, "reserved_not_covered", "high", {
        shortfall: reserveShort,
        reserved_wholesale_qty: row.reserved_wholesale_qty,
        wholesale_demand_qty: row.wholesale_demand_qty,
      }));
    }

    // late_po: any open PO with expected_date strictly after period_end
    // while the row is short — the supply the planner planned-for isn't
    // landing in time.
    const pos = ctx.poByGrain?.get(key);
    if (pos && row.shortage_qty > 0) {
      for (const po of pos) {
        if (!po.expected_date) continue;
        if (po.expected_date > row.period_end) {
          out.push(newException(row, "late_po", "medium", {
            po_number: po.po_number,
            expected_date: po.expected_date,
            qty_open: po.qty_open,
          }));
        }
      }
    }
  }
  return out;
}
