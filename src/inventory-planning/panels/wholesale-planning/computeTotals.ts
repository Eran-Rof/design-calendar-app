// Pure aggregation of the displayed rows for the totals strip + the
// action / method count chips. Extracted from WholesalePlanningGrid
// so the math is testable and the render closure doesn't carry a
// 15-line useMemo body.
//
// Shape mirrors the original inline object exactly so the call site
// can drop straight in (`const totals = computeTotals(mutedRows, skuPeriodMath)`).

import type { IpPlanningGridRow } from "../../types/wholesale";
import type { CollapseModes } from "../aggregateGridRows";

export interface GridTotals {
  /** Σ final_forecast_qty across the (already muted) display rows. */
  final: number;
  /** Σ shortage across unique (sku, period) groups from skuPeriodMath. */
  shortage: number;
  /** Σ excess across unique (sku, period) groups from skuPeriodMath. */
  excess: number;
  /** Count of rows per recommended_action — fuels the action chip strip. */
  actions: Record<string, number>;
  /** Count of rows per forecast_method — fuels the method chip strip. */
  methods: Record<string, number>;
  /** Per-column sums for the optional column-totals header row, keyed by the
   *  Th column key. Demand/buy columns sum per row; supply columns are deduped
   *  per (sku, period) so a SKU shared across customers isn't multiplied. The
   *  `ats` column is special: it's a rolling balance, so its total is the
   *  ending (last-period) ATS per style/color, summed — see lastPeriodAtsTotal
   *  (summing every period would double-count carried-forward supply). */
  columns: Record<string, number>;
}

// Per-(sku, period) supply math the grid pre-computes — same Map as
// the call site passes in. We only read excess + shortage off the
// values; other fields exist on the real type but we don't depend on
// them, so the local shape stays narrow.
interface SkuPeriodMathLike {
  excess: number;
  shortage: number;
}

// Grouping key for the ATS total = style + color, case-insensitive and
// trimmed. Mirrors the grid's style / color filter keys
// (`r.sku_style ?? r.sku_code`, `(r.sku_color ?? "").trim()`) so the
// total groups exactly the same way the planner's filters do.
function styleColorKey(r: IpPlanningGridRow): string {
  const style = (r.sku_style ?? r.sku_code ?? "").trim().toUpperCase();
  const color = (r.sku_color ?? "").trim().toUpperCase();
  return `${style}|${color}`;
}

/**
 * ATS total = Σ (over style/color groups) of the group's ENDING ATS.
 *
 * ATS is a ROLLING supply balance carried month to month (see
 * `applyRollingPool` / the grid's `skuPeriodMath`): each period's ATS
 * already includes the supply left over from the prior period. Summing
 * every period's ATS therefore counts the same units many times over.
 * The meaningful total is the ending position — for each style/color,
 * the ATS of its LAST (latest `period_start`) period.
 *
 * "Last period" is the max `period_start` among that style/color's rows
 * IN THE CURRENT VIEW (rows are already filtered before they reach here),
 * so narrowing the period filter moves the ending period accordingly.
 *
 * Within that ending period a style/color can still span several rows:
 *   - multiple customers of the same SKU — ATS (`available_supply_qty`)
 *     is a per-(sku, period) supply figure repeated across those customer
 *     rows, so we DEDUPE per (sku_id, period_code) and count it once
 *     rather than summing the duplicates; and
 *   - multiple sizes (distinct sku_ids) of the same style/color — each
 *     size is its own rolling pool, so their ending ATS values SUM into
 *     the style/color's ending position.
 */
