// Sales Performance report.
//
// Aggregates wholesale sales (the live 46k-row history) over a date window
// at a chosen grain, with this-year-vs-last-year comparison and, at SKU
// grain, an ABC class (cumulative-revenue 80/15/5 split).
//
// To avoid triple-counting the order→ship→invoice lifecycle, callers pick a
// txn_type (default "invoice" = realized revenue); "all" sums everything.

import type { ReportResult, ReportColumn } from "../types";
import type { RepSaleW } from "../services/reportsRepository";
import { type LookupCtx, num, monthOf, monthLabel, pct, round1 } from "../lib/aggUtils";

export type SalesGroupBy = "month" | "category" | "customer" | "channel" | "sku";

export interface SalesParams {
  groupBy: SalesGroupBy;
  txnType: string; // "all" or a specific txn_type
  /** TY window start ISO (inclusive). Rows before this but within 12 prior months are LY. */
  tyStartIso: string;
  /** Window end ISO (inclusive). */
  endIso: string;
}

interface Bucket {
  key: string;
  label: string;
  units: number; unitsLy: number;
  net: number; netLy: number;
  margin: number;
  orders: Set<string>;
}

export function buildSalesPerformance(
  sales: RepSaleW[],
  ctx: LookupCtx,
  params: SalesParams,
  opts?: { includeMargins?: boolean },
): ReportResult {
  // Margin visibility gate. Callers thread the viewer's margin permission here;
  // when false the "Margin %" column + summary tile are omitted. Default true
  // (fail-open) — this module cannot call the RBAC hook itself.
  const includeMargins = opts?.includeMargins !== false;
  const { groupBy, txnType, tyStartIso, endIso } = params;
  const buckets = new Map<string, Bucket>();

  const keyAndLabel = (s: RepSaleW): { key: string; label: string } => {
    switch (groupBy) {
      case "month": { const m = monthOf(s.txn_date); return { key: m, label: monthLabel(m) }; }
      case "category": { const id = s.category_id ?? ""; return { key: id, label: ctx.categoryName.get(id) || "(uncategorized)" }; }
      case "customer": { const id = s.customer_id ?? ""; return { key: id, label: ctx.customerName.get(id) || "(no customer)" }; }
      case "channel": { const id = s.channel_id ?? ""; return { key: id, label: ctx.channelName.get(id) || "(no channel)" }; }
      case "sku": {
        const it = ctx.itemById.get(s.sku_id);
        return { key: s.sku_id, label: it?.sku_code || "—" };
      }
    }
  };

  for (const s of sales) {
    if (txnType !== "all" && (s.txn_type ?? "") !== txnType) continue;
    if (!s.txn_date || s.txn_date > endIso) continue;
    const isTy = s.txn_date >= tyStartIso;
    const { key, label } = keyAndLabel(s);
    let b = buckets.get(key);
    if (!b) { b = { key, label, units: 0, unitsLy: 0, net: 0, netLy: 0, margin: 0, orders: new Set() }; buckets.set(key, b); }
    const qty = num(s.qty), net = num(s.net_amount);
    if (isTy) {
      b.units += qty; b.net += net; b.margin += num(s.margin_amount);
      if (s.order_number) b.orders.add(s.order_number);
    } else {
      b.unitsLy += qty; b.netLy += net;
    }
  }

  let list = [...buckets.values()];
  // Sort: month chronologically, everything else by TY net desc.
  if (groupBy === "month") list.sort((a, b) => a.key.localeCompare(b.key));
  else list.sort((a, b) => b.net - a.net);

  // ABC classification at SKU grain (by TY net revenue).
  const abcByKey = new Map<string, string>();
  if (groupBy === "sku") {
    const totalNet = list.reduce((s, b) => s + Math.max(0, b.net), 0);
    let cum = 0;
    for (const b of [...list].sort((a, z) => z.net - a.net)) {
      cum += Math.max(0, b.net);
      const cumPct = totalNet ? (cum / totalNet) * 100 : 100;
      abcByKey.set(b.key, cumPct <= 80 ? "A" : cumPct <= 95 ? "B" : "C");
    }
  }

  const dimHeader = { month: "Month", category: "Category", customer: "Customer", channel: "Channel", sku: "SKU" }[groupBy];

  const columns: ReportColumn[] = [
    { key: "dimension", header: dimHeader, align: "left" },
    ...(groupBy === "sku" ? [{ key: "description", header: "Description", align: "left" } as ReportColumn] : []),
    ...(groupBy === "sku" ? [{ key: "abc", header: "ABC", align: "left" } as ReportColumn] : []),
    { key: "units", header: "Units (TY)", format: "number", align: "right" },
    { key: "net_sales", header: "Net Sales (TY)", format: "currency_dollars", align: "right" },
    { key: "avg_price", header: "Avg Price", format: "currency_dollars", align: "right" },
    ...(includeMargins ? [{ key: "margin_pct", header: "Margin %", format: "percent", align: "right" } as ReportColumn] : []),
    { key: "units_ly", header: "Units (LY)", format: "number", align: "right" },
    { key: "net_sales_ly", header: "Net Sales (LY)", format: "currency_dollars", align: "right" },
    { key: "yoy_pct", header: "YoY %", format: "percent", align: "right" },
    ...(groupBy !== "month" ? [{ key: "orders", header: "Orders", format: "number", align: "right" } as ReportColumn] : []),
  ];

  const rows = list.map((b) => {
    const it = groupBy === "sku" ? ctx.itemById.get(b.key) : undefined;
    return {
      dimension: b.label,
      ...(groupBy === "sku" ? { description: it?.description || "", abc: abcByKey.get(b.key) || "" } : {}),
      units: Math.round(b.units),
      net_sales: round1(b.net),
      avg_price: b.units ? round1(b.net / b.units) : 0,
      margin_pct: pct(b.margin, b.net),
      units_ly: Math.round(b.unitsLy),
      net_sales_ly: round1(b.netLy),
      yoy_pct: b.netLy ? round1(((b.net - b.netLy) / b.netLy) * 100) : null,
      ...(groupBy !== "month" ? { orders: b.orders.size } : {}),
    };
  });

  const tyNet = list.reduce((s, b) => s + b.net, 0);
  const tyUnits = list.reduce((s, b) => s + b.units, 0);
  const lyNet = list.reduce((s, b) => s + b.netLy, 0);
  const tyMargin = list.reduce((s, b) => s + b.margin, 0);

  const summary = [
    { label: "Net Sales (TY)", value: money(tyNet) },
    { label: "Units (TY)", value: Math.round(tyUnits).toLocaleString() },
    ...(includeMargins ? [{ label: "Margin %", value: `${pct(tyMargin, tyNet)}%` }] : []),
    {
      label: "YoY",
      value: lyNet ? `${round1(((tyNet - lyNet) / lyNet) * 100)}%` : "—",
      tone: lyNet ? (tyNet >= lyNet ? "good" : "bad") as const : "default" as const,
    },
    { label: groupBy === "sku" ? "SKUs" : "Groups", value: list.length.toLocaleString() },
  ];

  return {
    columns,
    rows,
    summary,
    note: `TY = ${tyStartIso} → ${endIso}; LY = same length immediately prior. Counting txn_type "${txnType}".`,
  };
}

function money(n: number): string {
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}
