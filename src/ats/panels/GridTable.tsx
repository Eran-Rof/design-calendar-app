import React, { useMemo } from "react";
import S from "../styles";
import { getQtyColor, getQtyBg, displayColor } from "../helpers";
import type { ATSRow, ATSPoEvent, ATSSoEvent, CtxMenu } from "../types";

// Height of the totals row at the top of the table. Used to push the
// regular sticky header down so the two stack without overlap. Tall
// enough to fit four stacked lines (Qty / Cost / Sale / Mrgn).
const TOTALS_ROW_HEIGHT = 82;

// Format dollars for the totals header. Whole-dollar precision keeps
// the rows scannable when totals run into millions.
function fmtUSD(v: number): string {
  if (!v) return "—";
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(Math.round(v)).toLocaleString()}`;
}

interface Period {
  key: string;
  periodStart: string;
  endDate: string;
  label: string;
  isToday: boolean;
  isWeekend: boolean;
}

interface GridTableProps {
  loading: boolean;
  filtered: ATSRow[];
  pageRows: ATSRow[];
  displayPeriods: Period[];
  tableRef: React.RefObject<HTMLDivElement>;

  // sort
  sortCol: string | null;
  sortDir: "asc" | "desc";
  handleThClick: (col: string) => void;
  rangeUnit: "days" | "weeks" | "months";

  // row UI state
  pinnedSku: string | null;
  setPinnedSku: (v: string | null) => void;
  dragSku: string | null;
  setDragSku: (v: string | null) => void;
  dragOverSku: string | null;
  setDragOverSku: (v: string | null) => void;
  hoveredCell: { sku: string; date: string } | null;
  setHoveredCell: (v: { sku: string; date: string } | null) => void;

  // cell behavior
  todayKey: string;
  atShip: boolean;
  showTotalsRow: boolean;
  eventIndex: Record<string, Record<string, { pos: ATSPoEvent[]; sos: ATSSoEvent[] }>> | null;
  getEventsInPeriod: (sku: string, periodStart: string, endDate: string, rowStore?: string) => { pos: ATSPoEvent[]; sos: ATSSoEvent[] };
  ctxMenu: CtxMenu | null;
  setCtxMenu: (v: CtxMenu | null) => void;
  setSummaryCtx: (v: any) => void;
  openSummaryCtx: (e: React.MouseEvent, type: "onHand" | "onOrder" | "onPO", row: ATSRow) => void;
  handleSkuDrop: (fromSku: string, toSku: string) => void;
  toggleExpandGroup: (key: string) => void;
  expandedGroupSet: ReadonlySet<string>;
}

export const GridTable: React.FC<GridTableProps> = ({
  loading, filtered, pageRows, displayPeriods, tableRef,
  sortCol, sortDir, handleThClick, rangeUnit,
  pinnedSku, setPinnedSku, dragSku, setDragSku, dragOverSku, setDragOverSku,
  hoveredCell, setHoveredCell,
  todayKey, atShip, showTotalsRow, eventIndex, getEventsInPeriod,
  ctxMenu, setCtxMenu, setSummaryCtx,
  openSummaryCtx, handleSkuDrop, toggleExpandGroup, expandedGroupSet,
}) => {
  // Totals across the filtered set (not just the current page) for the
  // sticky totals row above the column headers. Each ATS period column
  // sums whichever value the cell would render — freeMap when atShip
  // is on, otherwise dates — so the header total matches what's
  // visible below.
  //
  // Cost and Sale are derived from each row's avgCost and a per-SKU
  // average sale price computed from the SO events in eventIndex
  // (sum of SO totalPrice / sum of SO qty). The same Qty × Cost and
  // Qty × Sale formulas apply to every column so On Hand / On Order /
  // On PO and every ATS period stay consistent.
  const sums = useMemo(() => {
    // Per-SKU avg sale price from SO events. eventIndex is keyed
    // SKU → date → { pos, sos }; sum across all dates per SKU.
    const salePriceBySku = new Map<string, number>();
    if (eventIndex) {
      for (const sku of Object.keys(eventIndex)) {
        let qty = 0, value = 0;
        for (const buckets of Object.values(eventIndex[sku])) {
          for (const so of buckets.sos) {
            const v = so.totalPrice || (so.unitPrice * so.qty) || 0;
            if (so.qty > 0 && v > 0) { qty += so.qty; value += v; }
          }
        }
        if (qty > 0) salePriceBySku.set(sku, value / qty);
      }
    }
    const salePriceFor = (r: ATSRow): number => salePriceBySku.get(r.sku) ?? 0;

    let onHandQty  = 0, onHandCost  = 0, onHandSale  = 0;
    let onOrderQty = 0, onOrderCost = 0, onOrderSale = 0;
    let onPOQty    = 0, onPOCost    = 0, onPOSale    = 0;
    for (const r of filtered) {
      const cost = r.avgCost ?? 0;
      const sale = salePriceFor(r);
      onHandQty  += r.onHand  || 0;  onHandCost  += (r.onHand  || 0) * cost; onHandSale  += (r.onHand  || 0) * sale;
      onOrderQty += r.onOrder || 0;  onOrderCost += (r.onOrder || 0) * cost; onOrderSale += (r.onOrder || 0) * sale;
      onPOQty    += r.onPO    || 0;  onPOCost    += (r.onPO    || 0) * cost; onPOSale    += (r.onPO    || 0) * sale;
    }
    const periodQty:  Record<string, number> = {};
    const periodCost: Record<string, number> = {};
    const periodSale: Record<string, number> = {};
    for (const p of displayPeriods) {
      let q = 0, c = 0, s = 0;
      for (const r of filtered) {
        const v = atShip ? (r.freeMap?.[p.endDate] ?? r.dates[p.endDate]) : r.dates[p.endDate];
        if (v == null) continue;
        const cost = r.avgCost ?? 0;
        const sale = salePriceFor(r);
        q += v;
        c += v * cost;
        s += v * sale;
      }
      periodQty[p.key]  = q;
      periodCost[p.key] = c;
      periodSale[p.key] = s;
    }
    return {
      onHand:  { qty: onHandQty,  cost: onHandCost,  sale: onHandSale  },
      onOrder: { qty: onOrderQty, cost: onOrderCost, sale: onOrderSale },
      onPO:    { qty: onPOQty,    cost: onPOCost,    sale: onPOSale    },
      periodQty, periodCost, periodSale,
    };
  }, [filtered, displayPeriods, atShip, eventIndex]);

  if (loading) return <div style={S.loadingState}>Loading ATS data…</div>;
  if (filtered.length === 0) return (
    <div style={S.emptyState}>
      <div style={{ fontSize: 32, marginBottom: 12 }}>▦</div>
      <p style={{ color: "#9CA3AF", margin: 0 }}>No SKUs match your filters.</p>
    </div>
  );

  // Style helper for cells in the totals row. Totals row sits at top: 0;
  // the regular header row below uses top: TOTALS_ROW_HEIGHT. Background
  // matches the main header (#1E293B) per design.
  const totalsThBase: React.CSSProperties = {
    ...S.th,
    top: 0,
    height: TOTALS_ROW_HEIGHT,
    padding: "6px 10px",
    background: "#1E293B",
    borderBottom: "1px solid #334155",
    fontSize: 12,
    textTransform: "none",
    letterSpacing: 0,
    verticalAlign: "middle",
  };

  // Renders a single totals cell with four stacked lines: Qty / Cost /
  // Sale / Mrgn. Each line is "Label: value". Color matches the
  // column's value accent. Margin % = (sale - cost) / sale × 100.
  type TotalsCellProps = {
    qty: number;
    cost: number;
    sale: number;
    qtyColor: string;
    qtyPrefix?: string; // for "+" on On PO
  };
  const TotalsCell: React.FC<TotalsCellProps> = ({ qty, cost, sale, qtyColor, qtyPrefix }) => {
    const margin = sale > 0 ? ((sale - cost) / sale) * 100 : 0;
    const marginColor = !sale ? "#475569" : margin >= 30 ? "#10B981" : margin >= 10 ? "#F59E0B" : "#F87171";
    // Two-column grid so the colons line up vertically: left column =
    // labels (right-aligned), right column = values (right-aligned).
    // The whole grid is pushed to the right edge of the cell via
    // justifyContent: "end".
    const labelStyle: React.CSSProperties = { color: "#6B7280", fontSize: 10, textAlign: "right" };
    const valueStyle: React.CSSProperties = { textAlign: "right", fontFamily: "monospace" };
    return (
      <div style={{ display: "grid", gridTemplateColumns: "auto auto", columnGap: 4, rowGap: 1, justifyContent: "end", alignItems: "baseline", fontFamily: "monospace", lineHeight: 1.2 }}>
        <span style={labelStyle}>Qty:</span>
        <span style={{ ...valueStyle, color: qtyColor, fontWeight: 700, fontSize: 12 }}>
          {qty === 0 ? "—" : `${qtyPrefix ?? ""}${qty.toLocaleString()}`}
        </span>
        <span style={labelStyle}>Cost:</span>
        <span style={{ ...valueStyle, color: "#94A3B8", fontWeight: 600, fontSize: 11 }}>{fmtUSD(cost)}</span>
        <span style={labelStyle}>Sale:</span>
        <span style={{ ...valueStyle, color: "#3B82F6", fontWeight: 600, fontSize: 11 }}>{fmtUSD(sale)}</span>
        <span style={labelStyle}>Mrgn:</span>
        <span style={{ ...valueStyle, color: marginColor, fontWeight: 600, fontSize: 11 }}>
          {sale > 0 ? `${margin.toFixed(1)}%` : "—"}
        </span>
      </div>
    );
  };

  return (
    <div style={S.tableWrap} ref={tableRef}>
      <table style={S.table}>
        <thead>
          {/* Totals row — sticky top: 0, sums across the filtered set.
             Column geometry MUST mirror the column-header row below
             (lefts [0, 110, 220, 320, 500, 630, 710, 790], widths
             [110, 110, 100, 180, 130, 80, 80, 80]). Hidden when the
             user has toggled the totals off. */}
          {showTotalsRow && (
          <tr>
            {/* Empty Category | Sub Cat | Style | Description | Color (sticky to keep alignment) */}
            <th style={{ ...totalsThBase, ...S.stickyCol, left:   0, minWidth: 110, zIndex: 4 }} />
            <th style={{ ...totalsThBase, ...S.stickyCol, left: 110, minWidth: 110, zIndex: 4 }} />
            <th style={{ ...totalsThBase, ...S.stickyCol, left: 220, minWidth: 100, zIndex: 4 }} />
            <th style={{ ...totalsThBase, ...S.stickyCol, left: 320, minWidth: 180, zIndex: 4 }} />
            <th style={{ ...totalsThBase, ...S.stickyCol, left: 500, minWidth: 130, zIndex: 4 }} />
            {/* On Hand sum */}
            <th style={{ ...totalsThBase, ...S.stickyCol, left: 630, minWidth: 80, zIndex: 4 }}>
              <TotalsCell qty={sums.onHand.qty} cost={sums.onHand.cost} sale={sums.onHand.sale} qtyColor="#F1F5F9" />
            </th>
            {/* On Order sum */}
            <th style={{ ...totalsThBase, ...S.stickyCol, left: 710, minWidth: 80, zIndex: 4 }}>
              <TotalsCell qty={sums.onOrder.qty} cost={sums.onOrder.cost} sale={sums.onOrder.sale} qtyColor="#F59E0B" />
            </th>
            {/* On PO sum */}
            <th style={{ ...totalsThBase, ...S.stickyCol, left: 790, minWidth: 80, zIndex: 4 }}>
              <TotalsCell qty={sums.onPO.qty} cost={sums.onPO.cost} sale={sums.onPO.sale} qtyColor="#10B981" qtyPrefix="+" />
            </th>
            {/* Period sums */}
            {displayPeriods.map(p => {
              const q = sums.periodQty[p.key]  ?? 0;
              const c = sums.periodCost[p.key] ?? 0;
              const s = sums.periodSale[p.key] ?? 0;
              const isNeg = q < 0;
              const qtyColor = isNeg ? "#F87171" : (q === 0 ? "#475569" : getQtyColor(q));
              return (
                <th
                  key={`tot-${p.key}`}
                  style={{
                    ...totalsThBase,
                    minWidth: rangeUnit === "days" ? 68 : rangeUnit === "weeks" ? 120 : 100,
                    background: p.isToday ? "#1a2a1e" : p.isWeekend ? "#141e2e" : "#1E293B",
                  }}
                >
                  <TotalsCell qty={q} cost={c} sale={s} qtyColor={qtyColor} />
                </th>
              );
            })}
          </tr>
          )}
          {/* Column headers — pushed below the totals row */}
          <tr>
            {/* Sticky left columns: Category | Sub Cat | Style | Color | On Hand | On Order | On PO.
               Master is truth for the four ID columns; numeric columns unchanged. */}
            {(["category","subCategory","style","description","color","onHand","onOrder","onPO"] as const).map((col, ci) => {
              const labels: Record<string, string> = { category: "Category", subCategory: "Sub Cat", style: "Style", description: "Description", color: "Color", onHand: "On Hand", onOrder: "On Order", onPO: "On PO" };
              const lefts  = [0, 110, 220, 320, 500, 630, 710, 790];
              const widths = [110, 110, 100, 180, 130,  80,  80,  80];
              const isActive = sortCol === col;
              return (
                <th
                  key={col}
                  style={{
                    ...S.th, ...S.stickyCol,
                    top: showTotalsRow ? TOTALS_ROW_HEIGHT : 0,
                    left: lefts[ci], minWidth: widths[ci], zIndex: 3,
                    textAlign: ci >= 5 ? "center" : "left",
                    cursor: "pointer",
                    color: isActive ? "#F1F5F9" : "#6B7280",
                    background: isActive ? "#243048" : "#1E293B",
                  }}
                  onClick={() => handleThClick(col)}
                >
                  {labels[col]}{isActive ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
                </th>
              );
            })}
            {/* Period columns */}
            {displayPeriods.map(p => {
              const isActive = sortCol === p.endDate;
              return (
                <th
                  key={p.key}
                  style={{
                    ...S.th,
                    top: showTotalsRow ? TOTALS_ROW_HEIGHT : 0,
                    minWidth: rangeUnit === "days" ? 68 : rangeUnit === "weeks" ? 120 : 100,
                    textAlign: "center",
                    background: isActive ? "#243048" : p.isToday ? "#1a2a1e" : p.isWeekend ? "#141e2e" : "#1E293B",
                    color: isActive ? "#F1F5F9" : p.isToday ? "#10B981" : p.isWeekend ? "#475569" : "#6B7280",
                    borderBottom: p.isToday ? "2px solid #10B981" : "1px solid #334155",
                    whiteSpace: "pre-line",
                    lineHeight: 1.3,
                    fontSize: rangeUnit === "days" ? 10 : 11,
                    padding: "8px 6px",
                    cursor: "pointer",
                  }}
                  onClick={() => handleThClick(p.endDate)}
                >
                  {p.label}{isActive ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {pageRows.map((row, ri) => {
            const isPinned = pinnedSku === row.sku;
            const isDragging = dragSku === row.sku;
            const isDropTarget = dragOverSku === row.sku && dragSku !== row.sku;
            const isAggregate = !!row.__collapsed;
            const aggLevel = row.__collapsed?.level ?? null;
            const aggKey = row.__collapsed?.key ?? "";
            const isExpanded = aggKey ? expandedGroupSet.has(aggKey) : false;
            // Tint aggregate rows so they read as group headers, not leaves.
            const baseBg = isAggregate
              ? (ri % 2 === 0 ? "#1a2332" : "#1e2738")
              : (ri % 2 === 0 ? "#0F172A" : "#111827");
            const stickyBg = isPinned ? "#1a2332" : baseBg;
            return (
              <tr
                key={`${row.sku}::${row.store ?? "ROF"}`}
                draggable={!isAggregate}
                onDragStart={e => {
                  if (isAggregate) { e.preventDefault(); return; }
                  // Carry the source sku on the event itself so the drop
                  // handler is independent of React state flush timing.
                  // This fixes the intermittent "row 2 → row 1 doesn't
                  // merge" case where the drop handler's closure ran before
                  // dragSku state had propagated.
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("application/x-ats-sku", row.sku);
                  setDragSku(row.sku);
                }}
                onDragEnd={() => { setDragSku(null); setDragOverSku(null); }}
                onDragOver={e => {
                  // Aggregate rows are synthetic (__group:...); merging into
                  // them is meaningless. Block the drop target entirely.
                  if (isAggregate) return;
                  e.preventDefault();
                  if (dragSku && dragSku !== row.sku && dragOverSku !== row.sku) {
                    setDragOverSku(row.sku);
                  }
                }}
                onDragLeave={() => setDragOverSku(null)}
                onDrop={e => {
                  if (isAggregate) return;
                  e.preventDefault();
                  // Prefer the dataTransfer payload; fall back to React state.
                  const fromSku = e.dataTransfer.getData("application/x-ats-sku") || dragSku || "";
                  if (fromSku && fromSku !== row.sku) {
                    handleSkuDrop(fromSku, row.sku);
                  }
                  setDragSku(null);
                  setDragOverSku(null);
                }}
                style={{
                  background: isDropTarget ? "#1e3a2a" : stickyBg,
                  opacity: isDragging ? 0.45 : 1,
                  outline: isDropTarget ? "2px solid #10B981" : "none",
                  transition: "background 0.1s, opacity 0.1s",
                  cursor: isAggregate ? "default" : "grab",
                  fontWeight: isAggregate ? 600 : 400,
                }}
              >
                {/* Category */}
                <td
                  style={{ ...S.td, ...S.stickyCol, left: 0, background: stickyBg, color: "#9CA3AF", fontSize: 12 }}
                  onClick={() => { if (!isAggregate) setPinnedSku(isPinned ? null : row.sku); }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    {aggLevel === "category" ? (
                      <button
                        onClick={e => { e.stopPropagation(); toggleExpandGroup(aggKey); }}
                        style={{ background: "transparent", border: "none", color: "#60A5FA", cursor: "pointer", padding: 0, fontSize: 11, width: 14, textAlign: "center" }}
                        aria-label={isExpanded ? "Collapse group" : "Expand group"}
                      >
                        {isExpanded ? "▼" : "▶"}
                      </button>
                    ) : (
                      <div style={{ width: 6, height: 6, borderRadius: 2, background: getQtyColor(row.dates[todayKey] ?? row.onHand), flexShrink: 0 }} />
                    )}
                    <span style={{ color: isAggregate ? "#F1F5F9" : "#9CA3AF" }}>{row.master_category ?? "—"}</span>
                  </div>
                </td>
                {/* Sub Cat */}
                <td style={{ ...S.td, ...S.stickyCol, left: 110, background: stickyBg, color: "#9CA3AF", fontSize: 12 }}>
                  {aggLevel === "category" ? "" : (
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      {aggLevel === "subCategory" && (
                        <button
                          onClick={e => { e.stopPropagation(); toggleExpandGroup(aggKey); }}
                          style={{ background: "transparent", border: "none", color: "#60A5FA", cursor: "pointer", padding: 0, fontSize: 11, width: 14, textAlign: "center" }}
                          aria-label={isExpanded ? "Collapse group" : "Expand group"}
                        >
                          {isExpanded ? "▼" : "▶"}
                        </button>
                      )}
                      <span style={{ color: isAggregate ? "#F1F5F9" : "#9CA3AF" }}>{row.master_sub_category ?? "—"}</span>
                    </div>
                  )}
                </td>
                {/* Style — primary identifier; raw SKU on hover for traceability;
                   store badge stays here */}
                <td
                  style={{ ...S.td, ...S.stickyCol, left: 220, background: stickyBg }}
                  title={isAggregate ? undefined : row.sku}
                >
                  {(aggLevel === "category" || aggLevel === "subCategory") ? "" : (
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      {aggLevel === "style" && (
                        <button
                          onClick={e => { e.stopPropagation(); toggleExpandGroup(aggKey); }}
                          style={{ background: "transparent", border: "none", color: "#60A5FA", cursor: "pointer", padding: 0, fontSize: 11, width: 14, textAlign: "center" }}
                          aria-label={isExpanded ? "Collapse group" : "Expand group"}
                        >
                          {isExpanded ? "▼" : "▶"}
                        </button>
                      )}
                      <span style={{ fontFamily: "monospace", color: "#60A5FA", fontSize: 12, fontWeight: 700 }}>
                        {row.master_style ?? "—"}
                      </span>
                      {!isAggregate && row.store && row.store !== "ROF" && (
                        <span style={{ fontSize: 9, fontWeight: 700, color: "#FBBF24", background: "rgba(251,191,36,0.12)", border: "1px solid rgba(251,191,36,0.35)", borderRadius: 3, padding: "1px 5px", letterSpacing: 0.3 }}>
                          {row.store}
                        </span>
                      )}
                    </div>
                  )}
                </td>
                {/* Description */}
                <td style={{ ...S.td, ...S.stickyCol, left: 320, background: stickyBg, color: isAggregate ? "#94A3B8" : "#D1D5DB", fontSize: 13, fontStyle: isAggregate ? "italic" : "normal" }}>
                  {row.description}
                </td>
                {/* Color */}
                <td style={{ ...S.td, ...S.stickyCol, left: 500, background: stickyBg, color: "#D1D5DB", fontSize: 12 }}>
                  {isAggregate ? "" : (displayColor(row) || "—")}
                </td>
                {/* On Hand */}
                <td
                  style={{ ...S.td, ...S.stickyCol, left: 630, background: stickyBg, textAlign: "center", cursor: "context-menu" }}
                  onContextMenu={e => openSummaryCtx(e, "onHand", row)}
                >
                  <span style={{ color: "#F1F5F9", fontWeight: 600, fontFamily: "monospace", fontSize: 13 }}>
                    {row.onHand.toLocaleString()}
                  </span>
                </td>
                {/* On Order (committed SOs) */}
                <td
                  style={{ ...S.td, ...S.stickyCol, left: 710, background: stickyBg, textAlign: "center", cursor: row.onOrder > 0 ? "context-menu" : "default" }}
                  onContextMenu={e => { if (row.onOrder > 0) openSummaryCtx(e, "onOrder", row); }}
                >
                  <span style={{ color: "#F59E0B", fontWeight: 600, fontFamily: "monospace", fontSize: 13 }}>
                    {row.onOrder > 0 ? row.onOrder.toLocaleString() : "—"}
                  </span>
                </td>
                {/* On PO (open purchase orders) */}
                <td
                  style={{ ...S.td, ...S.stickyCol, left: 790, background: stickyBg, textAlign: "center", cursor: row.onPO > 0 ? "context-menu" : "default" }}
                  onContextMenu={e => { if (row.onPO > 0) openSummaryCtx(e, "onPO", row); }}
                >
                  <span style={{ color: "#10B981", fontWeight: 600, fontFamily: "monospace", fontSize: 13 }}>
                    {row.onPO > 0 ? `+${row.onPO.toLocaleString()}` : "—"}
                  </span>
                </td>
                {/* Period cells */}
                {displayPeriods.map(p => {
                  const fullQty = row.dates[p.endDate];
                  const qty = atShip ? (row.freeMap?.[p.endDate] ?? fullQty) : fullQty;
                  const isNeg = qty != null && qty < 0;
                  const isHov = hoveredCell?.sku === row.sku && hoveredCell?.date === p.key;
                  const isEmpty = qty === undefined || qty === null;
                  const ev = eventIndex ? getEventsInPeriod(row.sku, p.periodStart, p.endDate, row.store) : null;
                  const hasPO = (ev?.pos.length ?? 0) > 0;
                  const hasSO = (ev?.sos.length ?? 0) > 0;
                  const canClick = hasPO || hasSO || isNeg;
                  const baseBg = p.isToday
                    ? (isEmpty ? "#12201a" : isNeg ? "rgba(239,68,68,0.18)cc" : getQtyBg(qty!) + "cc")
                    : (isEmpty ? "#0F172A"  : isNeg ? "rgba(239,68,68,0.12)"  : getQtyBg(qty!));
                  const cellBg = hasPO && hasSO
                    ? `repeating-linear-gradient(45deg, rgba(245,158,11,0.22) 0px, rgba(245,158,11,0.22) 4px, rgba(59,130,246,0.22) 4px, rgba(59,130,246,0.22) 8px)`
                    : hasPO ? "rgba(245,158,11,0.18)"
                    : hasSO ? "rgba(59,130,246,0.18)"
                    : baseBg;
                  return (
                    <td
                      key={p.key}
                      style={{
                        ...S.td,
                        textAlign: "center",
                        padding: "4px",
                        background: cellBg,
                        cursor: canClick ? "context-menu" : "default",
                        transition: "all 0.1s",
                        outline: isHov ? `1px solid ${isEmpty ? "#334155" : isNeg ? "#EF4444" : getQtyColor(qty!)}` : "none",
                        outlineOffset: -1,
                        position: "relative",
                        boxShadow: hasPO && hasSO ? "inset 0 0 0 1px rgba(245,158,11,0.5)"
                          : hasPO ? "inset 0 0 0 1px rgba(245,158,11,0.4)"
                          : hasSO ? "inset 0 0 0 1px rgba(59,130,246,0.4)"
                          : isNeg ? "inset 0 0 0 1px rgba(239,68,68,0.5)"
                          : undefined,
                      }}
                      onMouseEnter={() => setHoveredCell({ sku: row.sku, date: p.key })}
                      onMouseLeave={() => setHoveredCell(null)}
                      onContextMenu={e => {
                        if (!canClick) return;
                        e.preventDefault();
                        const cellKey = `${row.sku}::${p.key}`;
                        if (ctxMenu?.cellKey === cellKey) { setCtxMenu(null); return; }
                        const cellEl = e.currentTarget as HTMLElement;
                        const cellRect = cellEl.getBoundingClientRect();
                        setSummaryCtx(null);
                        // Compute blended unit cost using full row history
                        // (on-hand at avgCost + ALL incoming POs at their unitCost)
                        // so margin reflects the full replenishment picture, not
                        // just this cell's POs.
                        const poList = ev?.pos ?? [];
                        const allRowPos = eventIndex?.[row.sku]
                          ? Object.values(eventIndex[row.sku]).flatMap(v => v.pos.filter(p => !row.store || (p.store ?? "ROF") === row.store))
                          : [];
                        const poQtySum  = allRowPos.reduce((a, p) => a + (p.qty || 0), 0);
                        const poCostSum = allRowPos.reduce((a, p) => a + (p.qty || 0) * (p.unitCost || 0), 0);
                        const onHandCostSum = (row.onHand || 0) * (row.avgCost || 0);
                        const totalQty = (row.onHand || 0) + poQtySum;
                        let effectiveCost = totalQty > 0 ? (onHandCostSum + poCostSum) / totalQty : 0;
                        if (!effectiveCost && poList.length) {
                          const priced = poList.filter(p => p.unitCost > 0);
                          const totQty = priced.reduce((a, p) => a + p.qty, 0);
                          effectiveCost = totQty > 0 ? priced.reduce((a, p) => a + p.qty * p.unitCost, 0) / totQty : 0;
                        }
                        setCtxMenu({
                          x: cellRect.left, y: cellRect.bottom + 2, anchorY: cellRect.top,
                          pos: poList, sos: ev?.sos ?? [],
                          onHand: row.onHand, skuStore: row.store ?? "ROF",
                          cellKey, cellEl, flipped: false, arrowLeft: 20,
                          unitCost: effectiveCost,
                        });
                      }}
                    >
                      {(isEmpty || qty === 0) ? (
                        <span style={{ color: "#334155", fontSize: 11 }}>—</span>
                      ) : isNeg ? (
                        <span style={{
                          display: "inline-block",
                          background: "rgba(239,68,68,0.22)",
                          color: "#F87171",
                          fontSize: 11,
                          fontFamily: "monospace",
                          fontWeight: 700,
                          padding: "1px 5px",
                          borderRadius: 4,
                          border: "1px solid rgba(239,68,68,0.4)",
                        }}>
                          {qty!.toLocaleString()}
                        </span>
                      ) : (
                        <span style={{
                          color: getQtyColor(qty!),
                          fontSize: 12,
                          fontFamily: "monospace",
                          fontWeight: qty! <= 10 ? 700 : 500,
                        }}>
                          {qty!.toLocaleString()}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
