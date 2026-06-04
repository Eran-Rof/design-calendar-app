// Buy Plan & Supply report.
//
// Two lenses over a planning run's supply picture:
//   • Demand lenses (category / sku / priority): roll up the run's buy
//     recommendations — recommended buy qty, buy $ value, shortage, excess,
//     critical count — and overlay open-PO coverage per SKU.
//   • Supply lenses (vendor / receipt month): roll up open POs — open qty,
//     open $ value, line count — to show inbound receipts by source/timing.
//
// Buy recs come from ip_inventory_recommendations (per run); open POs from
// ip_open_purchase_orders (global).

import type { ReportResult, ReportColumn } from "../types";
import type { RepRec, RepOpenPo } from "../services/reportsRepository";
import { type LookupCtx, num, monthOf, monthLabel, round1 } from "../lib/aggUtils";

export type BuyGroupBy = "category" | "sku" | "priority" | "vendor" | "receipt_month";

const BUY_TYPES = new Set(["buy", "expedite"]);
const PRIORITY_LABEL: Record<string, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };

export function buildBuyPlanSupply(
  recs: RepRec[],
  openPos: RepOpenPo[],
  ctx: LookupCtx,
  groupBy: BuyGroupBy,
): ReportResult {
  return groupBy === "vendor" || groupBy === "receipt_month"
    ? supplyView(openPos, ctx, groupBy)
    : demandView(recs, openPos, ctx, groupBy);
}

// ── Demand lens — buy recommendations + open-PO overlay ─────────────────────
function demandView(recs: RepRec[], openPos: RepOpenPo[], ctx: LookupCtx, groupBy: "category" | "sku" | "priority"): ReportResult {
  const openBySku = new Map<string, number>();
  for (const p of openPos) openBySku.set(p.sku_id, (openBySku.get(p.sku_id) ?? 0) + num(p.qty_open));

  interface B { label: string; buyQty: number; buyValue: number; shortage: number; excess: number; critical: number; openPo: number; skus: Set<string> }
  const buckets = new Map<string, B>();

  const keyAndLabel = (r: RepRec): { key: string; label: string } => {
    if (groupBy === "priority") { const p = r.priority_level ?? ""; return { key: p, label: PRIORITY_LABEL[p] || p || "(none)" }; }
    if (groupBy === "category") { const id = r.category_id ?? ""; return { key: id, label: ctx.categoryName.get(id) || "(uncategorized)" }; }
    const it = ctx.itemById.get(r.sku_id);
    return { key: r.sku_id, label: it?.sku_code || r.sku_id.slice(0, 8) };
  };

  for (const r of recs) {
    const { key, label } = keyAndLabel(r);
    let b = buckets.get(key);
    if (!b) { b = { label, buyQty: 0, buyValue: 0, shortage: 0, excess: 0, critical: 0, openPo: 0, skus: new Set() }; buckets.set(key, b); }
    const isBuy = BUY_TYPES.has(r.recommendation_type ?? "");
    const qty = isBuy ? num(r.recommendation_qty) : 0;
    const cost = ctx.costByItemId.get(r.sku_id) ?? 0;
    b.buyQty += qty;
    b.buyValue += qty * cost;
    b.shortage += num(r.shortage_qty);
    b.excess += num(r.excess_qty);
    if (r.priority_level === "critical") b.critical++;
    if (!b.skus.has(r.sku_id)) { b.skus.add(r.sku_id); b.openPo += openBySku.get(r.sku_id) ?? 0; }
  }

  const list = [...buckets.entries()].sort((a, z) => z[1].buyValue - a[1].buyValue);

  const dimHeader = { category: "Category", sku: "SKU", priority: "Priority" }[groupBy];
  const columns: ReportColumn[] = [
    { key: "dimension", header: dimHeader, align: "left" },
    ...(groupBy === "sku" ? [{ key: "description", header: "Description", align: "left" } as ReportColumn] : []),
    { key: "buy_qty", header: "Buy Qty", format: "number", align: "right" },
    { key: "buy_value", header: "Buy $", format: "currency_dollars", align: "right" },
    { key: "shortage_qty", header: "Shortage", format: "number", align: "right" },
    { key: "excess_qty", header: "Excess", format: "number", align: "right" },
    { key: "open_po_qty", header: "Open PO Qty", format: "number", align: "right" },
    { key: "critical", header: "Critical Recs", format: "number", align: "right" },
  ];

  const rows = list.map(([key, b]) => {
    const it = groupBy === "sku" ? ctx.itemById.get(key) : undefined;
    return {
      dimension: b.label,
      ...(groupBy === "sku" ? { description: it?.description || "" } : {}),
      buy_qty: Math.round(b.buyQty),
      buy_value: round1(b.buyValue),
      shortage_qty: Math.round(b.shortage),
      excess_qty: Math.round(b.excess),
      open_po_qty: Math.round(b.openPo),
      critical: b.critical,
    };
  });

  const totBuy = list.reduce((s, [, b]) => s + b.buyQty, 0);
  const totVal = list.reduce((s, [, b]) => s + b.buyValue, 0);
  const totShort = list.reduce((s, [, b]) => s + b.shortage, 0);
  const totCrit = list.reduce((s, [, b]) => s + b.critical, 0);

  const summary = [
    { label: "Buy Value", value: money(totVal) },
    { label: "Buy Units", value: Math.round(totBuy).toLocaleString() },
    { label: "Shortage Units", value: Math.round(totShort).toLocaleString(), tone: (totShort ? "warn" : "good") as const },
    { label: "Critical Recs", value: totCrit.toLocaleString(), tone: (totCrit ? "bad" : "good") as const },
    { label: groupBy === "sku" ? "SKUs" : "Groups", value: list.length.toLocaleString() },
  ];

  return { columns, rows, summary, note: "Buy qty from buy/expedite recommendations; valued at best-available unit cost. Open-PO qty overlaid per SKU." };
}

