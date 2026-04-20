// Rule-based allocation engine. No optimization, no black-box math.
// Reads like a planner would on paper:
//
//   Given total_supply for a (sku, period):
//
//   step 1 — reserved_wholesale_qty
//     Sum the applicable `reserve_wholesale` / `strategic_customer`
//     rules. `reserve_qty` wins if set; otherwise `reserve_percent × wholesale_demand`.
//     Capped at wholesale_demand. Drawn from supply first.
//
//   step 2 — protected_ecom_qty
//     Comes from the demand input (already computed by Phase 2 and
//     summed to the month by the reconciliation service), further
//     augmented by any `protect_ecom` rule. Capped at ecom_demand.
//     Drawn from remaining supply.
//
//   step 3 — remaining wholesale (= wholesale_demand − reserved)
//     Filled from remaining supply.
//
//   step 4 — remaining ecom (= ecom_demand − protected)
//     Filled from remaining supply (with any `cap_ecom` rule applied).
//
//   ending_inventory_qty = max(0, supply_left_after_step_4)
//   shortage_qty         = max(0, total_demand − allocated_total_qty)
//   excess_qty           = max(0, total_supply − total_demand)
//
// Trace lines are appended to an array so the detail drawer can show
// the waterfall step-by-step.

import type {
  AllocationBreakdown,
  DemandInputsForSku,
  IpAllocationRule,
} from "../types/supply";

