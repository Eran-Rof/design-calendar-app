// src/lib/agingSubtotals.ts
// ────────────────────────────────────────────────────────────────────────────
// Client-side subtotal interleaving for the Inventory Aging grid (Tangerine).
//
// The report endpoint returns one flat row per grain. For the "Style + Color"
// (group_by=style_color) and "Style + Color + Size" (group_by=sku) groupings the
// CEO wants SUBTOTAL rows folded into the grid:
//   • style_color → a "STYLE — subtotal" row after each style's colors.
//   • sku        → a "COLOR — subtotal" after each style+color's sizes, then a
//                   stronger "STYLE — subtotal" after all of a style's colors.
//
// This module is PURE (no React / no DOM): it takes the fetched rows + the
// active sort + the subtotals toggle and returns the display list with subtotal
// rows interleaved, group-aware sorted so a sort never tears a group apart:
//   • detail rows sort WITHIN their group by the active key,
//   • groups order by that same key applied to the group's subtotal aggregate.
//
// Aggregation mirrors the panel's own math (and the SQL in migration
// 20261090000000): SUM the additive measures, qty-weight the average age,
// recompute carrying-cost %/per-unit and weeks-of-supply from the summed values
// (reusing src/lib/inventoryAging helpers), MAX the oldest-age / last dates, and
// MIN the days-since-last-sale (most-recent sale wins).
// ────────────────────────────────────────────────────────────────────────────

import { weeksOfSupply } from "./inventoryAging";
import { sortRows, type SortDir } from "../tanda/hooks/useSort";

// The report row shape (kept structurally identical to the panel's Row type so
// the grid can render detail and synthesized subtotal rows through one path).
export interface AgingRow {
  grain_key: string;
  grain_label: string;
  style_code: string | null;
  color: string | null;
  size: string | null;
  gender: string | null;
  category_name: string | null;
  brand_name: string | null;
  vendor_name: string | null;
  location_name: string | null;
  on_hand_qty: number;
  cost_value_cents: number;
  avg_unit_cost_cents: number;
  wavg_age_days: number;
  oldest_age_days: number;
  last_received: string | null;
  b1_qty: number; b1_value_cents: number;
  b2_qty: number; b2_value_cents: number;
  b3_qty: number; b3_value_cents: number;
  b4_qty: number; b4_value_cents: number;
  b5_qty: number; b5_value_cents: number;
  b6_qty: number; b6_value_cents: number;
  int_annual_cents: number;
  sto_annual_cents: number;
  carry_pct: number;
  carry_per_unit_cents: number;
  last_sold: string | null;
  days_since_last_sale: number | null;
  units_sold_90: number | null;
  weeks_of_supply: number | null;
  uncosted_qty: number;
}

export type AgingDisplayKind = "detail" | "subtotal" | "style_subtotal";

export interface AgingDisplayItem {
  /** detail = a real report row; subtotal = color-level agg; style_subtotal = style-level agg. */
  kind: AgingDisplayKind;
  /** The row to render. For subtotal kinds this is a synthesized aggregate. */
  row: AgingRow;
  /** Stable React key. */
  reactKey: string;
  /** Subtotal label (e.g. "RYB0412 — subtotal"). Empty for detail rows. */
  label: string;
}

export interface BuildAgingDisplayOptions {
  groupBy: string;
  sortKey: string | null;
  sortDir: SortDir;
  subtotalsOn: boolean;
}

const num = (v: number | string | null | undefined): number => {
  const x = typeof v === "string" ? Number(v) : v ?? 0;
  return Number.isFinite(x as number) ? (x as number) : 0;
};

// Later of two ISO date/timestamp strings (nulls ignored). Returns the original
// string of the later date so callers keep the source formatting.
function laterIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isFinite(ta)) return b;
  if (!Number.isFinite(tb)) return a;
  return tb > ta ? b : a;
}

