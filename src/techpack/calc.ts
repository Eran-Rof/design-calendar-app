// Pure math helpers for the TechPack app — extracted from the BOM
// tab, costing tab, and approvals workflow renderers in TechPack.tsx.
// All inputs are plain data + all outputs are deterministic so the
// numbers can be unit-tested without mounting React.
//
// The motivation is twofold: shrink the monolith, and pin down the
// costing/margin formulas in tests so future tweaks to rounding,
// duty rate, or margin-tier thresholds get caught in CI rather than
// landing silently in a render-only path.

import type { BOMItem, Costing, Approval } from "./types";

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Apply `updates` to a costing breakdown and recompute the three
 * derived fields:
 *   - duty       = fob * (dutyRate / 100)
 *   - landedCost = fob + duty + freight + insurance + otherCosts
 *   - margin     = (retailPrice - landedCost) / retailPrice * 100
 * Margin is 0 when retailPrice is 0 (no division-by-zero, no NaN).
 * All values rounded to 2 decimals.
 */
export function recomputeCosting(c: Costing, updates: Partial<Costing>): Costing {
  const merged = { ...c, ...updates };
  merged.duty = round2(merged.fob * (merged.dutyRate / 100));
  merged.landedCost = round2(merged.fob + merged.duty + merged.freight + merged.insurance + merged.otherCosts);
  merged.margin = merged.retailPrice > 0
    ? Math.round(((merged.retailPrice - merged.landedCost) / merged.retailPrice) * 10000) / 100
    : 0;
  return merged;
}

/** Color thresholds for the margin indicator: ≥50% green, ≥30% amber, else red. */
export function marginTierColor(margin: number): string {
  if (margin >= 50) return "#10B981";
  if (margin >= 30) return "#F59E0B";
  return "#EF4444";
}

/**
 * Apply changes to a single BOM line item. If either `quantity` or
 * `unitCost` changed, recompute `totalCost = parseFloat(qty || "0") * unitCost`
 * (rounded to 2 decimals). Otherwise leave `totalCost` untouched.
 */
export function recomputeBomItemTotal(item: BOMItem, changes: Partial<BOMItem>): BOMItem {
  const merged = { ...item, ...changes };
  if ("unitCost" in changes || "quantity" in changes) {
    merged.totalCost = round2(parseFloat(merged.quantity || "0") * merged.unitCost);
  }
  return merged;
}

/** Sum of `totalCost` across every BOM line — the BOM tab header total. */
export function bomTotal(items: BOMItem[]): number {
  return items.reduce((sum, b) => sum + b.totalCost, 0);
}

/**
 * Sequential approval gate. Stage 0 is always unlocked; every later
 * stage requires *every* preceding stage to be "Approved".
 */
export function isApprovalStageUnlocked(approvals: Approval[], index: number): boolean {
  if (index === 0) return true;
  return approvals.slice(0, index).every(a => a.status === "Approved");
}