function clampNonNeg(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Evaluate reserve rules: strategic_customer / reserve_wholesale.
// Returns the sum of reserve qtys, capped at wholesale_demand.
function computeReservedWholesale(
  wholesaleDemand: number,
  rules: IpAllocationRule[],
): number {
  let reserved = 0;
  for (const r of rules) {
    if (r.rule_type !== "reserve_wholesale" && r.rule_type !== "strategic_customer") continue;
    const fromQty = r.reserve_qty != null ? Math.max(0, r.reserve_qty) : 0;
    const fromPct = r.reserve_percent != null ? Math.max(0, r.reserve_percent) * wholesaleDemand : 0;
    reserved += fromQty > 0 ? fromQty : fromPct;
  }
  return Math.min(reserved, clampNonNeg(wholesaleDemand));
}

// Extra ecom protection from `protect_ecom` rules (added on top of
// Phase 2's protected_ecom_qty already baked into the demand row).
// Capped at ecom_demand.
function computeRuleProtectedEcom(
  ecomDemand: number,
  existingProtected: number,
  rules: IpAllocationRule[],
): number {
  let extra = 0;
  for (const r of rules) {
    if (r.rule_type !== "protect_ecom") continue;
    const fromQty = r.reserve_qty != null ? Math.max(0, r.reserve_qty) : 0;
    const fromPct = r.reserve_percent != null ? Math.max(0, r.reserve_percent) * ecomDemand : 0;
    extra += fromQty > 0 ? fromQty : fromPct;
  }
  return Math.min(existingProtected + extra, clampNonNeg(ecomDemand));
}

// A cap on how much of remaining ecom demand we'll allocate beyond the
// protected floor. Useful when a category has known over-forecasting.
function computeEcomCap(
  ecomDemand: number,
  rules: IpAllocationRule[],
): number | null {
  for (const r of rules) {
    if (r.rule_type !== "cap_ecom") continue;
    const fromQty = r.reserve_qty != null ? Math.max(0, r.reserve_qty) : null;
    const fromPct = r.reserve_percent != null ? Math.max(0, r.reserve_percent) * ecomDemand : null;
    // First cap rule wins — mirrors "lower priority_rank first" the caller
    // is expected to have pre-sorted by.
    if (fromQty != null) return fromQty;
    if (fromPct != null) return fromPct;
  }
  return null;
}

export function computeAllocation(
  totalSupply: number,
  demand: DemandInputsForSku,
  rulesRaw: IpAllocationRule[],
): AllocationBreakdown {
  // Sort by priority_rank ASC so "lower number first" is honored when
  // multiple rules compete (e.g. two cap_ecom rules; only the first wins).
  const rules = [...rulesRaw].sort((a, b) => a.priority_rank - b.priority_rank);

  const wholesaleDemand = clampNonNeg(demand.wholesale_demand_qty);
  const ecomDemand = clampNonNeg(demand.ecom_demand_qty);
  const totalDemand = wholesaleDemand + ecomDemand;

  const trace: AllocationBreakdown["trace"] = [];
  let supplyLeft = clampNonNeg(totalSupply);
  trace.push({ step: "start", supply_after: supplyLeft });

  // ── step 1: reserved wholesale ─────────────────────────────────────
  const reserveTarget = computeReservedWholesale(wholesaleDemand, rules);
  const reservedTaken = Math.min(reserveTarget, supplyLeft);
  supplyLeft -= reservedTaken;
  trace.push({
    step: "reserve_wholesale",
    supply_after: supplyLeft,
    note: `reserved ${reservedTaken} of target ${reserveTarget} (wholesale_demand=${wholesaleDemand})`,
  });

  // ── step 2: protect ecom ───────────────────────────────────────────
  const protectTarget = computeRuleProtectedEcom(ecomDemand, clampNonNeg(demand.protected_ecom_qty), rules);
  const protectedTaken = Math.min(protectTarget, supplyLeft);
  supplyLeft -= protectedTaken;
  trace.push({
    step: "protect_ecom",
    supply_after: supplyLeft,
    note: `protected ${protectedTaken} of target ${protectTarget} (ecom_demand=${ecomDemand})`,
  });

  // ── step 3: remaining wholesale ───────────────────────────────────
  const wholesaleRemainingDemand = Math.max(0, wholesaleDemand - reservedTaken);
  const wholesaleRemainingFill = Math.min(wholesaleRemainingDemand, supplyLeft);
  supplyLeft -= wholesaleRemainingFill;
  trace.push({
    step: "wholesale_remainder",
    supply_after: supplyLeft,
    note: `filled ${wholesaleRemainingFill} of remaining wholesale ${wholesaleRemainingDemand}`,
  });

  // ── step 4: remaining ecom (respecting cap_ecom, if any) ──────────
  const ecomRemainingDemandRaw = Math.max(0, ecomDemand - protectedTaken);
  const cap = computeEcomCap(ecomDemand, rules);
  const ecomRemainingDemand = cap == null
    ? ecomRemainingDemandRaw
    : Math.min(ecomRemainingDemandRaw, Math.max(0, cap - protectedTaken));
  const ecomRemainingFill = Math.min(ecomRemainingDemand, supplyLeft);
  supplyLeft -= ecomRemainingFill;
  trace.push({
    step: "ecom_remainder",
    supply_after: supplyLeft,
    note: `filled ${ecomRemainingFill} of remaining ecom ${ecomRemainingDemand}${cap != null ? ` (cap=${cap})` : ""}`,
  });

  const allocatedWholesale = reservedTaken + wholesaleRemainingFill;
  const allocatedEcom = protectedTaken + ecomRemainingFill;
  const allocatedTotal = allocatedWholesale + allocatedEcom;
  const ending = supplyLeft;
  const shortage = Math.max(0, totalDemand - allocatedTotal);
  const excess = Math.max(0, totalSupply - totalDemand);
  const stockout = totalSupply < totalDemand;

  return {
    reserved_wholesale_qty: reservedTaken,
    protected_ecom_qty: protectedTaken,
    allocated_wholesale_qty: allocatedWholesale,
    allocated_ecom_qty: allocatedEcom,
    allocated_total_qty: allocatedTotal,
    ending_inventory_qty: ending,
    shortage_qty: shortage,
    excess_qty: excess,
    projected_stockout_flag: stockout,
    trace,
  };
}

// Helper: sum per-customer / per-channel allocation once the totals are
// known. Proportional by stated demand. Exposed so the detail drawer
// can display a customer/channel-level breakdown.
export function splitAllocation(
  allocatedTotal: number,
  buckets: Array<{ key: string; demand: number }>,
): Array<{ key: string; allocated: number }> {
  const total = buckets.reduce((a, b) => a + Math.max(0, b.demand), 0);
  if (total <= 0) return buckets.map((b) => ({ key: b.key, allocated: 0 }));
  const shares = buckets.map((b) => ({
    key: b.key,
    share: Math.max(0, b.demand) / total,
  }));
  // Round down each share, drop remainder on the largest bucket so
  // totals still tie out.
  const raw = shares.map((s) => ({ key: s.key, allocated: Math.floor(s.share * allocatedTotal) }));
  const sum = raw.reduce((a, b) => a + b.allocated, 0);
  const leftover = Math.max(0, Math.round(allocatedTotal) - sum);
  if (leftover > 0 && raw.length > 0) {
    const largest = raw
      .map((r, i) => ({ i, demand: buckets[i].demand }))
      .sort((a, b) => b.demand - a.demand)[0];
    raw[largest.i].allocated += leftover;
  }
  return raw;
}