// ── Supply lens — open POs by vendor / receipt month ────────────────────────
function supplyView(openPos: RepOpenPo[], ctx: LookupCtx, groupBy: "vendor" | "receipt_month"): ReportResult {
  interface B { label: string; openQty: number; openValue: number; lines: number; sort: string }
  const buckets = new Map<string, B>();

  for (const p of openPos) {
    const qty = num(p.qty_open);
    if (qty <= 0) continue;
    let key: string, label: string, sort: string;
    if (groupBy === "vendor") {
      key = p.vendor_id ?? ""; label = (p.vendor_id && ctx.vendorName.get(p.vendor_id)) || "(unassigned)"; sort = label;
    } else {
      const m = monthOf(p.expected_date); key = m || "(no date)"; label = m ? monthLabel(m) : "(no expected date)"; sort = m || "9999";
    }
    let b = buckets.get(key);
    if (!b) { b = { label, openQty: 0, openValue: 0, lines: 0, sort }; buckets.set(key, b); }
    b.openQty += qty;
    b.openValue += qty * num(p.unit_cost);
    b.lines++;
  }

  const list = [...buckets.values()].sort((a, z) =>
    groupBy === "receipt_month" ? a.sort.localeCompare(z.sort) : z.openValue - a.openValue);

  const dimHeader = groupBy === "vendor" ? "Vendor" : "Receipt Month";
  const columns: ReportColumn[] = [
    { key: "dimension", header: dimHeader, align: "left" },
    { key: "open_po_qty", header: "Open PO Qty", format: "number", align: "right" },
    { key: "open_po_value", header: "Open PO $", format: "currency_dollars", align: "right" },
    { key: "lines", header: "PO Lines", format: "number", align: "right" },
  ];

  const rows = list.map((b) => ({
    dimension: b.label,
    open_po_qty: Math.round(b.openQty),
    open_po_value: round1(b.openValue),
    lines: b.lines,
  }));

  const totQty = list.reduce((s, b) => s + b.openQty, 0);
  const totVal = list.reduce((s, b) => s + b.openValue, 0);
  const totLines = list.reduce((s, b) => s + b.lines, 0);

  const summary = [
    { label: "Open PO Value", value: money(totVal) },
    { label: "Open PO Units", value: Math.round(totQty).toLocaleString() },
    { label: "PO Lines", value: totLines.toLocaleString() },
    { label: groupBy === "vendor" ? "Vendors" : "Months", value: list.length.toLocaleString() },
  ];

  return { columns, rows, summary, note: "Open purchase orders (qty_open > 0), valued at line unit cost." };
}

function money(n: number): string {
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}
