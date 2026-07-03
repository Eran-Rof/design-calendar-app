import React, { useEffect, useState } from "react";
import { fmtDateDisplay } from "../helpers";
import type { CtxMenu, SummaryCtxMenu } from "../types";
import { getSkuSalesAggregates, type SkuSalesAggregates } from "../exportSalesFetch";
import { askAI, buildRowAskPrompt } from "../../ai/askAIBridge";

// Shared store pill — used by both summary and cell menus
const storeTag = (store: string) => {
  const bg = store === "ROF ECOM" ? "rgba(14,165,233,0.2)"
           : store === "PT"       ? "rgba(139,92,246,0.2)"
           : store === "PT ECOM"  ? "rgba(236,72,153,0.2)"
           :                        "rgba(59,130,246,0.2)";
  const fg = store === "ROF ECOM" ? "#7dd3fc"
           : store === "PT"       ? "#c4b5fd"
           : store === "PT ECOM"  ? "#f9a8d4"
           :                        "#93c5fd";
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 8,
      background: bg, color: fg,
    }}>{store}</span>
  );
};

interface SummaryContextMenuProps {
  summaryCtx: SummaryCtxMenu | null;
  summaryCtxRef: React.RefObject<HTMLDivElement>;
  setSummaryCtx: (v: SummaryCtxMenu | null) => void;
  // Grid's current customer filter — narrows the T3 / SP-LY blocks
  // shown beneath On Order so the right-click context matches the
  // operator's grid scope. Empty string = no customer narrow.
  customerFilter?: string;
  // Click handler for the SO order number in the On Order block.
  // Opens the SOLineItemsModal at the renderPanel level with every
  // line on that sales order.
  onOpenSoDetails?: (orderNumber: string) => void;
}

