// Inventory Health report.
//
// Uses the latest snapshot per (sku, warehouse) from ip_inventory_snapshot,
// values it at best-available unit cost, and rates each SKU's coverage using
// a weekly sales velocity (passed in, computed from recent wholesale sales):
//   weeks of supply = on_hand / weekly_velocity
//   Stockout  : on_hand <= 0 on an active SKU
//   Low       : 0 < WOS < 4
//   Healthy   : 4 <= WOS <= 26
//   Excess    : WOS > 26, or stock on hand with zero recent velocity
//
// Aging by receipt date isn't available (the snapshot carries no lot/receipt
// date), so coverage bands stand in for it.

import type { ReportResult, ReportColumn } from "../types";
import type { RepInv } from "../services/reportsRepository";
import { type LookupCtx, num, round1 } from "../lib/aggUtils";

export type InvGroupBy = "sku" | "category" | "warehouse";

const LOW_WEEKS = 4;
const EXCESS_WEEKS = 26;

export interface InvParams {
  groupBy: InvGroupBy;
  /** Units sold per week per item id, from recent sales. Missing = 0. */
  weeklyVelocity: Map<string, number>;
}

interface InvRow {
  on_hand: number; available: number; committed: number; on_order: number; in_transit: number;
  value: number; velocity: number; activeStockout: boolean;
}

function classify(onHand: number, velocity: number): "Stockout" | "Low" | "Healthy" | "Excess" {
  if (onHand <= 0) return "Stockout";
  if (velocity <= 0) return "Excess"; // stock with no recent movement
  const wos = onHand / velocity;
  if (wos < LOW_WEEKS) return "Low";
  if (wos > EXCESS_WEEKS) return "Excess";
  return "Healthy";
}

export function buildInventoryHealth(inventory: RepInv[], ctx: LookupCtx, params: InvParams): ReportResult {
  const { groupBy, weeklyVelocity } = params;

  // Latest snapshot per (sku, warehouse).
  const latest = new Map<string, RepInv>();
  for (const s of inventory) {
    const k = `${s.sku_id}|${s.warehouse_code ?? ""}`;
    const ex = latest.get(k);
    if (!ex || (s.snapshot_date ?? "") > (ex.snapshot_date ?? "")) latest.set(k, s);
  }

  const buckets = new Map<string, { label: string; r: InvRow }>();
  const keyAndLabel = (s: RepInv): { key: string; label: string } => {
    if (groupBy === "warehouse") { const w = s.warehouse_code ?? "(none)"; return { key: w, label: w }; }
    const it = ctx.itemById.get(s.sku_id);
    if (groupBy === "category") {
      const id = it?.category_id ?? "";
      return { key: id, label: ctx.categoryName.get(id) || "(uncategorized)" };
    }
    return { key: s.sku_id, label: it?.sku_code || "—" };
  };

  for (const s of latest.values()) {
    const it = ctx.itemById.get(s.sku_id);
    const onHand = num(s.qty_on_hand);
    const cost = ctx.costByItemId.get(s.sku_id) ?? 0;
    const velocity = weeklyVelocity.get(s.sku_id) ?? 0;
    const { key, label } = keyAndLabel(s);
    let b = buckets.get(key);
    if (!b) { b = { label, r: { on_hand: 0, available: 0, committed: 0, on_order: 0, in_transit: 0, value: 0, velocity: 0, activeStockout: false } }; buckets.set(key, b); }
    b.r.on_hand += onHand;
    b.r.available += num(s.qty_available);
    b.r.committed += num(s.qty_committed);
    b.r.on_order += num(s.qty_on_order);
    b.r.in_transit += num(s.qty_in_transit);
    b.r.value += onHand * cost;
    b.r.velocity += velocity;
    if (onHand <= 0 && it?.active !== false) b.r.activeStockout = true;
  }

  const list = [...buckets.entries()].sort((a, z) => z[1].r.value - a[1].r.value);

  const dimHeader = { sku: "SKU", category: "Category", warehouse: "Warehouse" }[groupBy];
  const columns: ReportColumn[] = [
    { key: "dimension", header: dimHeader, align: "left" },
    ...(groupBy === "sku" ? [{ key: "description", header: "Description", align: "left" } as ReportColumn] : []),
    { key: "on_hand", header: "On Hand", format: "number", align: "right" },
    { key: "available", header: "Available", format: "number", align: "right" },
    { key: "committed", header: "Committed", format: "number", align: "right" },
    { key: "on_order", header: "On Order", format: "number", align: "right" },
    { key: "on_hand_value", header: "On-Hand $", format: "currency_dollars", align: "right" },
    { key: "weekly_velocity", header: "Wk Velocity", format: "number", digits: 1, align: "right" },
    { key: "weeks_of_supply", header: "Weeks Supply", format: "number", digits: 1, align: "right" },
    { key: "status", header: "Status", align: "left" },
  ];

  const rows = list.map(([key, b]) => {
    const wos = b.r.velocity > 0 ? round1(b.r.on_hand / b.r.velocity) : null;
    const status = groupBy === "sku" ? classify(b.r.on_hand, b.r.velocity) : rollupStatus(b.r);
    const it = groupBy === "sku" ? ctx.itemById.get(key) : undefined;
    return {
      dimension: b.label,
      ...(groupBy === "sku" ? { description: it?.description || "" } : {}),
      on_hand: Math.round(b.r.on_hand),
      available: Math.round(b.r.available),
      committed: Math.round(b.r.committed),
      on_order: Math.round(b.r.on_order),
      on_hand_value: round1(b.r.value),
      weekly_velocity: round1(b.r.velocity),
      weeks_of_supply: wos,
      status,
    };
  });

  const totalUnits = list.reduce((s, [, b]) => s + b.r.on_hand, 0);
  const totalValue = list.reduce((s, [, b]) => s + b.r.value, 0);
  const stockouts = list.filter(([, b]) => groupBy === "sku" ? classify(b.r.on_hand, b.r.velocity) === "Stockout" : b.r.activeStockout).length;
  const excess = list.filter(([, b]) => (groupBy === "sku" ? classify(b.r.on_hand, b.r.velocity) : rollupStatus(b.r)) === "Excess").length;

  const summary = [
    { label: "On-Hand Value", value: money(totalValue) },
    { label: "On-Hand Units", value: Math.round(totalUnits).toLocaleString() },
    { label: groupBy === "sku" ? "Stockout SKUs" : "Stockout groups", value: stockouts.toLocaleString(), tone: (stockouts ? "bad" : "good") as const },
    { label: groupBy === "sku" ? "Excess SKUs" : "Excess groups", value: excess.toLocaleString(), tone: (excess ? "warn" : "good") as const },
    { label: groupBy === "sku" ? "SKUs" : "Groups", value: list.length.toLocaleString() },
  ];

  return {
    columns,
    rows,
    summary,
    note: `Latest snapshot per SKU/warehouse. Coverage bands: Low < ${LOW_WEEKS}w, Excess > ${EXCESS_WEEKS}w. Velocity from recent wholesale sales.`,
  };
}

function rollupStatus(r: InvRow): "Stockout" | "Low" | "Healthy" | "Excess" {
  if (r.activeStockout) return "Stockout";
  return classify(r.on_hand, r.velocity);
}

function money(n: number): string {
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}