// Value extractor shared by detail sorting AND group ordering, mirroring the
// panel's useSort accessors so both stay in lock-step. Non-listed keys read the
// same-named scalar (style_code / color / size / grain_label strings).
export function agingSortValue(key: string, row: AgingRow): unknown {
  switch (key) {
    case "on_hand_qty": return num(row.on_hand_qty);
    case "cost_value_cents": return num(row.cost_value_cents);
    case "wavg_age_days": return num(row.wavg_age_days);
    case "oldest_age_days": return num(row.oldest_age_days);
    case "carry_pct": return num(row.carry_pct);
    case "carry_annual": return num(row.int_annual_cents) + num(row.sto_annual_cents);
    case "days_since_last_sale": return row.days_since_last_sale == null ? -1 : num(row.days_since_last_sale);
    case "weeks_of_supply": return row.weeks_of_supply == null ? Number.MAX_SAFE_INTEGER : num(row.weeks_of_supply);
    case "b6_value_cents": return num(row.b6_value_cents);
    default: return (row as unknown as Record<string, unknown>)[key];
  }
}

interface Identity { style_code: string | null; color: string | null; size: string | null }

// Aggregate a set of detail rows into one synthesized subtotal AgingRow.
export function aggregateRows(members: AgingRow[], identity: Identity): AgingRow {
  let onHand = 0, value = 0, uncosted = 0;
  const bq = [0, 0, 0, 0, 0, 0];
  const bv = [0, 0, 0, 0, 0, 0];
  let intA = 0, stoA = 0, units90 = 0, units90HasAny = false;
  let ageWeighted = 0, oldest = 0;
  let lastRecv: string | null = null, lastSold: string | null = null;
  let daysSince: number | null = null;

  for (const m of members) {
    const q = num(m.on_hand_qty);
    onHand += q;
    value += num(m.cost_value_cents);
    uncosted += num(m.uncosted_qty);
    bq[0] += num(m.b1_qty); bv[0] += num(m.b1_value_cents);
    bq[1] += num(m.b2_qty); bv[1] += num(m.b2_value_cents);
    bq[2] += num(m.b3_qty); bv[2] += num(m.b3_value_cents);
    bq[3] += num(m.b4_qty); bv[3] += num(m.b4_value_cents);
    bq[4] += num(m.b5_qty); bv[4] += num(m.b5_value_cents);
    bq[5] += num(m.b6_qty); bv[5] += num(m.b6_value_cents);
    intA += num(m.int_annual_cents);
    stoA += num(m.sto_annual_cents);
    if (m.units_sold_90 != null) { units90 += num(m.units_sold_90); units90HasAny = true; }
    ageWeighted += q * num(m.wavg_age_days);
    if (num(m.oldest_age_days) > oldest) oldest = num(m.oldest_age_days);
    lastRecv = laterIso(lastRecv, m.last_received);
    lastSold = laterIso(lastSold, m.last_sold);
    if (m.days_since_last_sale != null) {
      const d = num(m.days_since_last_sale);
      daysSince = daysSince == null ? d : Math.min(daysSince, d);
    }
  }

  const wavg = onHand > 0 ? ageWeighted / onHand : 0;
  const carryPct = value > 0 ? (intA + stoA) / value : 0;
  const carryPerUnit = onHand > 0 ? (intA + stoA) / onHand : 0;
  const avgCost = onHand > 0 ? value / onHand : 0;
  const wos = weeksOfSupply(onHand, units90);

  return {
    grain_key: `subtotal:${identity.style_code ?? ""}:${identity.color ?? ""}:${identity.size ?? ""}`,
    grain_label: "",
    style_code: identity.style_code, color: identity.color, size: identity.size,
    gender: null, category_name: null, brand_name: null, vendor_name: null, location_name: null,
    on_hand_qty: onHand, cost_value_cents: value, avg_unit_cost_cents: avgCost,
    wavg_age_days: wavg, oldest_age_days: oldest, last_received: lastRecv,
    b1_qty: bq[0], b1_value_cents: bv[0], b2_qty: bq[1], b2_value_cents: bv[1],
    b3_qty: bq[2], b3_value_cents: bv[2], b4_qty: bq[3], b4_value_cents: bv[3],
    b5_qty: bq[4], b5_value_cents: bv[4], b6_qty: bq[5], b6_value_cents: bv[5],
    int_annual_cents: intA, sto_annual_cents: stoA,
    carry_pct: carryPct, carry_per_unit_cents: carryPerUnit,
    last_sold: lastSold, days_since_last_sale: daysSince,
    units_sold_90: units90HasAny ? units90 : null, weeks_of_supply: wos,
    uncosted_qty: uncosted,
  };
}

