// Costing — row + project-header completeness checks (items 2 & 5) and the
// cost-basis / margin math (items 8 & 9). Shared by CostingGrid + ProjectEditView
// so the "incomplete row" guard and the margin display use one definition.

import type { CostingLine, CostingProject } from "../types";

export function num(v: number | null | undefined): number {
  if (v == null) return 0;
  const x = typeof v === "number" ? v : Number(v);
  return isFinite(x) ? x : 0;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

// A project is in DDP costing mode when its payment term name matches /DDP/i.
// In DDP mode the vendor quotes one delivered-duty-paid price (Tgt DDP Cost)
// and the FOB component columns are hidden; cost basis = target_cost.
export function isDdpProject(project: CostingProject | null | undefined): boolean {
  return !!project?.payment_terms_name && /DDP/i.test(project.payment_terms_name);
}

// Landed cost from the FOB components (mirrors techpack recomputeCosting).
export function landedFromComponents(line: CostingLine): number {
  const fob = num(line.fob_cost);
  const duty = round2(fob * (num(line.duty_rate) / 100));
  return round2(fob + duty + num(line.freight) + num(line.insurance) + num(line.other_costs));
}

// The cost basis used for margin: DDP → Tgt DDP Cost; otherwise landed (falls
// back to target_cost when no FOB components are entered yet).
export function lineCostBasis(line: CostingLine, isDdp: boolean): number {
  if (isDdp) return num(line.target_cost);
  const landed = landedFromComponents(line);
  return landed > 0 ? landed : num(line.target_cost);
}

// Margin % = (Sell Tgt − cost basis) / Sell Tgt × 100. 0 when no sell target.
export function lineMarginPct(line: CostingLine, isDdp: boolean): number {
  const sell = num(line.sell_target);
  if (!(sell > 0)) return 0;
  const cost = lineCostBasis(line, isDdp);
  return ((sell - cost) / sell) * 100;
}

// Back-solve cost from an operator-entered margin %. Returns the field patch to
// apply: DDP → set target_cost; otherwise solve FOB so landed hits the target,
// holding duty %, freight, insurance, other fixed. Returns null when it can't
// solve (no positive sell target).
export function solveCostFromMargin(
  line: CostingLine,
  isDdp: boolean,
  marginPct: number,
): Partial<CostingLine> | null {
  const sell = num(line.sell_target);
  if (!(sell > 0) || !isFinite(marginPct)) return null;
  const targetCost = sell * (1 - marginPct / 100); // desired cost basis
  if (isDdp) {
    return { target_cost: round2(Math.max(0, targetCost)) };
  }
  // landed = fob*(1 + duty/100) + freight + insurance + other  ⇒ solve fob
  const rest = num(line.freight) + num(line.insurance) + num(line.other_costs);
  const dutyFactor = 1 + num(line.duty_rate) / 100;
  const fob = (targetCost - rest) / (dutyFactor || 1);
  return { fob_cost: round2(Math.max(0, fob)) };
}

// Back-solve the SELL TGT from an operator-entered target gross-margin %, holding
// the cost basis fixed: sell = cost / (1 − margin/100). This is the inverse of
// solveCostFromMargin (which holds sell fixed and solves cost). Returns the
// rounded sell price, or null when it can't solve (no positive cost, or margin
// ≥ 100% which would divide by zero / go negative).
export function solveSellFromMargin(
  line: CostingLine,
  isDdp: boolean,
  marginPct: number,
): number | null {
  const cost = lineCostBasis(line, isDdp);
  if (!(cost > 0) || !isFinite(marginPct) || marginPct >= 100) return null;
  return round2(cost / (1 - marginPct / 100));
}

// Which required fields a row is still missing. Used for the incomplete-row
// guard on Send / exit. "cost" = Tgt DDP Cost (DDP) or a target/FOB cost.
export function rowMissingFields(line: CostingLine, isDdp: boolean): string[] {
  const miss: string[] = [];
  if (!line.style_code) miss.push("style");
  if (!line.color) miss.push("color");
  if (!line.selected_vendor_quote_id) miss.push("vendor");
  if (!(num(line.target_qty) > 0)) miss.push("qty");
  const costOk = isDdp
    ? num(line.target_cost) > 0
    : num(line.target_cost) > 0 || num(line.fob_cost) > 0;
  if (!costOk) miss.push(isDdp ? "Tgt DDP cost" : "target/FOB cost");
  if (!(num(line.sell_target) > 0)) miss.push("Sell Tgt");
  return miss;
}

export function isRowIncomplete(line: CostingLine, isDdp: boolean): boolean {
  return rowMissingFields(line, isDdp).length > 0;
}

// Required project-header fields that must be filled before any rows are added.
export function projectHeaderMissing(project: CostingProject | null | undefined): string[] {
  if (!project) return ["the project"];
  const miss: string[] = [];
  if (!project.project_name || !project.project_name.trim()) miss.push("Project name");
  if (!project.brand) miss.push("Brand");
  if (!project.gender_code) miss.push("Gender");
  if (!project.customer_id) miss.push("Customer");
  if (!project.sales_rep_id) miss.push("Sales rep");
  if (!project.payment_terms_id) miss.push("Payment terms");
  if (!project.request_date) miss.push("Request date");
  if (!project.due_date) miss.push("Due date");
  return miss;
}
