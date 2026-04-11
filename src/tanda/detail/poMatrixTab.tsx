import React from "react";
import { itemQty, normalizeSize, sizeSort, fmtCurrency } from "../../utils/tandaTypes";
import S from "../styles";
import type { DetailPanelCtx } from "../detailPanel";

/**
 * PO / Item Matrix tab body. Renders nothing unless `detailMode` is "po"
 * or "all". Shows the size matrix grouped by base part + color, plus the
 * raw line items table beneath.
 */
export function PoMatrixTab({ ctx, total, totalQty }: { ctx: DetailPanelCtx; total: number; totalQty: number }): React.ReactElement | null {
  const {
    selected, detailMode, matrixCollapsed, setMatrixCollapsed,
    lineItemsCollapsed, setLineItemsCollapsed,
  } = ctx;

  if (!selected) return null;
  if (!(detailMode === "po" || detailMode === "all")) return null;

  const items = selected.Items ?? selected.PoLineArr ?? [];
  if (items.length === 0) return null;

  const parsed = items.map((item: any) => {
    const sku = item.ItemNumber ?? ""; const parts = sku.split("-");
    const color = parts.length === 4 ? `${parts[1]}-${parts[2]}` : (parts.length >= 2 ? parts[1] : "");
    const sz = normalizeSize(parts.length === 4 ? parts[3] : parts.length >= 3 ? parts.slice(2).join("-") : "");
    return { base: parts[0] || sku, color, size: sz, qty: itemQty(item), price: item.UnitPrice ?? 0, desc: item.Description ?? "" };
  });
  const sizeSet2 = new Set<string>();
  parsed.forEach((p: any) => { if (p.size) sizeSet2.add(p.size); });
  const sizeOrder = [...sizeSet2].sort(sizeSort);
  const bases: string[] = [];
  const byBase: Record<string, { color: string; desc: string; sizes: Record<string, number>; price: number }[]> = {};
  parsed.forEach((p: any) => {
    if (!byBase[p.base]) { byBase[p.base] = []; bases.push(p.base); }
    let row = byBase[p.base].find((r: any) => r.color === p.color);
    if (!row) { row = { color: p.color, desc: p.desc, sizes: {}, price: p.price }; byBase[p.base].push(row); }
    row.sizes[p.size] = (row.sizes[p.size] || 0) + p.qty;
  });

  return (
    <>
      <div style={{ marginBottom: 8 }}>
        <div onClick={() => setMatrixCollapsed(!matrixCollapsed)}
          style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "#0F172A", borderRadius: matrixCollapsed ? 8 : "8px 8px 0 0", cursor: "pointer", userSelect: "none" }}>
          <span style={{ color: "#6B7280", fontSize: 12 }}>{matrixCollapsed ? "▶" : "▼"}</span>
          <span style={{ color: "#94A3B8", fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Item Matrix</span>
          <span style={{ color: "#6B7280", fontSize: 11, marginLeft: "auto" }}>{bases.length} base parts · {sizeOrder.length} sizes</span>
        </div>
        {!matrixCollapsed && (
          <div style={{ overflowX: "auto", background: "#0F172A", borderRadius: "0 0 8px 8px" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "#0F172A" }}>
                  <th style={{ padding: "10px 14px", textAlign: "left", color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, borderBottom: "2px solid #334155" }}>Base Part</th>
                  <th style={{ padding: "10px 14px", textAlign: "left", color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, borderBottom: "2px solid #334155" }}>Description</th>
                  <th style={{ padding: "10px 14px", textAlign: "left", color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, borderBottom: "2px solid #334155" }}>Color</th>
                  {sizeOrder.map(sz => (
                    <th key={sz} style={{ padding: "10px 14px", textAlign: "center", color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, borderBottom: "2px solid #334155", minWidth: 60 }}>{sz}</th>
                  ))}
                  <th style={{ padding: "10px 14px", textAlign: "center", color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, borderBottom: "2px solid #334155" }}>Total</th>
                  <th style={{ padding: "10px 14px", textAlign: "right", color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, borderBottom: "2px solid #334155" }}>PO Cost</th>
                  <th style={{ padding: "10px 14px", textAlign: "right", color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, borderBottom: "2px solid #334155" }}>Total Cost</th>
                </tr>
              </thead>
              <tbody>
                {bases.map((base, bi) => {
                  const rows = byBase[base];
                  return rows.map((row, ri) => {
                    const rowTotal = Object.values(row.sizes).reduce((s: number, q: any) => s + q, 0);
                    const rowCost = rowTotal * row.price;
                    const isLast = ri === rows.length - 1;
                    return (
                      <tr key={base + "-" + row.color} style={{ borderBottom: isLast && bi < bases.length - 1 ? "2px solid #334155" : "1px solid #1E293B" }}>
                        <td style={{ padding: "8px 14px", color: "#60A5FA", fontFamily: "monospace", fontWeight: 700, borderRight: "1px solid #334155" }}>{base}</td>
                        <td style={{ padding: "8px 14px", color: "#9CA3AF", fontSize: 12 }}>{row.desc || "—"}</td>
                        <td style={{ padding: "8px 14px", color: "#D1D5DB" }}>{row.color || "—"}</td>
                        {sizeOrder.map(sz => (
                          <td key={sz} style={{ padding: "8px 14px", textAlign: "center", color: row.sizes[sz] ? "#E5E7EB" : "#334155", fontFamily: "monospace" }}>{row.sizes[sz] || "—"}</td>
                        ))}
                        <td style={{ padding: "8px 14px", textAlign: "center", color: "#F59E0B", fontWeight: 700, fontFamily: "monospace" }}>{rowTotal}</td>
                        <td style={{ padding: "8px 14px", textAlign: "right", color: "#9CA3AF", fontFamily: "monospace" }}>{fmtCurrency(row.price, selected.CurrencyCode)}</td>
                        <td style={{ padding: "8px 14px", textAlign: "right", color: "#10B981", fontWeight: 600, fontFamily: "monospace" }}>{fmtCurrency(rowCost, selected.CurrencyCode)}</td>
                      </tr>
                    );
                  });
                })}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: "2px solid #334155", background: "#0F172A" }}>
                  <td colSpan={3} style={{ padding: "12px 14px", color: "#9CA3AF", fontWeight: 700, textAlign: "right" }}>Grand Total</td>
                  {sizeOrder.map(sz => {
                    const colTotal = parsed.filter((p: any) => p.size === sz).reduce((s: number, p: any) => s + p.qty, 0);
                    return <td key={sz} style={{ padding: "12px 14px", textAlign: "center", color: "#F59E0B", fontWeight: 700, fontFamily: "monospace" }}>{colTotal}</td>;
                  })}
                  <td style={{ padding: "12px 14px", textAlign: "center", color: "#F59E0B", fontWeight: 800, fontFamily: "monospace" }}>{totalQty}</td>
                  <td style={{ padding: "12px 14px" }} />
                  <td style={{ padding: "12px 14px", textAlign: "right", color: "#10B981", fontWeight: 800, fontFamily: "monospace" }}>{fmtCurrency(total, selected.CurrencyCode)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      <div style={{ marginBottom: 20 }}>
        <div onClick={() => setLineItemsCollapsed(!lineItemsCollapsed)}
          style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "#0F172A", borderRadius: lineItemsCollapsed ? 8 : "8px 8px 0 0", cursor: "pointer", userSelect: "none" }}>
          <span style={{ color: "#6B7280", fontSize: 12 }}>{lineItemsCollapsed ? "▶" : "▼"}</span>
          <span style={{ color: "#94A3B8", fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Line Items</span>
          <span style={{ color: "#6B7280", fontSize: 11, marginLeft: "auto" }}>{items.length} items</span>
        </div>
        {!lineItemsCollapsed && (
          <div style={{ ...S.itemsTable, borderRadius: "0 0 8px 8px" }}>
            <div style={S.itemsHeader}>
              <span>SKU</span><span>Description</span><span>Qty</span><span>Unit Price</span><span>Total</span>
            </div>
            {items.map((item, i) => (
              <div key={i} style={S.itemRow}>
                <span style={{ color: "#60A5FA", fontFamily: "monospace" }}>{item.ItemNumber ?? "—"}</span>
                <span style={{ color: "#D1D5DB" }}>{item.Description ?? "—"}</span>
                <span style={{ color: "#E5E7EB", textAlign: "right" }}>{itemQty(item)}{(item.QtyReceived ?? 0) > 0 ? <span style={{ color: "#6B7280", fontSize: 10 }}> / {item.QtyOrder}</span> : ""}</span>
                <span style={{ color: "#E5E7EB", textAlign: "right" }}>{fmtCurrency(item.UnitPrice, selected.CurrencyCode)}</span>
                <span style={{ color: "#10B981", textAlign: "right", fontWeight: 600 }}>
                  {fmtCurrency(itemQty(item) * (item.UnitPrice ?? 0), selected.CurrencyCode)}
                </span>
              </div>
            ))}
            <div style={S.itemsTotal}>
              <span style={{ gridColumn: "1/5", textAlign: "right", color: "#9CA3AF" }}>Total</span>
              <span style={{ color: "#10B981", fontWeight: 700 }}>{fmtCurrency(total, selected.CurrencyCode)}</span>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