// Right-click popup for the sticky On Hand / On Order / On PO columns.
// Shows per-SKU detail with events grouped by PO / store.
export const SummaryContextMenu: React.FC<SummaryContextMenuProps> = ({ summaryCtx, summaryCtxRef, setSummaryCtx, customerFilter, onOpenSoDetails }) => {
  // T3 / SP-LY aggregates for the On Order surface. Loaded async from
  // the preloaded sales-history cache. null while loading / unloaded;
  // the empty-zero object means the fetch ran but found nothing.
  const [salesAgg, setSalesAgg] = useState<SkuSalesAggregates | null>(null);
  const [salesLoading, setSalesLoading] = useState(false);

  useEffect(() => {
    setSalesAgg(null);
    if (!summaryCtx || summaryCtx.type !== "onOrder") return;
    let cancelled = false;
    setSalesLoading(true);
    getSkuSalesAggregates(summaryCtx.row.sku, customerFilter ?? "")
      .then(r => { if (!cancelled) setSalesAgg(r); })
      .catch(e => { if (!cancelled) { console.error("[ats-summary-menu] sales fetch failed:", e); setSalesAgg(null); } })
      .finally(() => { if (!cancelled) setSalesLoading(false); });
    return () => { cancelled = true; };
  }, [summaryCtx, customerFilter]);

  if (!summaryCtx) return null;
  const { type, row, pos, sos } = summaryCtx;

  // Grain — pack-aware. Available to onHand / onOrder / onPO blocks so
  // every header line can append "/<ppkMult> Each $X" alongside the
  // /pack avg (per operator request — see PR #393 for the SO column).
  const ppkMult = row.ppkMult ?? 1;
  const isPrepack = ppkMult > 1;

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
    <div ref={summaryCtxRef} style={{ position: "fixed", left: summaryCtx.initialX, top: summaryCtx.initialY, zIndex: 500, minWidth: 280, maxWidth: 420, filter: "drop-shadow(0 8px 24px rgba(0,0,0,0.55))" }} onClick={e => e.stopPropagation()}>
      <div data-arrow="up" style={{ position: "relative", height: 8, overflow: "visible" }}>
        <div style={{ position: "absolute", top: 0, left: 20, width: 0, height: 0, borderLeft: "9px solid transparent", borderRight: "9px solid transparent", borderBottom: "9px solid #334155", pointerEvents: "none" }} />
        <div style={{ position: "absolute", top: 1, left: 21, width: 0, height: 0, borderLeft: "8px solid transparent", borderRight: "8px solid transparent", borderBottom: "8px solid #1E293B", pointerEvents: "none" }} />
      </div>
      <div data-popup-body style={{ background: "#1E293B", border: "1px solid #334155", borderRadius: 10, overflow: "hidden", maxHeight: "70vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 14px 6px", borderBottom: "1px solid #1a2030", position: "sticky", top: 0, background: "#1E293B", zIndex: 1 }}>
          <span style={{ color: "#60A5FA", fontFamily: "monospace", fontWeight: 700, fontSize: 12 }}>{row.sku}</span>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {/* PR 4/4: "Ask Claude about this row" — dispatches a
                CustomEvent picked up by NavBar, which opens AskAIPanel
                with a generated prompt about this SKU. */}
            <button
              title="Ask Claude about this row"
              onClick={() => {
                const prompt = buildRowAskPrompt({
                  sku: row.sku,
                  style: row.styleCode,
                  description: row.description,
                  category: row.category,
                  store: row.store ?? undefined,
                  onHand: row.onHand,
                  onOrder: row.onOrder,
                  onPO: row.onPO,
                  extras: {
                    "Avg cost": typeof row.avgCost === "number" && row.avgCost > 0 ? `$${row.avgCost.toFixed(2)}` : null,
                    "Pack size": (row.ppkMult ?? 1) > 1 ? row.ppkMult : null,
                    "Right-click context": type,
                  },
                });
                askAI({ prompt, source: `ats-summary-${type}` });
                setSummaryCtx(null);
              }}
              style={{
                background: "linear-gradient(135deg, #6D28D9, #7C3AED)",
                color: "#fff", border: "1px solid #5B21B6",
                borderRadius: 4, padding: "2px 8px",
                fontSize: 10, fontWeight: 700, cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Ask Claude
            </button>
            <button style={{ background: "none", border: "none", color: "#475569", fontSize: 16, cursor: "pointer", lineHeight: 1, padding: "2px 4px", borderRadius: 4 }} onClick={() => setSummaryCtx(null)}>✕</button>
          </div>
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
                  <span style={{ color: "#FCD34D", fontFamily: "monospace", fontWeight: 600, fontSize: 12, textAlign: "right" }}>{isPrepack
                    ? `$${((row.avgCost ?? 0) * ppkMult).toFixed(2)}/pack/${ppkMult} Each $${(row.avgCost ?? 0).toFixed(2)}`
                    : `$${(row.avgCost ?? 0).toFixed(2)}`}</span>
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
              {avgCost > 0 && (row.avgCost ?? 0) === 0 && <div style={{ color: "#94A3B8", fontSize: 11, marginTop: 6 }}>Avg Cost (from POs): <span style={{ color: "#FCD34D", fontFamily: "monospace", fontWeight: 600 }}>{isPrepack
                ? `$${avgCost.toFixed(2)}/pack/${ppkMult} Each $${(avgCost / ppkMult).toFixed(2)}`
                : `$${avgCost.toFixed(2)}`}</span></div>}
            </div>
          </div>
        )}

        {type === "onOrder" && (() => {
          // PPK grain reconciliation. computeRowsFromExcelData stores
          // qty fields at UNIT grain (onHand × ppkMult) and cost fields
          // at UNIT grain (avgCost / ppkMult). Raw PO/SO event arrays
          // (`pos`, `sos`) are still at PACK grain (Xoro stores them
          // that way). Without converting, multiplying a per-unit cost
          // by a pack qty under-counts the cost by ppkMult — and the
          // margin came out 97% on a 35%-real-margin prepack because
          // 142 packs × $5.625/unit = $799 instead of 142 × $135/pack
          // = $19,170. Convert raw qtys to unit grain before doing
          // weighted-avg / margin math; ppkMult=1 for non-prepacks
          // makes the conversion a no-op.
          const ppkMult = row.ppkMult ?? 1;

          // Blended unit cost: weighted average of on-hand inventory
          // (at row.avgCost, per-unit) and all incoming POs (raw qty
          // exploded to units; raw unitCost / ppkMult for per-unit).
          //   (onHandUnits × avgCost + Σ (poQty × ppkMult) × (poUnitCost / ppkMult))
          //   / (onHandUnits + Σ poQty × ppkMult)
          const poQtySumUnits  = pos.reduce((a, p) => a + (p.qty || 0) * ppkMult, 0);
          // poCostSum is total value either way: poQty(packs) × poUnitCost(per-pack)
          // == (poQty × ppkMult)(units) × (poUnitCost / ppkMult)(per-unit).
          const poCostSum = pos.reduce((a, p) => a + (p.qty || 0) * (p.unitCost || 0), 0);
          const onHandCostSum = (row.onHand || 0) * (row.avgCost || 0);
          const totalQtyUnits = (row.onHand || 0) + poQtySumUnits;
          const blendedCost = totalQtyUnits > 0 ? (onHandCostSum + poCostSum) / totalQtyUnits : 0;
          // PO-only fallback `avgCost` (computed at parent scope) is at
          // PACK grain; convert to per-unit for the same effective grain.
          const avgCostPerUnit = ppkMult > 0 ? avgCost / ppkMult : avgCost;
          const effectiveCost = blendedCost > 0 ? blendedCost : avgCostPerUnit;

          // Collapse raw SO line items by orderNumber. A single SO can
          // arrive as multiple rows (one per allocation / size / ship-
          // line) — the menu was rendering each separately so a 4-line
          // order showed as 4 rows. Match the cell-menu behavior:
          // group by orderNumber and sum qty + totalPrice, weighted-avg
          // unit price, earliest cancel date, first non-empty customer
          // / customerPo / store.
          type SoGroup = {
            orderNumber: string;
            qty: number;          // packs
            totalPrice: number;
            customerName: string;
            customerPo: string;
            store: string;
            date: string;
            lineCount: number;
          };
          const soGrp: Record<string, SoGroup> = {};
          for (const o of sos) {
            const k = o.orderNumber || "Unknown";
            if (!soGrp[k]) {
              soGrp[k] = {
                orderNumber: o.orderNumber,
                qty: 0,
                totalPrice: 0,
                customerName: o.customerName ?? "",
                customerPo: o.customerPo ?? "",
                store: o.store ?? "",
                date: o.date ?? "",
                lineCount: 0,
              };
            }
            const g = soGrp[k];
            g.qty += o.qty || 0;
            g.totalPrice += (o.totalPrice ?? (o.unitPrice ?? 0) * (o.qty ?? 0)) || 0;
            g.lineCount += 1;
            if (!g.customerName && o.customerName) g.customerName = o.customerName;
            if (!g.customerPo && o.customerPo) g.customerPo = o.customerPo;
            if (!g.store && o.store) g.store = o.store;
            if (o.date && (!g.date || o.date < g.date)) g.date = o.date;
          }
          const soList = Object.values(soGrp);

          // Header totals run off the raw `sos` (pre-collapse) so the
          // dollar / qty / margin numbers don't change — only the
          // per-row rendering compresses.
          const totalSoQtyPacks = sos.reduce((s, o) => s + (o.qty || 0), 0);
          const totalSoQtyUnits = totalSoQtyPacks * ppkMult;
          const totalSoVal = sos.reduce((s, o) => s + (o.totalPrice || 0), 0);
          const totalSoCost = effectiveCost > 0 ? effectiveCost * totalSoQtyUnits : 0;
          const headerMarginPct = totalSoVal > 0 && totalSoCost > 0 ? ((totalSoVal - totalSoCost) / totalSoVal) * 100 : null;
          const isPrepack = ppkMult > 1;
          return (
            <div>
              <div style={{ background: "rgba(245,158,11,0.12)", padding: "7px 14px", fontSize: 11, fontWeight: 700, color: "#FCD34D", textTransform: "uppercase", letterSpacing: "0.07em", borderBottom: "1px solid #3D2E00" }}>
                Committed Sales Orders — {soList.length} order{soList.length !== 1 ? "s" : ""} · {isPrepack
                  ? `${totalSoQtyPacks.toLocaleString()} pack${totalSoQtyPacks !== 1 ? "s" : ""} (${totalSoQtyUnits.toLocaleString()} units)`
                  : `${totalSoQtyPacks.toLocaleString()} units`}{totalSoVal > 0 ? ` · $${totalSoVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · Avg $${(totalSoVal / totalSoQtyPacks).toFixed(2)}/${isPrepack ? "pack" : "unit"}${isPrepack ? `/${ppkMult} Each $${(totalSoVal / totalSoQtyPacks / ppkMult).toFixed(2)}` : ""}` : ""}{headerMarginPct !== null ? ` · Margin ${headerMarginPct >= 0 ? "" : "-"}${Math.abs(headerMarginPct).toFixed(1)}%` : ""}
              </div>
              {Object.keys(soByStore).length > 1 && (
                <div style={{ padding: "6px 14px", borderBottom: "1px solid #1a2030", display: "flex", gap: 12, flexWrap: "wrap" }}>
                  {Object.entries(soByStore).map(([st, qty]) => (
                    <span key={st} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11 }}>{storeTag(st)}<span style={{ color: "#F59E0B", fontFamily: "monospace", fontWeight: 600 }}>{qty.toLocaleString()}</span></span>
                  ))}
                </div>
              )}
              {soList.map((g, i) => {
                // Weighted-avg unit price across the collapsed lines.
                const grpUnitPrice = g.qty > 0 ? g.totalPrice / g.qty : 0;
                // Per-line margin: grpUnitPrice is per-pack (raw Xoro);
                // effectiveCost is per-unit. Multiply effectiveCost by
                // ppkMult to land both in pack grain. For non-prepacks
                // ppkMult=1 so the math is unchanged.
                const lineMargin = (effectiveCost > 0 && grpUnitPrice > 0)
                  ? ((grpUnitPrice - effectiveCost * ppkMult) / grpUnitPrice) * 100
                  : null;
                const marginColor = lineMargin === null ? "#94A3B8" : lineMargin >= 30 ? "#6EE7B7" : lineMargin >= 10 ? "#FCD34D" : "#FCA5A5";
                const lineQtyDisplay = isPrepack
                  ? `${g.qty.toLocaleString()} pack${g.qty !== 1 ? "s" : ""} (${(g.qty * ppkMult).toLocaleString()} units)`
                  : `${g.qty.toLocaleString()} units`;
                return (
                  <div key={i} style={{ padding: "8px 14px", borderBottom: "1px solid #1a2030", fontSize: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                      <span style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                        {g.orderNumber && onOpenSoDetails ? (
                          <button
                            type="button"
                            onClick={() => onOpenSoDetails(g.orderNumber)}
                            style={{
                              background: "none", border: "none", padding: 0,
                              color: "#60A5FA", fontFamily: "monospace", fontWeight: 700,
                              cursor: "pointer", textDecoration: "underline",
                              textUnderlineOffset: 2, fontSize: "inherit",
                            }}
                            title="Open full sales order detail"
                          >
                            {g.orderNumber}
                            {g.lineCount > 1 && <span style={{ color: "#64748B", fontWeight: 400, marginLeft: 6, textDecoration: "none" }}>({g.lineCount} lines)</span>}
                          </button>
                        ) : (
                          <span style={{ color: "#60A5FA", fontFamily: "monospace", fontWeight: 700 }}>
                            {g.orderNumber || "—"}
                            {g.lineCount > 1 && <span style={{ color: "#64748B", fontWeight: 400, marginLeft: 6 }}>({g.lineCount} lines)</span>}
                          </span>
                        )}
                        {g.customerPo && (
                          <span style={{ fontSize: 11, color: "#94A3B8" }}>
                            Cust PO: <span style={{ color: "#CBD5E1", fontFamily: "monospace", fontWeight: 600 }}>{g.customerPo}</span>
                          </span>
                        )}
                      </span>
                      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>{g.store && storeTag(g.store)}<span style={{ color: "#F59E0B", fontWeight: 700 }}>{lineQtyDisplay}</span></span>
                    </div>
                    <div style={{ color: "#CBD5E1", marginBottom: 2 }}>{g.customerName || "—"}</div>
                    <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                      <span style={{ color: "#94A3B8", fontSize: 11 }}>Cancel: {fmtDateDisplay(g.date)}</span>
                      {grpUnitPrice > 0 && <span style={{ color: "#94A3B8", fontSize: 11 }}>{isPrepack ? "Pack" : "Unit"}: ${grpUnitPrice.toFixed(2)}</span>}
                      {g.totalPrice > 0 && <span style={{ color: "#94A3B8", fontSize: 11 }}>Total: ${g.totalPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>}
                      {lineMargin !== null && <span style={{ color: marginColor, fontSize: 11, fontWeight: 600 }}>Margin {lineMargin >= 0 ? "" : "-"}{Math.abs(lineMargin).toFixed(1)}%</span>}
                    </div>
                  </div>
                );
              })}

              {/* T3 + SP-LY blocks (same windows as the Excel export) */}
              <SalesHistorySection
                salesAgg={salesAgg}
                loading={salesLoading}
                avgCost={effectiveCost}
                ppkMult={ppkMult}
                customerFilter={customerFilter ?? ""}
              />
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
              <div style={{ background: "rgba(16,185,129,0.12)", padding: "7px 14px", fontSize: 11, fontWeight: 700, color: "#6EE7B7", textTransform: "uppercase", letterSpacing: "0.07em", borderBottom: "1px solid #064E3B" }}>Open Purchase Orders — {poList.length} PO{poList.length !== 1 ? "s" : ""} · {isPrepack
                ? `${grandQty.toLocaleString()} pack${grandQty !== 1 ? "s" : ""} (${(grandQty * ppkMult).toLocaleString()} units)`
                : `${grandQty.toLocaleString()} units`}{grandValue > 0 ? ` · $${grandValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · Avg $${(grandValue / grandQty).toFixed(2)}/${isPrepack ? "pack" : "unit"}${isPrepack ? `/${ppkMult} Each $${(grandValue / grandQty / ppkMult).toFixed(2)}` : ""}` : ""}</div>
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

  // Grain — pack-aware. Used by both the SO and PO sub-blocks below so
  // each header line can append "/<ppkMult> Each $X" alongside the
  // /pack avg (operator request, mirrors PR #393's SO change).
  const ppkMult = ctxMenu.ppkMult ?? 1;
  const isPrepack = ppkMult > 1;

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
          // unitCost is per-unit (the build site converts blended cost
          // to unit grain). SO qty is at pack grain (raw Xoro). Multiply
          // qty by ppkMult to land in the same grain as unitCost so the
          // margin math is correct on prepack rows. ppkMult=1 for
          // non-prepack rows leaves behavior unchanged.
          const unitCost = ctxMenu.unitCost ?? 0;
          const ppkMult = ctxMenu.ppkMult ?? 1;
          const isPrepack = ppkMult > 1;
          // Group raw SO line items by orderNumber. A single SO can
          // arrive as multiple rows (one per allocation / size / ship-
          // line) and the cell popup was rendering each separately —
          // 13 line items showed as 13 rows even when they belonged to
          // 2 underlying orders. Collapse by orderNumber: sum qty +
          // totalPrice, weighted-avg unitPrice (totalPrice / qty),
          // earliest cancel date, first non-empty customer/store.
          type SoGroup = {
            orderNumber: string;
            qty: number;            // packs
            totalPrice: number;
            customerName: string;
            customerPo: string;
            store: string;
            date: string;
            lineCount: number;
          };
          const soGrp: Record<string, SoGroup> = {};
          for (const o of ctxMenu.sos) {
            const k = o.orderNumber || "Unknown";
            if (!soGrp[k]) {
              soGrp[k] = {
                orderNumber: o.orderNumber,
                qty: 0,
                totalPrice: 0,
                customerName: o.customerName ?? "",
                customerPo: o.customerPo ?? "",
                store: o.store ?? "",
                date: o.date ?? "",
                lineCount: 0,
              };
            }
            const g = soGrp[k];
            g.qty += o.qty || 0;
            g.totalPrice += (o.totalPrice ?? (o.unitPrice ?? 0) * (o.qty ?? 0)) || 0;
            g.lineCount += 1;
            if (!g.customerName && o.customerName) g.customerName = o.customerName;
            if (!g.customerPo && o.customerPo) g.customerPo = o.customerPo;
            if (!g.store && o.store) g.store = o.store;
            if (o.date && (!g.date || o.date < g.date)) g.date = o.date;
          }
          const soList = Object.values(soGrp);
          const tQtyPacks = soList.reduce((s, o) => s + o.qty, 0);
          const tQtyUnits = tQtyPacks * ppkMult;
          const tVal = soList.reduce((s, o) => s + o.totalPrice, 0);
          const tCost = unitCost > 0 ? unitCost * tQtyUnits : 0;
          const headerMarginPct = tVal > 0 && tCost > 0 ? ((tVal - tCost) / tVal) * 100 : null;
          return (
            <div>
              <div style={{ background: "rgba(59,130,246,0.15)", padding: "7px 14px", fontSize: 11, fontWeight: 700, color: "#93C5FD", textTransform: "uppercase", letterSpacing: "0.07em", borderBottom: "1px solid #1E3A5F" }}>
                Sales Orders ({soList.length}) · {isPrepack
                  ? `${tQtyPacks.toLocaleString()} pack${tQtyPacks !== 1 ? "s" : ""} (${tQtyUnits.toLocaleString()} units)`
                  : `${tQtyPacks.toLocaleString()} units`}{tVal > 0 ? ` · $${tVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · Avg $${(tVal / tQtyPacks).toFixed(2)}/${isPrepack ? "pack" : "unit"}${isPrepack ? `/${ppkMult} Each $${(tVal / tQtyPacks / ppkMult).toFixed(2)}` : ""}` : ""}{headerMarginPct !== null ? ` · Margin ${headerMarginPct >= 0 ? "" : "-"}${Math.abs(headerMarginPct).toFixed(1)}%` : ""}
              </div>
              {soList.map((g, i) => {
                // Weighted-avg unit price across the collapsed lines.
                const grpUnitPrice = g.qty > 0 ? g.totalPrice / g.qty : 0;
                const lineMargin = (unitCost > 0 && grpUnitPrice > 0)
                  ? ((grpUnitPrice - unitCost * ppkMult) / grpUnitPrice) * 100
                  : null;
                const marginColor = lineMargin === null ? "#94A3B8" : lineMargin >= 30 ? "#6EE7B7" : lineMargin >= 10 ? "#FCD34D" : "#FCA5A5";
                const lineQtyDisplay = isPrepack
                  ? `${g.qty.toLocaleString()} pack${g.qty !== 1 ? "s" : ""} (${(g.qty * ppkMult).toLocaleString()} units)`
                  : `${g.qty.toLocaleString()} units`;
                return (
                  <div key={i} style={{ padding: "8px 14px", borderBottom: "1px solid #1a2030", fontSize: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                      <span style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                        <span style={{ color: "#60A5FA", fontFamily: "monospace", fontWeight: 700 }}>
                          {g.orderNumber || "—"}
                          {g.lineCount > 1 && <span style={{ color: "#64748B", fontWeight: 400, marginLeft: 6 }}>({g.lineCount} lines)</span>}
                        </span>
                        {g.customerPo && (
                          <span style={{ fontSize: 11, color: "#94A3B8" }}>
                            Cust PO: <span style={{ color: "#CBD5E1", fontFamily: "monospace", fontWeight: 600 }}>{g.customerPo}</span>
                          </span>
                        )}
                      </span>
                      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        {g.store && storeTag(g.store)}
                        <span style={{ color: "#10B981", fontWeight: 700 }}>{lineQtyDisplay}</span>
                      </span>
                    </div>
                    <div style={{ color: "#CBD5E1", marginBottom: 2 }}>{g.customerName || "—"}</div>
                    <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                      <span style={{ color: "#94A3B8", fontSize: 11 }}>Cancel: {fmtDateDisplay(g.date)}</span>
                      {grpUnitPrice > 0 && <span style={{ color: "#94A3B8", fontSize: 11 }}>{isPrepack ? "Pack" : "Unit"}: ${grpUnitPrice.toFixed(2)}</span>}
                      {g.totalPrice > 0 && <span style={{ color: "#94A3B8", fontSize: 11 }}>Total: ${g.totalPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>}
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
                Purchase Orders ({poList.length}) · {isPrepack
                  ? `+${tQty.toLocaleString()} pack${tQty !== 1 ? "s" : ""} (${(tQty * ppkMult).toLocaleString()} units)`
                  : `+${tQty.toLocaleString()} units`}{tVal > 0 ? ` · $${tVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · Avg $${(tVal / tQty).toFixed(2)}/${isPrepack ? "pack" : "unit"}${isPrepack ? `/${ppkMult} Each $${(tVal / tQty / ppkMult).toFixed(2)}` : ""}` : ""}
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

// ── T3 / SP-LY block ─────────────────────────────────────────────────
// Rendered at the bottom of the On Order right-click menu. Same date
// windows as the Excel export's Trailing-3 / SP-LY columns:
//   T3: last 3 months from today
//   LY: same 3-month window one year ago (today − 15 mo .. today − 12 mo)
// Optionally narrowed by the grid's customer filter. Margin uses the
// row's effective unit cost (already in unit grain in the parent
// scope) — for prepacks we surface pack-grain math like the rest of
// the menu (avg pack price ÷ cost-per-pack).
interface SalesHistorySectionProps {
  salesAgg: SkuSalesAggregates | null;
  loading: boolean;
  avgCost: number;          // per-unit (effectiveCost from parent)
  ppkMult: number;
  customerFilter: string;
}

const SalesHistorySection: React.FC<SalesHistorySectionProps> = ({ salesAgg, loading, avgCost, ppkMult, customerFilter }) => {
  if (loading && !salesAgg) {
    return (
      <div style={{ padding: "8px 14px", borderTop: "1px solid #1a2030", fontSize: 11, color: "#64748B", fontStyle: "italic" }}>
        Loading sales history…
      </div>
    );
  }
  if (!salesAgg) return null;
  const { t3, ly, t3Window, lyWindow } = salesAgg;
  const isPrepack = ppkMult > 1;
  return (
    <>
      <SalesHistoryBlock
        label="T3 (last 3 months)"
        windowLabel={`${fmtDateDisplay(t3Window.start)} → ${fmtDateDisplay(t3Window.end)}`}
        agg={t3}
        avgCost={avgCost}
        ppkMult={ppkMult}
        isPrepack={isPrepack}
        customerFilter={customerFilter}
      />
      <SalesHistoryBlock
        label="SP LY (same 3 months last year)"
        windowLabel={`${fmtDateDisplay(lyWindow.start)} → ${fmtDateDisplay(lyWindow.end)}`}
        agg={ly}
        avgCost={avgCost}
        ppkMult={ppkMult}
        isPrepack={isPrepack}
        customerFilter={customerFilter}
      />
    </>
  );
};

interface SalesHistoryBlockProps {
  label: string;
  windowLabel: string;
  agg: { qty: number; totalPrice: number; marginAmount: number };
  avgCost: number;
  ppkMult: number;
  isPrepack: boolean;
  customerFilter: string;
}

const SalesHistoryBlock: React.FC<SalesHistoryBlockProps> = ({ label, windowLabel, agg, avgCost, ppkMult, isPrepack, customerFilter }) => {
  const empty = agg.qty === 0 && agg.totalPrice === 0;
  // agg.qty is at UNIT grain (qty_units from the DB, or qty fallback for
  // legacy rows). Both unitPrice and avgCost are now per-unit, so margin
  // math is a clean subtraction — no ppkMult dance.
  const unitPrice = agg.qty > 0 ? agg.totalPrice / agg.qty : 0;
  // Prefer the server-computed margin (margin_amount summed from
  // ip_sales_history_wholesale). Falls back to the per-unit subtract
  // when marginAmount is 0 (legacy rows where the nightly hasn't
  // populated margin yet).
  let margin: number | null = null;
  if (agg.totalPrice > 0 && agg.marginAmount !== 0) {
    margin = (agg.marginAmount / agg.totalPrice) * 100;
  } else if (unitPrice > 0 && avgCost > 0) {
    margin = ((unitPrice - avgCost) / unitPrice) * 100;
  }
  const marginColor = margin === null ? "#94A3B8" : margin >= 30 ? "#6EE7B7" : margin >= 10 ? "#FCD34D" : "#FCA5A5";
  const packCount = isPrepack && ppkMult > 1 ? agg.qty / ppkMult : agg.qty;
  const qtyDisplay = isPrepack
    ? `${packCount.toLocaleString(undefined, { maximumFractionDigits: 1 })} pack${packCount !== 1 ? "s" : ""} (${agg.qty.toLocaleString()} units)`
    : `${agg.qty.toLocaleString()} units`;

  return (
    <div style={{ padding: "8px 14px", borderTop: "1px solid #1a2030", fontSize: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 3, gap: 8 }}>
        <span style={{ color: "#93C5FD", fontWeight: 700, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em" }}>
          {label}{customerFilter ? <span style={{ color: "#94A3B8", fontWeight: 400, textTransform: "none", letterSpacing: 0, marginLeft: 6 }}>· {customerFilter}</span> : null}
        </span>
        <span style={{ color: "#64748B", fontSize: 10 }}>{windowLabel}</span>
      </div>
      {empty ? (
        <div style={{ color: "#64748B", fontSize: 11, fontStyle: "italic" }}>No sales in this window.</div>
      ) : (
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", color: "#CBD5E1" }}>
          <span style={{ color: "#F59E0B", fontWeight: 700 }}>{qtyDisplay}</span>
          {agg.totalPrice > 0 && <span>${agg.totalPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>}
          {unitPrice > 0 && <span style={{ color: "#94A3B8", fontSize: 11 }}>Avg ${(isPrepack && ppkMult > 1 ? unitPrice * ppkMult : unitPrice).toFixed(2)}/{isPrepack ? "pack" : "unit"}</span>}
          {margin !== null && <span style={{ color: marginColor, fontWeight: 600, fontSize: 11 }}>Margin {margin >= 0 ? "" : "-"}{Math.abs(margin).toFixed(1)}%</span>}
        </div>
      )}
    </div>
  );
};
