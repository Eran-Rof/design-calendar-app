// Pure helpers extracted from WholesalePlanningGrid.tsx. No React, no
// DOM, no Supabase — safe to import from tests directly.

import type { IpPlanningGridRow } from "../../types/wholesale";
import { NO_COLLAPSE } from "./constants";
import type { CollapseModes, SortKey } from "./types";

// Collapse-object → option keys. The dropdown stays open and is
// multi-select; the planner can flick on multiple modes at once.
// We surface the same option keys that applyCollapseKeys reads,
// reverse-mapped from whichever flags are currently true. The
// "customersAndColors" combo is decomposed back to "customers" +
// "colors" so the dropdown's checkmarks line up with the actual
// flags driving the grid.
export function collapseToKeys(c: CollapseModes): string[] {
  const keys: string[] = [];
  if (c.customerAllStyles) keys.push("customerAllStyles");
  if (c.allCustomersPerStyle) keys.push("allCustomersPerStyle");
  if (c.allCustomersPerCategory) keys.push("allCustomersPerCategory");
  if (c.allCustomersPerSubCat) keys.push("allCustomersPerSubCat");
  if (c.subCat) keys.push("subCat");
  if (c.category) keys.push("category");
  if (c.customers) keys.push("customers");
  if (c.colors) keys.push("colors");
  return keys;
}

// Option keys → collapse object. The grid's CollapseModes object is
// flag-based, but several flags are mutually exclusive at runtime
// (e.g. category vs subCat). When the planner picks a wider rollup
// like customerAllStyles or allCustomersPerCategory, that mode
// supersedes the simpler customers / colors flags — picking it
// auto-clears the others to keep the bucketing sane.
export function applyCollapseKeys(keys: string[]): CollapseModes {
  const out: CollapseModes = { ...NO_COLLAPSE };
  const set = new Set(keys);
  if (set.has("customers")) out.customers = true;
  if (set.has("colors")) out.colors = true;
  if (set.has("category")) out.category = true;
  if (set.has("subCat")) out.subCat = true;
  if (set.has("customerAllStyles")) out.customerAllStyles = true;
  if (set.has("allCustomersPerStyle")) out.allCustomersPerStyle = true;
  if (set.has("allCustomersPerCategory")) out.allCustomersPerCategory = true;
  if (set.has("allCustomersPerSubCat")) out.allCustomersPerSubCat = true;
  // Mutually-exclusive enforcement: category vs subCat.
  if (out.category && out.subCat) out.subCat = false;
  // The "wide rollup" modes drop the simpler customer/color flags
  // because their bucketing already drops those dims. Keeping the
  // simpler flags on alongside would just be ignored, but they'd
  // light up in the dropdown and confuse the planner.
  const wideRollupActive =
    out.customerAllStyles || out.allCustomersPerStyle
    || out.allCustomersPerCategory || out.allCustomersPerSubCat;
  if (wideRollupActive) {
    out.customers = false;
    out.colors = false;
  }
  return out;
}

// Spread a typed total across N supply-only forecast rows for a (style,
// color) bucket. Aggregate Buyer / Override edits route 100% to the
// "(Supply Only)" synthetic customer rows under the bucket, never to
// real customer rows — the planner treats top-level edits as stock
// buys, not as demand requests against any individual customer.
//
// When the bucket has multiple supply-only rows (e.g. multi-size where
// several sizes have no customer pair), the total is split across
// them — equally if every child is currently zero, otherwise weighted
// by their existing values. Rounding error is absorbed into the LAST
// child so the integer sum hits `newTotal` exactly.
//
// Returns one entry per underlying supply-only id with the new qty.
// The caller filters out no-op writes before dispatching network
// mutations.
export function distributeAcrossChildren(
  underlyingIds: string[],
  currentValues: number[],
  newTotal: number,
): Array<{ fid: string; qty: number }> {
  const N = underlyingIds.length;
  if (N === 0) return [];
  if (N === 1) return [{ fid: underlyingIds[0], qty: newTotal }];
  const currentTotal = currentValues.reduce((a, b) => a + b, 0);
  if (currentTotal === 0) {
    const base = Math.trunc(newTotal / N);
    const remainder = newTotal - base * N;
    return underlyingIds.map((fid, i) => ({ fid, qty: base + (i < Math.abs(remainder) ? Math.sign(remainder) : 0) }));
  }
  const out: Array<{ fid: string; qty: number }> = [];
  let assigned = 0;
  for (let i = 0; i < N; i++) {
    const isLast = i === N - 1;
    const qty = isLast
      ? newTotal - assigned
      : Math.round((newTotal * currentValues[i]) / currentTotal);
    out.push({ fid: underlyingIds[i], qty });
    assigned += qty;
  }
  return out;
}

