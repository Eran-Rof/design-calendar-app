import React, { useEffect, useState } from "react";
import { itemQty, isLineClosed, lineDeliveryDate, fmtCurrency, fmtDate } from "../../utils/tandaTypes";
import { extractPpk } from "../../shared/prepack";
import { buildPoMatrix, rowExplodedTotal } from "../../shared/poMatrix";
import { computeSizeCollapse } from "../../shared/matrix";
import S from "../styles";
import type { DetailPanelCtx } from "../detailPanel";

// localStorage-persisted EXPLODE PPK toggle for the matrix tab.
// When ON, the Total column for prepack rows shows units (qty ×
// units-per-pack) with a small faded "PPKn × packs" hint
// underneath. When OFF, the column shows the raw pack count
// (legacy behavior). Persisted so the planner's preference
// survives navigation between POs.
const EXPLODE_KEY = "tanda_matrix_explode_ppk";

function useExplodePpk(): [boolean, (next: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    try { return localStorage.getItem(EXPLODE_KEY) !== "false"; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem(EXPLODE_KEY, value ? "true" : "false"); } catch { /* ignore */ }
  }, [value]);
  return [value, setValue];
}

// rowExplodedTotal (unit-grain total for a row's sizes map) now lives in the
// shared src/shared/poMatrix.ts so the vendor-portal matrix reuses it.

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
  const [explodePpk, setExplodePpk] = useExplodePpk();
  // Empty-size-column collapse — the SAME model the SO/PO entry grid + Inventory
  // Matrix use. Once any size column carries qty, the first VISIBLE size header
  // turns green + is clickable to hide the all-zero leading/trailing columns.
  const [sizesCollapsed, setSizesCollapsed] = useState(false);

  if (!selected) return null;
  if (!(detailMode === "po" || detailMode === "all")) return null;

  const items = selected.Items ?? selected.PoLineArr ?? [];
  if (items.length === 0) return null;

  // Shared transform (also used by the vendor-portal PO matrix). The PO-level
  // unit + pack totals drive the "Units: N" hint in the matrix header so the
  // planner sees the total qty without scrolling to the grand-total footer;
  // closed lines are excluded so they match the tfoot grand totals.
  const { bases, byBase, sizeOrder, parsed, totalPacks, totalUnits } = buildPoMatrix(items, selected.DateExpectedDelivery);
  const totalIsPrepack = totalUnits !== totalPacks;

  // Per-size totals across every rendered row (open + closed) — drives the green
  // collapse so a column that carries ANY visible qty is never hidden. Only the
  // genuinely-empty leading/trailing columns collapse away.
  const colTotals: Record<string, number> = {};
  for (const sz of sizeOrder) colTotals[sz] = 0;
  for (const base of bases) for (const row of byBase[base]) for (const sz of sizeOrder) colTotals[sz] += row.sizes[sz] || 0;
  const sizeCollapse = computeSizeCollapse(sizeOrder, colTotals, { enabled: true, collapsed: sizesCollapsed });
  const visibleSizes = sizeCollapse.visibleSizes;

  return (
    <>
      <div style={{ marginBottom: 8 }}>
        <div onClick={() => setMatrixCollapsed(!matrixCollapsed)}
          style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "#0F172A", borderRadius: matrixCollapsed ? 8 : "8px 8px 0 0", cursor: "pointer", userSelect: "none" }}>
          <span style={{ color: "#6B7280", fontSize: 12 }}>{matrixCollapsed ? "▶" : "▼"}</span>
          <span style={{ color: "#94A3B8", fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Item Matrix</span>
          <span style={{ color: "#6B7280", fontSize: 11, marginLeft: "auto", display: "inline-flex", flexDirection: "column", alignItems: "flex-end", lineHeight: 1.2 }}>
            <span>{bases.length} base part{bases.length !== 1 ? "s" : ""} · {sizeOrder.length} size{sizeOrder.length !== 1 ? "s" : ""}</span>
            <span style={{ color: "#9CA3AF", fontFamily: "monospace", fontSize: 10 }}>
              Units: {(explodePpk ? totalUnits : totalPacks).toLocaleString()}
              {totalIsPrepack && (
                <span style={{ color: "#4B5563", marginLeft: 6 }}>
                  ({explodePpk ? `${totalPacks.toLocaleString()} packs` : `= ${totalUnits.toLocaleString()} units`})
                </span>
              )}
            </span>
          </span>
          {/* EXPLODE PPK toggle. Stop propagation so clicking the
              chip doesn't also toggle the matrix collapsed state. */}
          <label
            onClick={(e) => e.stopPropagation()}
            title={explodePpk ? "Showing prepack totals as units (packs × units-per-pack). Click to switch to pack counts." : "Showing prepack totals as packs. Click to switch to unit grain."}
            style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", padding: "3px 8px", borderRadius: 6, border: `1px solid ${explodePpk ? "#A855F7" : "#334155"}`, background: explodePpk ? "rgba(168,85,247,0.12)" : "transparent", userSelect: "none", whiteSpace: "nowrap" }}
          >
            <input type="checkbox" checked={explodePpk} onChange={(e) => setExplodePpk(e.target.checked)} style={{ accentColor: "#A855F7", cursor: "pointer", width: 12, height: 12 }} />
            <span style={{ color: explodePpk ? "#C4B5FD" : "#9CA3AF", fontSize: 10, fontWeight: explodePpk ? 700 : 400 }}>EXPLODE PPK</span>
          </label>
        </div>
        {!matrixCollapsed && (
          <div style={{ overflowX: "auto", background: "#0F172A", borderRadius: "0 0 8px 8px" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "#0F172A" }}>
                  <th style={{ padding: "10px 14px", textAlign: "left", color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, borderBottom: "2px solid #334155" }}>Base Part</th>
                  <th style={{ padding: "10px 14px", textAlign: "left", color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, borderBottom: "2px solid #334155" }}>Description</th>
                  <th style={{ padding: "10px 14px", textAlign: "left", color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, borderBottom: "2px solid #334155" }}>Color</th>
                  {visibleSizes.map((sz, i) => {
                    const isFirst = i === 0;
                    const isLast = i === visibleSizes.length - 1;
                    const green = sizeCollapse.hasQty && isFirst;
                    const clickable = isFirst && sizeCollapse.canToggle;
                    return (
                      <th
                        key={sz}
                        onClick={clickable ? () => setSizesCollapsed(c => !c) : undefined}
                        title={clickable
                          ? (sizeCollapse.collapsedActive ? "Show all size columns" : "Hide the empty size columns before/after the sizes with quantities")
                          : undefined}
                        style={{ padding: "10px 14px", textAlign: "center", color: green ? "#10B981" : "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, borderBottom: "2px solid #334155", minWidth: 60, ...(clickable ? { cursor: "pointer", userSelect: "none" } : {}) }}
                      >
                        {sizeCollapse.collapsedActive && isFirst && sizeCollapse.hiddenLeading > 0 ? "⋯ " : ""}{sz}{sizeCollapse.collapsedActive && isLast && sizeCollapse.hiddenTrailing > 0 ? " ⋯" : ""}
                      </th>
                    );
                  })}
                  <th style={{ padding: "10px 14px", textAlign: "center", color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, borderBottom: "2px solid #334155" }}>Total</th>
                  <th style={{ padding: "10px 14px", textAlign: "right", color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, borderBottom: "2px solid #334155" }}>PO Cost</th>
                  <th style={{ padding: "10px 14px", textAlign: "right", color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, borderBottom: "2px solid #334155" }}>Total Cost</th>
                  <th style={{ padding: "10px 14px", textAlign: "center", color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: 1, borderBottom: "2px solid #334155" }}>Delivery</th>
                </tr>
              </thead>
              <tbody>
                {bases.map((base, bi) => {
                  const rows = byBase[base];
                  return rows.map((row, ri) => {
                    // Pack-grain total (legacy): sum of size qtys.
                    // Unit-grain total (when EXPLODE PPK is on):
                    // each size's qty × its PPKn multiplier (1 for
                    // non-PPK sizes). rowCost stays driven by the
                    // pack-grain total because UnitPrice in Xoro is
                    // per-pack — multiplying both qty and price
                    // would double-count.
                    const rowTotalPacks = Object.values(row.sizes).reduce((s: number, q: any) => s + q, 0);
                    const rowTotalUnits = rowExplodedTotal(row.sizes);
                    const rowIsPrepack = rowTotalUnits !== rowTotalPacks;
                    const rowTotalDisplay = explodePpk ? rowTotalUnits : rowTotalPacks;
                    const rowCost = rowTotalPacks * row.price;
                    const isLast = ri === rows.length - 1;
                    const dim = row.closed ? { opacity: 0.55, textDecoration: "line-through" as const } : {};
                    return (
                      <tr key={base + "-" + row.color + "-" + (row.closed ? "c" : "o")} style={{ borderBottom: isLast && bi < bases.length - 1 ? "2px solid #334155" : "1px solid #1E293B", background: row.closed ? "#1E1B1B" : undefined }}>
                        <td style={{ padding: "8px 14px", color: "#60A5FA", fontFamily: "monospace", fontWeight: 700, borderRight: "1px solid #334155", ...dim }}>{base}</td>
                        <td style={{ padding: "8px 14px", color: "#9CA3AF", fontSize: 12, ...dim }}>{row.desc || "—"}</td>
                        <td style={{ padding: "8px 14px", color: "#D1D5DB" }}>
                          <span style={dim}>{row.color || "—"}</span>
                          {row.closed && <span style={{ marginLeft: 8, padding: "2px 6px", borderRadius: 4, background: "#7F1D1D", color: "#FCA5A5", fontSize: 10, fontWeight: 700, letterSpacing: 0.5 }}>CLOSED</span>}
                        </td>
                        {visibleSizes.map(sz => (
                          <td key={sz} style={{ padding: "8px 14px", textAlign: "center", color: row.sizes[sz] ? "#E5E7EB" : "#334155", fontFamily: "monospace", ...dim }}>{row.sizes[sz] || "—"}</td>
                        ))}
                        <td style={{ padding: "8px 14px", textAlign: "center", color: "#F59E0B", fontWeight: 700, fontFamily: "monospace", ...dim }}>
                          <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", lineHeight: 1.15 }}>
                            <span>{rowTotalDisplay.toLocaleString()}</span>
                            {rowIsPrepack && (
                              <span style={{ color: "#6B7280", fontSize: 9, fontFamily: "monospace", opacity: 0.75, marginTop: 1, fontWeight: 400 }}>
                                {explodePpk
                                  ? `${rowTotalPacks.toLocaleString()} packs`
                                  : `= ${rowTotalUnits.toLocaleString()} units`}
                              </span>
                            )}
                          </span>
                        </td>
                        <td style={{ padding: "8px 14px", textAlign: "right", color: "#9CA3AF", fontFamily: "monospace", ...dim }}>{fmtCurrency(row.price, selected.CurrencyCode)}</td>
                        <td style={{ padding: "8px 14px", textAlign: "right", color: "#10B981", fontWeight: 600, fontFamily: "monospace", ...dim }}>{fmtCurrency(rowCost, selected.CurrencyCode)}</td>
                        <td style={{ padding: "8px 14px", textAlign: "center", color: "#60A5FA", fontFamily: "monospace", ...dim }}>{row.delivery ? fmtDate(row.delivery) : "—"}</td>
                      </tr>
                    );
                  });
                })}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: "2px solid #334155", background: "#0F172A" }}>
                  <td colSpan={3} style={{ padding: "12px 14px", color: "#9CA3AF", fontWeight: 700, textAlign: "right" }}>Grand Total</td>
                  {visibleSizes.map(sz => {
                    const colTotal = parsed.filter((p: any) => p.size === sz && !p.closed).reduce((s: number, p: any) => s + p.qty, 0);
                    return <td key={sz} style={{ padding: "12px 14px", textAlign: "center", color: "#F59E0B", fontWeight: 700, fontFamily: "monospace" }}>{colTotal}</td>;
                  })}
                  {/* Grand total reflects the toggle. Recompute unit
                      grain by walking parsed open lines and applying
                      the size's PPKn multiplier — mirrors row-level
                      rowExplodedTotal so the column footer matches
                      the sum of the row totals above. */}
                  {(() => {
                    const totalPacks = totalQty;
                    const totalUnits = parsed
                      .filter((p: any) => !p.closed)
                      .reduce((s: number, p: any) => s + (p.qty as number) * (extractPpk(p.size) ?? 1), 0);
                    const isPrepack = totalUnits !== totalPacks;
                    const display = explodePpk ? totalUnits : totalPacks;
                    return (
                      <td style={{ padding: "12px 14px", textAlign: "center", color: "#F59E0B", fontWeight: 800, fontFamily: "monospace" }}>
                        <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", lineHeight: 1.15 }}>
                          <span>{display.toLocaleString()}</span>
                          {isPrepack && (
                            <span style={{ color: "#6B7280", fontSize: 9, opacity: 0.75, marginTop: 1, fontWeight: 400 }}>
                              {explodePpk
                                ? `${totalPacks.toLocaleString()} packs`
                                : `= ${totalUnits.toLocaleString()} units`}
                            </span>
                          )}
                        </span>
                      </td>
                    );
                  })()}
                  <td style={{ padding: "12px 14px" }} />
                  <td style={{ padding: "12px 14px", textAlign: "right", color: "#10B981", fontWeight: 800, fontFamily: "monospace" }}>{fmtCurrency(total, selected.CurrencyCode)}</td>
                  <td style={{ padding: "12px 14px" }} />
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
              <span>SKU</span><span>Description</span><span>Qty</span><span>Unit Price</span><span>Total</span><span>Delivery</span>
            </div>
            {items.map((item, i) => {
              const closed = isLineClosed(item);
              const dim = closed ? { opacity: 0.55, textDecoration: "line-through" as const } : {};
              const displayQty = closed ? (item.QtyOrder ?? 0) : itemQty(item);
              const displayTotal = closed ? 0 : itemQty(item) * (item.UnitPrice ?? 0);
              const lineDate = lineDeliveryDate(item, selected.DateExpectedDelivery);
              const headerDate = (selected.DateExpectedDelivery ?? "").slice(0, 10);
              const lineDateShort = (lineDate ?? "").slice(0, 10);
              const differs = !!lineDateShort && !!headerDate && lineDateShort !== headerDate;
              return (
                <div key={i} style={{ ...S.itemRow, background: closed ? "#1E1B1B" : undefined }}>
                  <span style={{ color: "#60A5FA", fontFamily: "monospace" }}>
                    <span style={dim}>{item.ItemNumber ?? "—"}</span>
                    {closed && <span style={{ marginLeft: 8, padding: "2px 6px", borderRadius: 4, background: "#7F1D1D", color: "#FCA5A5", fontSize: 10, fontWeight: 700, letterSpacing: 0.5 }}>CLOSED</span>}
                  </span>
                  <span style={{ color: "#D1D5DB", ...dim }}>{item.Description ?? "—"}</span>
                  <span style={{ color: "#E5E7EB", textAlign: "right", ...dim }}>{displayQty}{(item.QtyReceived ?? 0) > 0 ? <span style={{ color: "#6B7280", fontSize: 10 }}> / {item.QtyOrder}</span> : ""}</span>
                  <span style={{ color: "#E5E7EB", textAlign: "right", ...dim }}>{fmtCurrency(item.UnitPrice, selected.CurrencyCode)}</span>
                  <span style={{ color: "#10B981", textAlign: "right", fontWeight: 600, ...dim }}>
                    {fmtCurrency(displayTotal, selected.CurrencyCode)}
                  </span>
                  <span style={{ color: differs ? "#F59E0B" : "#9CA3AF", fontFamily: "monospace", fontWeight: differs ? 700 : 400 }}>
                    {lineDate ? fmtDate(lineDate) : "—"}
                  </span>
                </div>
              );
            })}
            <div style={S.itemsTotal}>
              <span style={{ gridColumn: "1/5", textAlign: "right", color: "#9CA3AF" }}>Total</span>
              <span style={{ color: "#10B981", fontWeight: 700 }}>{fmtCurrency(total, selected.CurrencyCode)}</span>
              <span />
            </div>
          </div>
        )}
      </div>
    </>
  );
}
