// Small pure helpers shared by the report aggregators. No React, no IO —
// kept independently unit-testable.

import type { RepItem, RepAvgCost, RepNamed, RepVendor } from "../services/reportsRepository";

export interface LookupCtx {
  itemById: Map<string, RepItem>;
  categoryName: Map<string, string>;
  customerName: Map<string, string>;
  channelName: Map<string, string>;
  vendorName: Map<string, string>;
  /** Best available unit cost in dollars, keyed by item id. */
  costByItemId: Map<string, number>;
}

export function buildLookups(args: {
  items: RepItem[];
  categories: RepNamed[];
  customers: RepNamed[];
  channels: RepNamed[];
  vendors: RepVendor[];
  avgCosts: RepAvgCost[];
}): LookupCtx {
  const itemById = new Map(args.items.map((i) => [i.id, i]));
  const categoryName = new Map(args.categories.map((c) => [c.id, c.name]));
  const customerName = new Map(args.customers.map((c) => [c.id, c.name]));
  const channelName = new Map(args.channels.map((c) => [c.id, c.name]));
  const vendorName = new Map(args.vendors.map((v) => [v.id, v.name]));

  // avg cost is keyed by sku_code; fall back to item_master.unit_cost.
  const avgBySku = new Map(args.avgCosts.map((a) => [a.sku_code, num(a.avg_cost)]));
  const costByItemId = new Map<string, number>();
  for (const it of args.items) {
    const avg = avgBySku.get(it.sku_code);
    const cost = avg && avg > 0 ? avg : num(it.unit_cost);
    costByItemId.set(it.id, cost);
  }

  return { itemById, categoryName, customerName, channelName, vendorName, costByItemId };
}

export function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** ISO date (yyyy-mm-dd...) → "yyyy-mm" month bucket. */
export function monthOf(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 7) : "";
}

/** "yyyy-mm" → "Mon YYYY" for display. */
export function monthLabel(code: string): string {
  if (!/^\d{4}-\d{2}$/.test(code)) return code || "—";
  const [y, m] = code.split("-").map(Number);
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[m - 1]} ${y}`;
}

export function pct(part: number, whole: number): number {
  if (!whole) return 0;
  return round1((part / whole) * 100);
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Shift an ISO date by whole months, returning yyyy-mm-dd. */
export function shiftMonths(iso: string, delta: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + delta);
  return d.toISOString().slice(0, 10);
}
