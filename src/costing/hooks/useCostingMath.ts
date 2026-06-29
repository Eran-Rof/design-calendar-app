// useCostingMath — adapter around src/techpack/calc.ts recomputeCosting().
//
// The TechPack helper expects a Costing object with keys
//   { fob, dutyRate, freight, insurance, otherCosts, retailPrice, ... }
// We translate the Costing Module's CostingLine fields into that shape and
// return the derived { landed_cost, margin_pct, tierColor }.
//
// IMPORTANT: do not re-implement the math. The TechPack calc has 21 unit
// tests pinning rounding and margin-tier thresholds (#158, #181, #184) and
// must stay the single source of truth.

import { useMemo } from "react";
import { recomputeCosting, marginTierColor } from "../../techpack/calc";
import type { Costing } from "../../techpack/types";
import type { CostingLine } from "../types";

export interface CostingMathResult {
  landed_cost: number;
  margin_pct: number;
  tierColor: string;
}

function toNum(v: number | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return isFinite(n) ? n : 0;
}

export function useCostingMath(line: CostingLine | null | undefined): CostingMathResult {
  return useMemo(() => {
    if (!line) return { landed_cost: 0, margin_pct: 0, tierColor: marginTierColor(0) };
    const base: Costing = {
      fob: toNum(line.fob_cost),
      dutyRate: toNum(line.duty_rate),
      duty: 0,
      freight: toNum(line.freight),
      insurance: toNum(line.insurance),
      otherCosts: toNum(line.other_costs),
      landedCost: 0,
      wholesalePrice: 0,
      // Sell column was removed — margin/retail now keys off Sell Tgt.
      retailPrice: toNum(line.sell_target),
      margin: 0,
      notes: "",
    };
    const next = recomputeCosting(base, {});
    return {
      landed_cost: next.landedCost,
      margin_pct: next.margin,
      tierColor: marginTierColor(next.margin),
    };
  }, [
    line?.fob_cost,
    line?.duty_rate,
    line?.freight,
    line?.insurance,
    line?.other_costs,
    line?.sell_target,
  ]);
}

/** Same math, but as a pure (non-hook) function for use in loops/footers. */
export function computeLineMath(line: CostingLine): CostingMathResult {
  const base: Costing = {
    fob: toNum(line.fob_cost),
    dutyRate: toNum(line.duty_rate),
    duty: 0,
    freight: toNum(line.freight),
    insurance: toNum(line.insurance),
    otherCosts: toNum(line.other_costs),
    landedCost: 0,
    wholesalePrice: 0,
    retailPrice: toNum(line.sell_target),
    margin: 0,
    notes: "",
  };
  const next = recomputeCosting(base, {});
  return {
    landed_cost: next.landedCost,
    margin_pct: next.margin,
    tierColor: marginTierColor(next.margin),
  };
}