// Generic null-safe comparators. Numbers sort numerically; strings sort
// case-insensitively; nulls always at the end regardless of direction.
export function cmpStr(a: string | null | undefined, b: string | null | undefined, sign: number): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a.localeCompare(b, undefined, { sensitivity: "base" }) * sign;
}

export function cmpNum(a: number | null | undefined, b: number | null | undefined, sign: number): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return (a - b) * sign;
}

// Multi-column comparator: walk the sort stack in priority order (parent
// first) and return the first non-zero comparison. Empty stack → keep order.
export function cmpMulti(a: IpPlanningGridRow, b: IpPlanningGridRow, stack: Array<{ key: SortKey; dir: "asc" | "desc" }>): number {
  for (const s of stack) {
    const c = cmp(a, b, s.key, s.dir);
    // Guard against a stale persisted key that's no longer a valid SortKey —
    // cmp() has no default case, so an unknown key returns undefined; skip it
    // rather than feed NaN into Array.sort.
    if (typeof c === "number" && c !== 0) return c;
  }
  return 0;
}

export function cmp(a: IpPlanningGridRow, b: IpPlanningGridRow, k: SortKey, d: "asc" | "desc"): number {
  const sign = d === "asc" ? 1 : -1;
  switch (k) {
    case "category":    return cmpStr(a.group_name, b.group_name, sign);
    case "subCat":      return cmpStr(a.sub_category_name, b.sub_category_name, sign);
    case "style": {
      // Tuple compare so a colon in a style code (rare but possible)
      // can't mix the two segments, and so localeCompare's
      // "sensitivity: base" doesn't fall over the synthetic ":"
      // separator in a way that misorders nullable colors.
      const styleA = a.sku_style ?? a.sku_code;
      const styleB = b.sku_style ?? b.sku_code;
      const styleCmp = cmpStr(styleA, styleB, sign);
      if (styleCmp !== 0) return styleCmp;
      return cmpStr(a.sku_color, b.sku_color, sign);
    }
    case "color":       return cmpStr(a.sku_color, b.sku_color, sign);
    case "inseam":      return cmpStr(a.sku_inseam ?? null, b.sku_inseam ?? null, sign);
    case "description": return cmpStr(a.sku_description, b.sku_description, sign);
    case "customer":    return cmpStr(a.customer_name, b.customer_name, sign);
    case "period":      return cmpStr(a.period_start, b.period_start, sign);
    case "class":       return cmpStr(`${a.abc_class ?? "Z"}${a.xyz_class ?? "Z"}`, `${b.abc_class ?? "Z"}${b.xyz_class ?? "Z"}`, sign);
    case "histT3":      return cmpNum(a.historical_trailing_qty, b.historical_trailing_qty, sign);
    case "histLY":      return cmpNum(a.ly_reference_qty, b.ly_reference_qty, sign);
    case "margin":      return cmpNum(a.historical_margin_pct, b.historical_margin_pct, sign);
    case "system":      return cmpNum(a.system_forecast_qty, b.system_forecast_qty, sign);
    case "buyer":       return cmpNum(a.buyer_request_qty, b.buyer_request_qty, sign);
    case "override":    return cmpNum(a.override_qty, b.override_qty, sign);
    case "final":       return cmpNum(a.final_forecast_qty, b.final_forecast_qty, sign);
    case "confidence":  return cmpStr(a.confidence_level, b.confidence_level, sign);
    case "method":      return cmpStr(a.forecast_method, b.forecast_method, sign);
    case "onHand":      return cmpNum(a.on_hand_qty, b.on_hand_qty, sign);
    case "onSo":        return cmpNum(a.on_so_qty, b.on_so_qty, sign);
    case "receipts":    return cmpNum(a.receipts_due_qty, b.receipts_due_qty, sign);
    case "histRecv":    return cmpNum(a.historical_receipts_qty, b.historical_receipts_qty, sign);
    case "ats":         return cmpNum(a.available_supply_qty, b.available_supply_qty, sign);
    case "buy":         return cmpNum(a.planned_buy_qty, b.planned_buy_qty, sign);
    case "avgCost":     return cmpNum(a.avg_cost, b.avg_cost, sign);
    case "unitCost":    return cmpNum(a.unit_cost, b.unit_cost, sign);
    case "buyDollars":  return cmpNum((a.planned_buy_qty ?? 0) * (a.unit_cost ?? 0), (b.planned_buy_qty ?? 0) * (b.unit_cost ?? 0), sign);
    case "shortage":    return cmpNum(a.projected_shortage_qty, b.projected_shortage_qty, sign);
    case "excess":      return cmpNum(a.projected_excess_qty, b.projected_excess_qty, sign);
    case "action":      return cmpStr(a.recommended_action, b.recommended_action, sign);
  }
}


