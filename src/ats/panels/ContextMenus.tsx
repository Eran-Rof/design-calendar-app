import React from "react";
import { fmtDateDisplay } from "../helpers";
import type { CtxMenu, SummaryCtxMenu } from "../types";

// Shared store pill — used by both summary and cell menus
const storeTag = (store: string) => (
  <span style={{
    fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 8,
    background: store === "ROF ECOM" ? "rgba(14,165,233,0.2)" : store === "PT" ? "rgba(139,92,246,0.2)" : "rgba(59,130,246,0.2)",
    color:      store === "ROF ECOM" ? "#7dd3fc"             : store === "PT" ? "#c4b5fd"             : "#93c5fd",
  }}>{store}</span>
);

interface SummaryContextMenuProps {
  summaryCtx: SummaryCtxMenu | null;
  summaryCtxRef: React.RefObject<HTMLDivElement>;
  setSummaryCtx: (v: SummaryCtxMenu | null) => void;
}

// Right-click popup for the sticky On Hand / On Order / On PO columns.
// Shows per-SKU detail with events grouped by PO / store.
export const SummaryContextMenu: React.FC<SummaryContextMenuProps> = ({ summaryCtx, summaryCtxRef, setSummaryCtx }) => {
  if (!summaryCtx) return null;
  const { type, row, pos, sos } = summaryCtx;

  const poByStore: Record<string, number> = {};
  for (const p of pos) poByStore[p.store ?? "ROF"] = (poByStore[p.store ?? "ROF"] ?? 0) + p.qty;
  const soByStore: Record<string, number> = {};
  for (const s of sos) soByStore[s.store ?? "ROF"] = (soByStore[s.store ?? "ROF"] ?? 0) + s.qty;

  // Avg cost fallback from PO history when the row has none
  const avgCost = (() => {
    const skuPos = pos.filter(p => p.unitCost > 0);
    const totalQty = skuPos.reduce((s, p) => s + p.qty, 0);
    return totalQty > 0 ? skuPos.reduce((s, p) => s + p.qty * p.unitCost, 0) / totalQty : 0;
  })();

  return (
    <div ref={summaryCtxRef} style={{ position: "fixed", left: 0, top: 0, zIndex: 500, minWidth: 280, maxWidth: 420, filter: "drop-shadow(0 8px 24px rgba(0,0,0,0.55))" }} onClick={e => e.stopPropagation()}>
      <div data-arrow="up" style={{ position: "relative", height: 8, overflow: "visible" }}>
        <div style={{ position: "absolute", top: 0, left: 20, width: 0, height: 0, borderLeft: "9px solid transparent", borderRight: "9px solid transparent", borderBottom: "9px solid #334155", pointerEvents: "none" }} />
        <div style={{ position: "absolute", top: 1, left: 21, width: 0, height: 0, borderLeft: "8px solid transparent", borderRight: "8px solid transparent", borderBottom: "8px solid #1E293B", pointerEvents: "none" }} />
      </div>
      <div style={{ background: "#1E293B", border: "1px solid #334155", borderRadius: 10, overflow: "hidden", maxHeight: "70vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 14px 6px", borderBottom: "1px solid #1a2030", position: "sticky", top: 0, background: "#1E293B", zIndex: 1 }}>
          <span style={{ color: "#60A5FA", fontFamily: "monospace", fontWeight: 700, fontSize: 12 }}>{row.sku}</span>
          <button style={{ background: "none", border: "none", color: "#475569", fontSize: 16, cursor: "pointer", lineHeight: 1, padding: "2px 4px", borderRadius: 4 }} onClick={() => setSummaryCtx(null)}>✕</button>
        </div>

        {type === "onHand" && (
          <div>
            <div style={{ background: "rgba(241,245,249,0.08)", padding: "7px 14px", fontSize: 11, fontWeight: 700, color: "#F1F5F9", textTransform: "uppercase", letterSpacing: "0.07em", borderBottom: "1px solid #334155" }}>On Hand</div>
            <div style={{ padding: "10px 14px", fontSize: 12, borderBottom: "1px solid #1a2030" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                {storeTag(row.store ?? "ROF")}
                <span style={{ color: "#94A3B8", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.description}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
                <span style={{ color: "#F1F5F9", fontWeight: 700, fontFamily: "monospace", fontSize: 14 }}>{row.onHand.toLocaleString()} units</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 16px", marginTop: 8 }}>
                {(row.avgCost ?? 0) > 0 && <>
                  <span style={{ color: "#6B7280", fontSize: 11 }}>Avg Cost</span>
                  <span style={{ color: "#FCD34D", fontFamily: "monospace", fontWeight: 600, fontSize: 12, textAlign: "right" }}>${(row.avgCost ?? 0).toFixed(2)}</span>
                </>}
                {(row.totalAmount ?? 0) > 0 && <>
                  <span style={{ color: "#6B7280", fontSize: 11 }}>Total Value</span>
                  <span style={{ color: "#FCD34D", fontFamily: "monospace", fontWeight: 600, fontSize: 12, textAlign: "right" }}>${(row.totalAmount ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </>}
                {row.lastReceiptDate && <>
                  <span style={{ color: "#6B7280", fontSize: 11 }}>Last Received</span>
                  <span style={{ color: "#94A3B8", fontFamily: "monospace", fontSize: 12, textAlign: "right" }}>{fmtDateDisplay(row.lastReceiptDate ?? "")}</span>
                </>}
              </div>
              {avgCost > 0 && (row.avgCost ?? 0) === 0 && <div style={{ color: "#94A3B8", fontSize: 11, marginTop: 6 }}>Avg Cost (from POs): <span style={{ color: "#FCD34D", fontFamily: "monospace", fontWeight: 600 }}>${avgCost.toFixed(2)}</span></div>}
            </div>
          </div>
        )}

        {type === "onOrder" && (() => {
          // Blended unit cost: weighted average of on-hand inventory (at avgCost)
          // and all incoming POs (each at its unitCost). Matches the formula
          //   (onHandQty × avgCost + Σ poQty × poUnitCost) / (onHandQty + Σ poQty)
          const poQtySum  = pos.reduce((a, p) => a + (p.qty || 0), 0);
          const poCostSum = pos.reduce((a, p) => a + (p.qty || 0) * (p.unitCost || 0), 0);
          const onHandCostSum = (row.onHand || 0) * (row.avgCost || 0);
          const totalQty = (row.onHand || 0) + poQtySum;
          const blendedCost = totalQty > 0 ? (onHandCostSum + poCostSum) / totalQty : 0;
          // If no on-hand or on-hand has no cost, fall back to PO-only weighted avg
          const effectiveCost = blendedCost > 0 ? blendedCost : avgCost;

          const totalSoQty = sos.reduce((s, o) => s + o.qty, 0);
          const totalSoVal = sos.reduce((s, o) => s + (o.totalPrice || 0), 0);
          const totalSoCost = effectiveCost > 0 ? effectiveCost * totalSoQty : 0;
          const headerMarginPct = totalSoVal > 0 && totalSoCost > 0 ? ((totalSoVal - totalSoCost) / totalSoVal) * 100 : null;
          return (
            <div>
              <div style={{ background: "rgba(245,158,11,0.12)", padding: "7px 14px", fontSize: 11, fontWeight: 700, color: "#FCD34D", textTransform: "uppercase", letterSpacing: "0.07em", borderBottom: "1px solid #3D2E00" }}>
                Committed Sales Orders — {sos.length} line{sos.length !== 1 ? "s" : ""} · {totalSoQty.toLocaleString()} units{totalSoVal > 0 ? ` · $${totalSoVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · Avg $${(totalSoVal / totalSoQty).toFixed(2)}/unit` : ""}{headerMarginPct !== null ? ` · Margin ${headerMarginPct >= 0 ? "" : "-"}${Math.abs(headerMarginPct).toFixed(1)}%` : ""}
              </div>
              {Object.keys(soByStore).length > 1 && (
                <div style={{ padding: "6px 14px", borderBottom: "1px solid #1a2030", display: "flex", gap: 12, flexWrap: "wrap" }}>
                  {Object.entries(soByStore).map(([st, qty]) => (
                    <span key={st} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11 }}>{storeTag(st)}<span style={{ color: "#F59E0B", fontFamily: "monospace", fontWeight: 600 }}>{qty.toLocaleString()}</span></span>
                  ))}
                </div>
              )}
              {sos.map((s, i) => {
                const lineMargin = (effectiveCost > 0 && s.unitPrice > 0) ? ((s.unitPrice - effectiveCost) / s.unitPrice) * 100 : null;
                const marginColor = lineMargin === null ? "#94A3B8" : lineMargin >= 30 ? "#6EE7B7" : lineMargin >= 10 ? "#FCD34D" : "#FCA5A5";
                return (
                  <div key={i} style={{ padding: "8px 14px", borderBottom: "1px solid #1a2030", fontSize: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                      <span style={{ color: "#60A5FA", fontFamily: "monospace", fontWeight: 700 }}>{s.orderNumber || "—"}</span>
                      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>{s.store && storeTag(s.store)}<span style={{ color: "#F59E0B", fontWeight: 700 }}>{s.qty.toLocaleString()} units</span></span>
                    </div>
                    <div style={{ color: "#CBD5E1", marginBottom: 2 }}>{s.customerName || "—"}</div>
                    <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                      <span style={{ color: "#94A3B8", fontSize: 11 }}>Cancel: {fmtDateDisplay(s.date)}</span>
                      {s.unitPrice > 0 && <span style={{ color: "#94A3B8", fontSize: 11 }}>Unit: ${s.unitPrice.toFixed(2)}</span>}
                      {s.totalPrice > 0 && <span style={{ color: "#94A3B8", fontSize: 11 }}>Total: ${s.totalPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>}
                      {lineMargin !== null && <span style={{ color: marginColor, fontSize: 11, fontWeight: 600 }}>Margin {lineMargin >= 0 ? "" : "-"}{Math.abs(lineMargin).toFixed(1)}%</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })()}

        {type === "onPO" && (() => {
          const poGrouped: Record<string, { poNumber: string; vendor: string; store: string; date: string; totalQty: number; totalValue: number }> = {};
          for (const p of pos) {
            const key = p.poNumber || "Unknown";
            if (!poGrouped[key]) poGrouped[key] = { poNumber: p.poNumber, vendor: p.vendor, store: p.store, date: p.date, totalQty: 0, totalValue: 0 };
            poGrouped[key].totalQty += p.qty;
            poGrouped[key].totalValue += p.qty * (p.unitCost || 0);
            if (p.date && (!poGrouped[key].date || p.date < poGrouped[key].date)) poGrouped[key].date = p.date;
          }
          const poList = Object.values(poGrouped);
          const grandQty = poList.reduce((s, p) => s + p.totalQty, 0);
          const grandValue = poList.reduce((s, p) => s + p.totalValue, 0);
          return (
            <div>
              <div style={{ background: "rgba(16,185,129,0.12)", padding: "7px 14px", fontSize: 11, fontWeight: 700, color: "#6EE7B7", textTransform: "uppercase", letterSpacing: "0.07em", borderBottom: "1px solid #064E3B" }}>Open Purchase Orders — {poList.length} PO{poList.length !== 1 ? "s" : ""} · {grandQty.toLocaleString()} units{grandValue > 0 ? ` · $${grandValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · Avg $${(grandValue / grandQty).toFixed(2)}/unit` : ""}</div>
              {Object.keys(poByStore).length > 1 && (
                <div style={{ padding: "6px 14px", borderBottom: "1px solid #1a2030", display: "flex", gap: 12, flexWrap: "wrap" }}>
                  {Object.entries(poByStore).map(([st, qty]) => (
                    <span key={st} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11 }}>{storeTag(st)}<span style={{ color: "#10B981", fontFamily: "monospace", fontWeight: 600 }}>+{qty.toLocaleString()}</span></span>
                  ))}
                </div>
              )}
              {poList.map((p, i) => (
                <div
                  key={i}
                  style={{ padding: "8px 14px", borderBottom: "1px solid #1a2030", fontSize: 12, cursor: p.poNumber ? "pointer" : "default" }}
                  title={p.poNumber ? "Click to open PO in PO WIP" : undefined}
                  onClick={() => { if (p.poNumber) { window.open(`/tanda?po=${encodeURIComponent(p.poNumber)}`, "_blank"); setSummaryCtx(null); } }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                    <span style={{ color: "#FCD34D", fontFamily: "monospace", fontWeight: 700, textDecoration: p.poNumber ? "underline" : "none", textUnderlineOffset: 2 }}>{p.poNumber || "—"}</span>
                    <span style={{ color: "#10B981", fontWeight: 700 }}>+{p.totalQty.toLocaleString()} units</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "#CBD5E1" }}>{p.vendor || "—"}</span>
                    <span style={{ color: "#94A3B8", fontSize: 11 }}>{fmtDateDisplay(p.date)}</span>
                  </div>
                  {p.totalValue > 0 && <div style={{ color: "#94A3B8", fontSize: 11, marginTop: 2 }}>Value: <span style={{ color: "#FCD34D", fontFamily: "monospace" }}>${p.totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></div>}
                </div>
              ))}
              {grandValue > 0 && (
                <div style={{ padding: "8px 14px", background: "rgba(16,185,129,0.08)", display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                  <span style={{ color: "#6EE7B7", fontWeight: 700 }}>Total</span>
                  <span style={{ color: "#FCD34D", fontFamily: "monospace", fontWeight: 700 }}>${grandValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
              )}
            </div>
          );
        })()}
      </div>
      <div data-arrow="down" style={{ position: "relative", height: 8, overflow: "visible", display: "none" }}>
        <div style={{ position: "absolute", top: 0, left: 20, width: 0, height: 0, borderLeft: "9px solid transparent", borderRight: "9px solid transparent", borderTop: "9px solid #334155", pointerEvents: "none" }} />
        <div style={{ position: "absolute", top: 0, left: 21, width: 0, height: 0, borderLeft: "8px solid transparent", borderRight: "8px solid transparent", borderTop: "8px solid #1E293B", pointerEvents: "none" }} />
      </div>
    </div>
  );
};

interface CellContextMenuProps {
  ctxMenu: CtxMenu | null;
  ctxRef: React.RefObject<HTMLDivElement>;
  setCtxMenu: (v: CtxMenu | null) => void;
}

// Right-click popup for individual period cells. Shows PO + SO events
// on that date with totals and click-through to PO WIP.
export const CellContextMenu: React.FC<CellContextMenuProps> = ({ ctxMenu, ctxRef, setCtxMenu }) => {
  if (!ctxMenu) return null;

  return (
    <div
      ref={ctxRef}
      style={{ position: "fixed", left: ctxMenu.x, top: ctxMenu.y, zIndex: 500, minWidth: 260, maxWidth: 380, filter: "drop-shadow(0 8px 24px rgba(0,0,0,0.55))" }}
      onClick={e => e.stopPropagation()}
    >
      {!ctxMenu.flipped && (
        <div style={{ position: "relative", height: 8, overflow: "visible" }}>
          <div style={{ position: "absolute", top: 0, left: ctxMenu.arrowLeft, width: 0, height: 0, borderLeft: "9px solid transparent", borderRight: "9px solid transparent", borderBottom: "9px solid #334155", pointerEvents: "none" }} />
          <div style={{ position: "absolute", top: 1, left: ctxMenu.arrowLeft + 1, width: 0, height: 0, borderLeft: "8px solid transparent", borderRight: "8px solid transparent", borderBottom: "8px solid #1E293B", pointerEvents: "none" }} />
        </div>
      )}
      <div style={{ background: "#1E293B", border: "1px solid #334155", borderRadius: 10, overflow: "hidden" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 14px", borderBottom: "1px solid #1a2030" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{
              fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 8,
              background: ctxMenu.skuStore === "PT" ? "rgba(139,92,246,0.2)" : "rgba(59,130,246,0.2)",
              color:      ctxMenu.skuStore === "PT" ? "#c4b5fd"             : "#93c5fd",
            }}>{ctxMenu.skuStore}</span>
            <span style={{ color: "#94A3B8", fontSize: 11 }}>On Hand:</span>
            <span style={{ color: "#F1F5F9", fontFamily: "monospace", fontWeight: 700, fontSize: 12 }}>{ctxMenu.onHand.toLocaleString()}</span>
          </div>
          <button
            style={{ background: "none", border: "none", color: "#475569", fontSize: 16, cursor: "pointer", lineHeight: 1, padding: "2px 4px", borderRadius: 4 }}
            onClick={() => setCtxMenu(null)}
            title="Close"
          >✕</button>
        </div>

        {ctxMenu.sos.length > 0 && (() => {
          const unitCost = ctxMenu.unitCost ?? 0;
          const tQty = ctxMenu.sos.reduce((s, o) => s + o.qty, 0);
          const tVal = ctxMenu.sos.reduce((s, o) => s + (o.totalPrice || o.unitPrice * o.qty || 0), 0);
          const tCost = unitCost > 0 ? unitCost * tQty : 0;
          const headerMarginPct = tVal > 0 && tCost > 0 ? ((tVal - tCost) / tVal) * 100 : null;
          return (
            <div>
              <div style={{ background: "rgba(59,130,246,0.15)", padding: "7px 14px", fontSize: 11, fontWeight: 700, color: "#93C5FD", textTransform: "uppercase", letterSpacing: "0.07em", borderBottom: "1px solid #1E3A5F" }}>
                Sales Orders ({ctxMenu.sos.length}) · {tQty.toLocaleString()} units{tVal > 0 ? ` · $${tVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · Avg $${(tVal / tQty).toFixed(2)}/unit` : ""}{headerMarginPct !== null ? ` · Margin ${headerMarginPct >= 0 ? "" : "-"}${Math.abs(headerMarginPct).toFixed(1)}%` : ""}
              </div>
              {ctxMenu.sos.map((s, i) => {
                const lineMargin = (unitCost > 0 && s.unitPrice > 0) ? ((s.unitPrice - unitCost) / s.unitPrice) * 100 : null;
                const marginColor = lineMargin === null ? "#94A3B8" : lineMargin >= 30 ? "#6EE7B7" : lineMargin >= 10 ? "#FCD34D" : "#FCA5A5";
                return (
                  <div key={i} style={{ padding: "8px 14px", borderBottom: "1px solid #1a2030", fontSize: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                      <span style={{ color: "#60A5FA", fontFamily: "monospace", fontWeight: 700 }}>{s.orderNumber || "—"}</span>
                      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        {s.store && storeTag(s.store)}
                        <span style={{ color: "#10B981", fontWeight: 700 }}>{s.qty.toLocaleString()} units</span>
                      </span>
                    </div>
                    <div style={{ color: "#CBD5E1", marginBottom: 2 }}>{s.customerName || "—"}</div>
                    <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                      <span style={{ color: "#94A3B8", fontSize: 11 }}>Cancel: {fmtDateDisplay(s.date)}</span>
                      <span style={{ color: "#94A3B8", fontSize: 11 }}>Unit: ${s.unitPrice?.toFixed(2) ?? "—"}</span>
                      <span style={{ color: "#94A3B8", fontSize: 11 }}>Total: ${s.totalPrice?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) ?? "—"}</span>
                      {lineMargin !== null && <span style={{ color: marginColor, fontSize: 11, fontWeight: 600 }}>Margin {lineMargin >= 0 ? "" : "-"}{Math.abs(lineMargin).toFixed(1)}%</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })()}

        {ctxMenu.pos.length > 0 && (() => {
          const poGrp: Record<string, { poNumber: string; vendor: string; store: string; date: string; totalQty: number; totalValue: number }> = {};
          for (const p of ctxMenu.pos) {
            const k = p.poNumber || "Unknown";
            if (!poGrp[k]) poGrp[k] = { poNumber: p.poNumber, vendor: p.vendor, store: p.store, date: p.date, totalQty: 0, totalValue: 0 };
            poGrp[k].totalQty += p.qty;
            poGrp[k].totalValue += p.qty * (p.unitCost || 0);
            if (p.date && (!poGrp[k].date || p.date < poGrp[k].date)) poGrp[k].date = p.date;
          }
          const poList = Object.values(poGrp);
          const tQty = poList.reduce((s, p) => s + p.totalQty, 0);
          const tVal = poList.reduce((s, p) => s + p.totalValue, 0);
          return (
            <div>
              <div style={{ background: "rgba(245,158,11,0.15)", padding: "7px 14px", fontSize: 11, fontWeight: 700, color: "#FCD34D", textTransform: "uppercase", letterSpacing: "0.07em", borderBottom: "1px solid #3D2E00" }}>
                Purchase Orders ({poList.length}) · +{tQty.toLocaleString()} units{tVal > 0 ? ` · $${tVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · Avg $${(tVal / tQty).toFixed(2)}/unit` : ""}
              </div>
              {poList.map((p, i) => (
                <div
                  key={i}
                  style={{ padding: "8px 14px", borderBottom: "1px solid #1a2030", fontSize: 12, cursor: p.poNumber ? "pointer" : "default" }}
                  title={p.poNumber ? "Click to open PO in PO WIP" : undefined}
                  onClick={() => { if (p.poNumber) { window.open(`/tanda?po=${encodeURIComponent(p.poNumber)}`, "_blank"); setCtxMenu(null); } }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                    <span style={{ color: "#FCD34D", fontFamily: "monospace", fontWeight: 700, textDecoration: p.poNumber ? "underline" : "none", textUnderlineOffset: 2 }}>
                      {p.poNumber || "—"}
                    </span>
                    <span style={{ color: "#10B981", fontWeight: 700 }}>+{p.totalQty.toLocaleString()} units</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "#CBD5E1" }}>{p.vendor || "—"}</span>
                    <span style={{ color: "#94A3B8", fontSize: 11 }}>{fmtDateDisplay(p.date)}</span>
                  </div>
                  {p.totalValue > 0 && <div style={{ color: "#94A3B8", fontSize: 11, marginTop: 2 }}>Value: <span style={{ color: "#FCD34D", fontFamily: "monospace" }}>${p.totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></div>}
                </div>
              ))}
            </div>
          );
        })()}
      </div>
      {ctxMenu.flipped && (
        <div style={{ position: "relative", height: 8, overflow: "visible" }}>
          <div style={{ position: "absolute", top: 0, left: ctxMenu.arrowLeft, width: 0, height: 0, borderLeft: "9px solid transparent", borderRight: "9px solid transparent", borderTop: "9px solid #334155", pointerEvents: "none" }} />
          <div style={{ position: "absolute", top: 0, left: ctxMenu.arrowLeft + 1, width: 0, height: 0, borderLeft: "8px solid transparent", borderRight: "8px solid transparent", borderTop: "8px solid #1E293B", pointerEvents: "none" }} />
        </div>
      )}
    </div>
  );
};