// The rolling-pool CHAIN key — moved verbatim from WholesalePlanningGrid's
// `filtered` memo (the grid now imports it) so the ATS total walks EXACTLY
// the chains the ATS cells roll through. Consecutive rows sharing this key
// form one pool chain; a key change resets the pool.
export function rollGroupKeyFor(r: IpPlanningGridRow, collapse: CollapseModes): string {
  if (collapse.subCat) return `sub:${r.sub_category_name ?? ""}`;
  if (collapse.category) return `cat:${r.group_name ?? ""}`;
  if (collapse.allCustomersPerStyle) return `acps:${r.sku_style ?? r.sku_code}`;
  const styleColorPart = `${r.sku_style ?? r.sku_code}:${r.sku_color ?? "—"}`;
  if (collapse.allCustomersPerCategory) {
    const skuPart = collapse.colors ? (r.sku_style ?? r.sku_code) : styleColorPart;
    return `acpc:${r.group_name ?? ""}:${skuPart}`;
  }
  if (collapse.allCustomersPerSubCat) {
    const skuPart = collapse.colors ? (r.sku_style ?? r.sku_code) : styleColorPart;
    return `acpsc:${r.sub_category_name ?? ""}:${skuPart}`;
  }
  if (collapse.customerAllStyles) return `cas:${r.customer_id}`;
  if (collapse.colors) return `sku:${r.sku_style ?? r.sku_code}`;
  return `sku:${styleColorPart}`;
}

/**
 * ATS total = Σ (over displayed rolling chains) of each chain's ENDING
 * displayed ATS — i.e. read the LAST row's ATS cell of every style/color
 * chain and add them up (CEO spec: "RYB0412PPK Black has 5000 ATS in the
 * last period → add that amount to the next style and so on").
 *
 * Input MUST be the post-roll rows the cells render from (the grid's
 * `filtered` array) — the raw per-row `available_supply_qty` is 0 on
 * customer-demand rows and would zero the total (#1862's defect). A chain
 * = ALL rows sharing `keyOf(row)` regardless of visual position (the same
 * LOGICAL grouping rollByLogicalChain uses — a Period sort interleaves
 * chains, so consecutive runs would fragment them); the chain's ending
 * value is its latest-period row's ATS (later row wins a same-period tie,
 * matching the chronological roll order).
 */
function endingChainValueTotal(
  rolledRows: IpPlanningGridRow[],
  keyOf: (r: IpPlanningGridRow) => string,
  valueOf: (r: IpPlanningGridRow) => number,
): number {
  const endByChain = new Map<string, { period: string; v: number }>();
  for (const r of rolledRows) {
    const k = keyOf(r);
    const p = r.period_start ?? "";
    const cur = endByChain.get(k);
    if (!cur || p >= cur.period) endByChain.set(k, { period: p, v: valueOf(r) });
  }
  let total = 0;
  for (const { v } of endByChain.values()) total += v;
  return total;
}

export function endingAtsTotal(
  rolledRows: IpPlanningGridRow[],
  keyOf: (r: IpPlanningGridRow) => string,
): number {
  return endingChainValueTotal(rolledRows, keyOf, (r) => r.available_supply_qty ?? 0);
}

// On Hand gets the same display-parity treatment: it is a rolling
// beginning balance (each period's On Hand = the prior period's ATS), so
// the meaningful total is each chain's ENDING displayed On Hand, summed —
// the raw per-row on_hand repeats the same physical stock on every period
// row (and is 0 on stock-buy rows), so both the old dedupe-sum and a raw
// read misstate the column the planner is looking at.
export function endingOnHandTotal(
  rolledRows: IpPlanningGridRow[],
  keyOf: (r: IpPlanningGridRow) => string,
): number {
  return endingChainValueTotal(rolledRows, keyOf, (r) => r.on_hand_qty ?? 0);
}