// ---------------------------------------------------------------------------
// Logical rolling chains (fix: On Hand / ATS zeroed under a Period sort).
//
// The rolling supply pool is a LOGICAL chain per style/color (or per active
// collapse-mode group) -- NOT a run of visually adjacent rows. The grid
// previously split chains wherever the chain key changed between CONSECUTIVE
// rows in render order, so any sort that interleaves chains (the common
// "Period ascending" view puts Mar/ColorA next to Mar/ColorB) fragmented
// every chain into 1-row pieces: the pool reset on each row, On Hand never
// inherited the prior period's ATS, and the ending-ATS total walked
// fragments.
//
// rollByLogicalChain groups rows by key REGARDLESS of position, orders each
// chain chronologically (period_start, then original index for stability),
// runs the pool down the chain, and writes each result back to the row's
// original index -- so the math is always chronological while the planner
// sorts the view however they like.
export interface ChainRollResult {
  on_hand_qty: number;
  available_supply_qty: number;
}

export function rollByLogicalChain(
  rows: IpPlanningGridRow[],
  keyOf: (r: IpPlanningGridRow) => string,
  rollChain: (chainRows: IpPlanningGridRow[]) => ChainRollResult[],
): ChainRollResult[] {
  const byChain = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const k = keyOf(r);
    let idxs = byChain.get(k);
    if (!idxs) { idxs = []; byChain.set(k, idxs); }
    idxs.push(i);
  });
  const out = new Array<ChainRollResult>(rows.length);
  for (const idxs of byChain.values()) {
    const ordered = [...idxs].sort((a, b) => {
      const pa = rows[a].period_start ?? "";
      const pb = rows[b].period_start ?? "";
      return pa !== pb ? pa.localeCompare(pb) : a - b;
    });
    const rolled = rollChain(ordered.map((i) => rows[i]));
    ordered.forEach((idx, j) => { out[idx] = rolled[j]; });
  }
  return out;
}


// ---------------------------------------------------------------------------
// Stale persisted-filter detection. Filters live in localStorage and survive
// catalog changes -- when the item master is re-categorized (e.g. group
// "DENIM" renamed to "SHORTS"), a saved Category filter silently matches
// ZERO rows and the grid reads as broken ("none of the builds are loading").
// Given the run's FULL row set and the active selections, return, per filter
// dimension, the selected values that no longer exist anywhere in the run so
// the empty state can NAME them and offer a one-click removal.
export interface ActiveFilterDim {
  dim: string;                                  // machine key ("category", ...)
  label: string;                                // human label ("Category")
  selected: string[];                           // current selections
  valueOf: (r: IpPlanningGridRow) => string;    // MUST mirror the filter predicate
  // When true the raw values are ids (never show them -- no-UUID rule);
  // the empty state reports a count instead.
  opaque?: boolean;
}
export interface StaleFilterSelection { dim: string; label: string; stale: string[]; opaque: boolean }

export function findStaleFilterSelections(
  rows: IpPlanningGridRow[],
  dims: ActiveFilterDim[],
): StaleFilterSelection[] {
  const out: StaleFilterSelection[] = [];
  for (const { dim, label, selected, valueOf, opaque } of dims) {
    if (selected.length === 0) continue;
    const domain = new Set<string>();
    for (const r of rows) domain.add(valueOf(r));
    const stale = selected.filter((v) => !domain.has(v));
    if (stale.length > 0) out.push({ dim, label, stale, opaque: !!opaque });
  }
  return out;
}
