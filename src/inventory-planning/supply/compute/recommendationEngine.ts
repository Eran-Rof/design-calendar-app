// Recommendation engine: maps a reconciled (projected_inventory) row
// into zero or more action recommendations. Deterministic and
// explainable — every branch writes a plain-English reason.
//
// Thresholds are exported constants so reviewers can argue with them.
// Default-safe: we prefer "monitor" over a big action when the signal
// is marginal.

import type {
  IpInventoryRecommendation,
  IpPriorityLevel,
  IpProjectedInventory,
  IpRecommendationType,
} from "../types/supply";

export const SHORTAGE_PCT_TRIGGER = 0.1;    // 10% of demand
export const EXCESS_PCT_TRIGGER   = 0.3;    // 30% above demand
export const EXPEDITE_WITHIN_DAYS = 30;
export const MONITOR_FLOOR_QTY    = 6;
export const CRITICAL_SHORTAGE_FRACTION = 0.25; // shortage >= 25% of demand → critical

type Row = Omit<IpProjectedInventory, "id" | "created_at">;

function daysBetween(fromIso: string, toIso: string): number {
  const ms = Date.parse(toIso + "T00:00:00Z") - Date.parse(fromIso + "T00:00:00Z");
  return Math.round(ms / 86_400_000);
}

function newRec(
  row: Row,
  type: IpRecommendationType,
  qty: number | null,
  reason: string,
  priority: IpPriorityLevel,
  serviceRisk = false,
): Omit<IpInventoryRecommendation, "id" | "created_at"> {
  return {
    planning_run_id: row.planning_run_id,
    sku_id: row.sku_id,
    category_id: row.category_id,
    period_start: row.period_start,
    period_end: row.period_end,
    period_code: row.period_code,
    recommendation_type: type,
    recommendation_qty: qty,
    action_reason: reason,
    priority_level: priority,
    shortage_qty: row.shortage_qty || null,
    excess_qty: row.excess_qty || null,
    service_risk_flag: serviceRisk,
  };
}

export function generateInventoryRecommendations(
  rows: Row[],
  asOfIso: string,
  opts: {
    protectedShortfall?: Map<string, number>; // (sku:period_start) → ecom protection not covered
    reserveShortfall?: Map<string, number>;   // same keying → reserve not covered
  } = {},
): Array<Omit<IpInventoryRecommendation, "id" | "created_at">> {
  const out: Array<Omit<IpInventoryRecommendation, "id" | "created_at">> = [];
  for (const row of rows) {
    const totalDemand = row.wholesale_demand_qty + row.ecom_demand_qty;
    const shortage = row.shortage_qty;
    const excess = row.excess_qty;
    const daysToPeriodStart = daysBetween(asOfIso, row.period_start);
    const periodInPast = daysBetween(asOfIso, row.period_end) < 0;
    const key = `${row.sku_id}:${row.period_start}`;
    const protectedShortfall = opts.protectedShortfall?.get(key) ?? 0;
    const reserveShortfall = opts.reserveShortfall?.get(key) ?? 0;

    // ── stockout handling (highest priority) ─────────────────────────
    if (shortage > 0 && shortage >= SHORTAGE_PCT_TRIGGER * Math.max(totalDemand, 1)) {
      const criticalByMagnitude = totalDemand > 0 && shortage / totalDemand >= CRITICAL_SHORTAGE_FRACTION;
      const lateWindow = daysToPeriodStart >= 0 && daysToPeriodStart < EXPEDITE_WITHIN_DAYS;

      if (totalDemand < MONITOR_FLOOR_QTY) {
        out.push(newRec(row, "monitor", null,
          `Demand ${totalDemand} below monitor floor (${MONITOR_FLOOR_QTY}) — watch, don't chase.`,
          "low"));
        continue;
      }

      if (lateWindow && !periodInPast) {
        out.push(newRec(row, "expedite", shortage,
          `Shortage of ${shortage} on ${row.period_code} within ${EXPEDITE_WITHIN_DAYS} days — expedite inbound.`,
          criticalByMagnitude ? "critical" : "high",
          true));
      } else if (!periodInPast) {
        out.push(newRec(row, "buy", shortage,
          `Shortage of ${shortage} vs demand ${totalDemand} in ${row.period_code} — buy to cover.`,
          criticalByMagnitude ? "critical" : "high",
          true));
      } else {
        out.push(newRec(row, "monitor", null,
          `Historical shortage of ${shortage} — retrospective only.`,
          "low"));
      }
    }

    // ── excess handling ──────────────────────────────────────────────
    else if (excess > 0 && excess >= EXCESS_PCT_TRIGGER * Math.max(totalDemand, 1)) {
      if (periodInPast) {
        out.push(newRec(row, "monitor", null,
          `Excess of ${excess} units already in a past period.`,
          "low"));
      } else {
        // If a planned inbound PO lands in-period, push or cancel it.
        if (row.inbound_po_qty > 0 && excess >= row.inbound_po_qty) {
          out.push(newRec(row, "cancel_receipt", Math.min(excess, row.inbound_po_qty),
            `Excess of ${excess} — inbound PO of ${row.inbound_po_qty} not needed this period.`,
            "medium"));
        } else if (row.inbound_po_qty > 0) {
          out.push(newRec(row, "push_receipt", row.inbound_po_qty,
            `Excess of ${excess} — push inbound PO of ${row.inbound_po_qty} to a later period.`,
            "medium"));
        } else {
          out.push(newRec(row, "reduce", excess,
            `Excess of ${excess} above demand ${totalDemand} — reduce buy plan.`,
            "medium"));
        }
      }
    }

    // ── balanced → hold ──────────────────────────────────────────────
    else if (totalDemand > 0 && row.total_available_supply_qty > 0) {
      out.push(newRec(row, "hold", null, "Supply and demand within tolerance.", "low"));
    }

    // ── zero on both sides → nothing to say, skip ────────────────────

    // ── protected ecom not covered ───────────────────────────────────
    if (protectedShortfall > 0) {
      out.push(newRec(row, "protect_inventory", protectedShortfall,
        `Protected ecom demand short by ${protectedShortfall} in ${row.period_code}.`,
        "high",
        true));
    }

    // ── reserved wholesale not covered ───────────────────────────────
    if (reserveShortfall > 0) {
      out.push(newRec(row, "reallocate", reserveShortfall,
        `Strategic reserve short by ${reserveShortfall} — reallocate from non-reserved demand.`,
        "high",
        true));
    }
  }
  return out;
}