// Group rows by a key, preserving first-appearance order of the groups.
function groupOrdered(rows: AgingRow[], keyOf: (r: AgingRow) => string | null): { raw: string | null; rows: AgingRow[] }[] {
  const map = new Map<string, { raw: string | null; rows: AgingRow[] }>();
  const order: string[] = [];
  for (const r of rows) {
    const raw = keyOf(r);
    const k = raw == null ? " null" : raw;
    let g = map.get(k);
    if (!g) { g = { raw, rows: [] }; map.set(k, g); order.push(k); }
    g.rows.push(r);
  }
  return order.map((k) => map.get(k)!);
}

const detailItem = (row: AgingRow): AgingDisplayItem => ({ kind: "detail", row, reactKey: row.grain_key, label: "" });

const labelFor = (code: string | null): string => `${code ?? "—"} — subtotal`;

// Order a set of groups by applying the active sort key to each group's
// subtotal aggregate. No sort key → preserve natural (first-appearance) order.
function orderGroups<E>(entries: E[], getSub: (e: E) => AgingRow, sortKey: string | null, sortDir: SortDir): E[] {
  if (!sortKey) return entries;
  return sortRows(entries, sortKey, sortDir, (k, e) => agingSortValue(k, getSub(e)));
}

/**
 * Build the interleaved display list for the Inventory Aging grid.
 *
 * When `subtotalsOn` is false, OR the grouping is not style_color/sku, this is a
 * pure passthrough: the rows sorted flat by the active key, each as a `detail`
 * item (no subtotal rows). Otherwise subtotal rows are folded in, group-aware
 * sorted so groups never tear apart.
 */
export function buildAgingDisplayList(rows: AgingRow[], opts: BuildAgingDisplayOptions): AgingDisplayItem[] {
  const { groupBy, sortKey, sortDir, subtotalsOn } = opts;
  const flat = (rs: AgingRow[]): AgingDisplayItem[] =>
    sortRows(rs, sortKey, sortDir, agingSortValue).map(detailItem);

  const applicable = groupBy === "style_color" || groupBy === "sku";
  if (!subtotalsOn || !applicable) return flat(rows);

  const out: AgingDisplayItem[] = [];

  if (groupBy === "style_color") {
    const styles = groupOrdered(rows, (r) => r.style_code).map((g) => ({
      raw: g.raw,
      rows: g.rows,
      sub: aggregateRows(g.rows, { style_code: g.raw, color: null, size: null }),
    }));
    for (const s of orderGroups(styles, (e) => e.sub, sortKey, sortDir)) {
      for (const m of sortRows(s.rows, sortKey, sortDir, agingSortValue)) out.push(detailItem(m));
      out.push({ kind: "style_subtotal", row: s.sub, reactKey: s.sub.grain_key, label: labelFor(s.raw) });
    }
    return out;
  }

  // groupBy === "sku": color subtotals within each style, then a style subtotal.
  const styles = groupOrdered(rows, (r) => r.style_code).map((g) => ({
    raw: g.raw,
    colors: groupOrdered(g.rows, (r) => r.color).map((cg) => ({
      raw: cg.raw,
      rows: cg.rows,
      sub: aggregateRows(cg.rows, { style_code: g.raw, color: cg.raw, size: null }),
    })),
    sub: aggregateRows(g.rows, { style_code: g.raw, color: null, size: null }),
  }));

  for (const s of orderGroups(styles, (e) => e.sub, sortKey, sortDir)) {
    for (const c of orderGroups(s.colors, (e) => e.sub, sortKey, sortDir)) {
      for (const m of sortRows(c.rows, sortKey, sortDir, agingSortValue)) out.push(detailItem(m));
      out.push({ kind: "subtotal", row: c.sub, reactKey: c.sub.grain_key, label: labelFor(c.raw) });
    }
    out.push({ kind: "style_subtotal", row: s.sub, reactKey: s.sub.grain_key, label: labelFor(s.raw) });
  }
  return out;
}