export function lastPeriodAtsTotal(rows: IpPlanningGridRow[]): number {
  if (rows.length === 0) return 0;
  // Pass 1: latest period_start per style/color group.
  const lastPeriod = new Map<string, string>();
  for (const r of rows) {
    const g = styleColorKey(r);
    const p = r.period_start ?? "";
    const cur = lastPeriod.get(g);
    if (cur === undefined || p > cur) lastPeriod.set(g, p);
  }
  // Pass 2: sum the ending-period ATS, deduped per (sku_id, period) so a
  // SKU shared across customers isn't multiplied.
  const seen = new Set<string>();
  let total = 0;
  for (const r of rows) {
    if ((r.period_start ?? "") !== lastPeriod.get(styleColorKey(r))) continue;
    const key = `${r.sku_id}:${r.period_code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    total += r.available_supply_qty ?? 0;
  }
  return total;
}

export function computeTotals(
  rows: IpPlanningGridRow[],
  skuPeriodMath: Map<string, SkuPeriodMathLike>,
  // Display-parity totals computed by the grid over its rolled `filtered`
  // rows (endingAtsTotal / endingOnHandTotal). When provided they REPLACE
  // the raw-row aggregation so the totals strip always agrees with the
  // cells on screen. The fallbacks only serve callers with no rolled rows.
  opts?: { atsTotal?: number; onHandTotal?: number },
): GridTotals {
  const t: GridTotals = { final: 0, shortage: 0, excess: 0, actions: {}, methods: {}, columns: {} };
  const c = t.columns;
  const add = (k: string, v: number | null | undefined) => { c[k] = (c[k] ?? 0) + (v ?? 0); };
  const seenSupply = new Set<string>(); // (sku, period) — supply is per-grain, not per-row
  for (const r of rows) {
    t.final += r.final_forecast_qty;
    t.actions[r.recommended_action] = (t.actions[r.recommended_action] ?? 0) + 1;
    t.methods[r.forecast_method]    = (t.methods[r.forecast_method]    ?? 0) + 1;
    // Demand + buy — genuinely per (customer, sku, period) row, so summing is right.
    add("histT3", r.historical_trailing_qty);
    add("histLY", r.ly_reference_qty);
    add("system", r.system_forecast_qty);
    add("buyer", r.buyer_request_qty);
    add("override", r.override_qty);
    add("final", r.final_forecast_qty);
    add("buy", r.planned_buy_qty);
    add("buyDollars", (r.planned_buy_qty ?? 0) * (r.unit_cost ?? 0));
    // Supply columns are per (sku, period) — count each grain once so a SKU
    // shared across several customer rows isn't multiplied.
    const sp = `${r.sku_id}:${r.period_code}`;
    if (!seenSupply.has(sp)) {
      seenSupply.add(sp);
      // onHand raw dedupe-sum is only the FALLBACK — overridden below by
      // the display-parity ending total whenever the grid provides one.
      add("onHand", r.on_hand_qty);
      add("onSo", r.on_so_qty);
      add("receipts", r.receipts_due_qty);
      add("histRecv", r.historical_receipts_qty);
      // NB: ATS is NOT summed here. Unlike the other supply columns it is
      // a rolling balance that carries across periods, so summing every
      // period double-counts. It gets its own last-period total below.
    }
  }
  // ATS total = ending displayed ATS per rolling chain (see endingAtsTotal),
  // passed in by the grid from its rolled rows; raw-row last-period fallback
  // otherwise. Only set when there are rows to total (keeps the empty-input
  // `columns` shape { shortage, excess } unchanged, and mirrors how the
  // other supply keys only appear once a row has been seen).
  if (rows.length > 0) c.ats = opts?.atsTotal ?? lastPeriodAtsTotal(rows);
  if (rows.length > 0 && opts?.onHandTotal != null) c.onHand = opts.onHandTotal;
  // Σ Excess / Σ Shortage = sum across unique (sku, period) grains
  // from the pre-computed rolling-pool map. Single source of truth
  // shared with per-row display.
  for (const { excess, shortage } of skuPeriodMath.values()) {
    t.excess   += excess;
    t.shortage += shortage;
  }
  c.shortage = t.shortage;
  c.excess = t.excess;
  return t;
}
