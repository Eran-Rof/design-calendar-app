// Secondary detail modal opened from the SummaryContextMenu's
// On Order block: clicking an SO number opens this overlay with every
// line item on that sales order. Totals row at the bottom shows the
// full-SO qty, weighted-avg unit price, weighted-avg unit cost,
// total margin $, and avg margin %.

import React from "react";
import { fmtDateDisplay } from "../helpers";

export interface SOLineItem {
  sku: string;
  description?: string;
  qty: number;
  unitPrice: number;
  totalPrice: number;
  unitCost: number;     // pulled from ip_item_master at click time
  customerName?: string;
  store?: string;
  date?: string;
  customerPo?: string;
}

interface Props {
  open: boolean;
  orderNumber: string;
  customerName: string;
  customerPo: string;
  lineItems: SOLineItem[];
  onClose: () => void;
}

function fmtUSD(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtPct(n: number): string {
  return `${n.toFixed(1)}%`;
}

export const SOLineItemsModal: React.FC<Props> = ({ open, orderNumber, customerName, customerPo, lineItems, onClose }) => {
  if (!open) return null;

  // Aggregate by SKU — the operator's data carries one row per
  // (size, allocation) so a single SKU often appears across several
  // lines. Collapse them so the modal reads at SKU grain.
  type Agg = SOLineItem & { lineCount: number };
  const byKey = new Map<string, Agg>();
  for (const li of lineItems) {
    const key = li.sku;
    const ex = byKey.get(key);
    if (ex) {
      ex.qty += li.qty;
      ex.totalPrice += li.totalPrice;
      ex.lineCount += 1;
      // Weighted-avg unit cost when masters differ across lines (rare).
      // Keep first non-zero description / store / customer / date.
      if (!ex.description && li.description) ex.description = li.description;
      if (!ex.store && li.store) ex.store = li.store;
      if (!ex.date  && li.date)  ex.date = li.date;
      if (!ex.customerName && li.customerName) ex.customerName = li.customerName;
      if (!ex.customerPo && li.customerPo) ex.customerPo = li.customerPo;
      // unitCost stays the same per sku (master-derived).
    } else {
      byKey.set(key, { ...li, lineCount: 1 });
    }
  }
  const aggs = [...byKey.values()].sort((a, b) => a.sku.localeCompare(b.sku));

  // Footer totals
  const totalQty       = aggs.reduce((s, a) => s + a.qty, 0);
  const totalRevenue   = aggs.reduce((s, a) => s + a.totalPrice, 0);
  const totalCost      = aggs.reduce((s, a) => s + a.unitCost * a.qty, 0);
  const totalMrgnDol   = totalRevenue - totalCost;
  const avgUnitPrice   = totalQty > 0 ? totalRevenue / totalQty : 0;
  const avgUnitCost    = totalQty > 0 ? totalCost    / totalQty : 0;
  const avgMrgnPct     = totalRevenue > 0 ? (totalMrgnDol / totalRevenue) * 100 : 0;

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", zIndex: 1300,
        display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "#0F172A", border: "1px solid #334155", borderRadius: 12,
          width: "92vw", maxWidth: 1200, maxHeight: "88vh",
          color: "#F1F5F9", fontFamily: "inherit",
          display: "flex", flexDirection: "column",
          boxShadow: "0 16px 48px rgba(0,0,0,0.7)",
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ padding: "14px 18px", borderBottom: "1px solid #334155", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: "#10B981", textTransform: "uppercase", letterSpacing: "0.06em" }}>Sales Order</span>
              <span style={{ fontFamily: "monospace", fontSize: 16, fontWeight: 700, color: "#60A5FA" }}>{orderNumber || "—"}</span>
              {customerPo && (
                <span style={{ fontSize: 11, color: "#94A3B8" }}>
                  Cust PO: <span style={{ color: "#CBD5E1", fontFamily: "monospace", fontWeight: 600 }}>{customerPo}</span>
                </span>
              )}
            </div>
            {customerName && (
              <span style={{ fontSize: 12, color: "#CBD5E1" }}>{customerName}</span>
            )}
          </div>
          <button
            style={{ background: "none", border: "none", color: "#64748B", fontSize: 22, cursor: "pointer", padding: "2px 8px", borderRadius: 4, lineHeight: 1 }}
            onClick={onClose}
            title="Close"
            aria-label="Close"
          >×</button>
        </div>

        <div style={{ flex: 1, overflow: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
            <thead style={{ position: "sticky", top: 0, zIndex: 1 }}>
              <tr style={{ background: "#1E293B", color: "#93C5FD", textTransform: "uppercase", letterSpacing: "0.06em", fontSize: 11 }}>
                <th style={{ padding: "8px 12px", textAlign: "left",  borderBottom: "1px solid #334155" }}>SKU</th>
                <th style={{ padding: "8px 12px", textAlign: "left",  borderBottom: "1px solid #334155" }}>Description</th>
                <th style={{ padding: "8px 12px", textAlign: "center", borderBottom: "1px solid #334155" }}>Warehouse</th>
                <th style={{ padding: "8px 12px", textAlign: "center", borderBottom: "1px solid #334155" }}>Ship Date</th>
                <th style={{ padding: "8px 12px", textAlign: "right", borderBottom: "1px solid #334155" }}>Qty</th>
                <th style={{ padding: "8px 12px", textAlign: "right", borderBottom: "1px solid #334155" }}>Unit Price</th>
                <th style={{ padding: "8px 12px", textAlign: "right", borderBottom: "1px solid #334155" }}>Total</th>
                <th style={{ padding: "8px 12px", textAlign: "right", borderBottom: "1px solid #334155" }}>Unit Cost</th>
                <th style={{ padding: "8px 12px", textAlign: "right", borderBottom: "1px solid #334155" }}>Mrgn $</th>
                <th style={{ padding: "8px 12px", textAlign: "right", borderBottom: "1px solid #334155" }}>Mrgn %</th>
              </tr>
            </thead>
            <tbody>
              {aggs.length === 0 ? (
                <tr><td colSpan={10} style={{ padding: "16px", color: "#64748B", textAlign: "center", fontStyle: "italic" }}>No line items in this sales order.</td></tr>
              ) : aggs.map((a, i) => {
                const lineRevenue = a.totalPrice;
                const lineCost    = a.unitCost * a.qty;
                const lineMrgnDol = lineRevenue - lineCost;
                const lineMrgnPct = lineRevenue > 0 ? (lineMrgnDol / lineRevenue) * 100 : 0;
                const mrgnColor   = lineMrgnPct >= 30 ? "#6EE7B7" : lineMrgnPct >= 10 ? "#FCD34D" : lineMrgnPct >= 0 ? "#F59E0B" : "#FCA5A5";
                const bg = i % 2 === 0 ? "rgba(241,245,249,0.03)" : "transparent";
                const linePrice = a.qty > 0 ? a.totalPrice / a.qty : 0;
                return (
                  <tr key={a.sku} style={{ background: bg, color: "#CBD5E1" }}>
                    <td style={{ padding: "6px 12px", fontFamily: "monospace", color: "#60A5FA", fontWeight: 600, borderBottom: "1px solid #1a2030" }}>
                      {a.sku}{a.lineCount > 1 && <span style={{ color: "#64748B", fontWeight: 400, marginLeft: 6, fontSize: 11 }}>({a.lineCount} lines)</span>}
                    </td>
                    <td style={{ padding: "6px 12px", borderBottom: "1px solid #1a2030" }}>{a.description || "—"}</td>
                    <td style={{ padding: "6px 12px", textAlign: "center", borderBottom: "1px solid #1a2030" }}>{a.store || "—"}</td>
                    <td style={{ padding: "6px 12px", textAlign: "center", borderBottom: "1px solid #1a2030" }}>{a.date ? fmtDateDisplay(a.date) : "—"}</td>
                    <td style={{ padding: "6px 12px", textAlign: "right", color: "#F59E0B", fontWeight: 600, borderBottom: "1px solid #1a2030" }}>{a.qty.toLocaleString()}</td>
                    <td style={{ padding: "6px 12px", textAlign: "right", borderBottom: "1px solid #1a2030" }}>{linePrice > 0 ? fmtUSD(linePrice) : "—"}</td>
                    <td style={{ padding: "6px 12px", textAlign: "right", borderBottom: "1px solid #1a2030" }}>{lineRevenue > 0 ? fmtUSD(lineRevenue) : "—"}</td>
                    <td style={{ padding: "6px 12px", textAlign: "right", color: "#FCD34D", borderBottom: "1px solid #1a2030" }}>{a.unitCost > 0 ? fmtUSD(a.unitCost) : "—"}</td>
                    <td style={{ padding: "6px 12px", textAlign: "right", borderBottom: "1px solid #1a2030" }}>{a.unitCost > 0 && a.qty > 0 ? fmtUSD(lineMrgnDol) : "—"}</td>
                    <td style={{ padding: "6px 12px", textAlign: "right", color: mrgnColor, fontWeight: 600, borderBottom: "1px solid #1a2030" }}>{a.unitCost > 0 && lineRevenue > 0 ? fmtPct(lineMrgnPct) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
            {aggs.length > 0 && (
              <tfoot>
                <tr style={{ background: "#1E293B", color: "#F1F5F9", fontWeight: 700, fontSize: 12, position: "sticky", bottom: 0 }}>
                  <td style={{ padding: "10px 12px", borderTop: "2px solid #334155", color: "#10B981", textTransform: "uppercase", letterSpacing: "0.06em", fontSize: 11 }}>Total</td>
                  <td style={{ padding: "10px 12px", borderTop: "2px solid #334155" }}>{aggs.length} SKU{aggs.length === 1 ? "" : "s"}</td>
                  <td style={{ padding: "10px 12px", borderTop: "2px solid #334155" }}></td>
                  <td style={{ padding: "10px 12px", borderTop: "2px solid #334155" }}></td>
                  <td style={{ padding: "10px 12px", textAlign: "right", color: "#F59E0B", borderTop: "2px solid #334155" }}>{totalQty.toLocaleString()}</td>
                  <td style={{ padding: "10px 12px", textAlign: "right", color: "#94A3B8", fontWeight: 600, borderTop: "2px solid #334155" }} title="Weighted avg">{avgUnitPrice > 0 ? fmtUSD(avgUnitPrice) : "—"}</td>
                  <td style={{ padding: "10px 12px", textAlign: "right", borderTop: "2px solid #334155" }}>{totalRevenue > 0 ? fmtUSD(totalRevenue) : "—"}</td>
                  <td style={{ padding: "10px 12px", textAlign: "right", color: "#FCD34D", borderTop: "2px solid #334155" }} title="Weighted avg">{avgUnitCost > 0 ? fmtUSD(avgUnitCost) : "—"}</td>
                  <td style={{ padding: "10px 12px", textAlign: "right", borderTop: "2px solid #334155" }}>{totalCost > 0 ? fmtUSD(totalMrgnDol) : "—"}</td>
                  <td style={{ padding: "10px 12px", textAlign: "right", color: avgMrgnPct >= 30 ? "#6EE7B7" : avgMrgnPct >= 10 ? "#FCD34D" : avgMrgnPct >= 0 ? "#F59E0B" : "#FCA5A5", borderTop: "2px solid #334155" }}>{totalCost > 0 ? fmtPct(avgMrgnPct) : "—"}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        <div style={{ padding: "10px 18px", borderTop: "1px solid #334155", display: "flex", justifyContent: "flex-end" }}>
          <button
            style={{ background: "transparent", border: "1px solid #334155", borderRadius: 6, padding: "7px 16px", color: "#CBD5E1", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}
            onClick={onClose}
          >Close</button>
        </div>
      </div>
    </div>
  );
};
