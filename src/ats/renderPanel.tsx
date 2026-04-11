import React from "react";
import S from "./styles";
import { StatCard } from "./StatCard";
import { fmtDate, fmtDateShort, fmtDateDisplay, fmtDateHeader, isToday, isWeekend, getQtyColor, getQtyBg } from "./helpers";
import { StatsRow } from "./panels/StatsRow";
import { MergeConfirmModal } from "./panels/MergeConfirmModal";
import { UploadWarningsModal } from "./panels/UploadWarningsModal";
import { NormalizationReviewModal } from "./panels/NormalizationReviewModal";
import { UploadProgressOverlay, SuccessToast, SyncErrorModal, UploadErrorModal } from "./panels/StatusOverlays";
import { UploadModal } from "./panels/UploadModal";
import { SummaryContextMenu, CellContextMenu } from "./panels/ContextMenus";
import { Pagination } from "./panels/Pagination";
import { NavBar, SyncProgressBanner } from "./panels/NavBar";
import { Toolbar } from "./panels/Toolbar";
import type { ATSState } from "./state/atsTypes";
import type { ATSRow, ExcelData, ATSPoEvent, ATSSoEvent, UploadWarning } from "./types";
import type { NormChange } from "./normalize";

// Functional-updater-aware setter, matches the shape produced by ATS.tsx's `mk()`
type Setter<T> = (v: T | ((prev: T) => T)) => void;

// Setters for every top-level field on ATSState — auto-derived so new state
// fields only need to be added in one place (atsTypes.ts). Partial because
// the render panel only pulls the subset of setters it actually uses; the
// type check still catches typos and type mismatches on any passed setter.
type ATSStateSetters = Partial<{
  [K in keyof ATSState as `set${Capitalize<string & K>}`]: Setter<ATSState[K]>;
}>;

// Non-state values computed each render in ATS.tsx and handed to the panel.
interface ATSDerivedCtx {
  // Constants
  STORES: readonly string[];
  PAGE_SIZE: number;
  // Store filter aliases
  poStores: string[];
  soStores: string[];
  // Refs
  poDropRef: React.RefObject<HTMLDivElement>;
  soDropRef: React.RefObject<HTMLDivElement>;
  invRef: React.RefObject<HTMLInputElement>;
  purRef: React.RefObject<HTMLInputElement>;
  ordRef: React.RefObject<HTMLInputElement>;
  ctxRef: React.RefObject<HTMLDivElement>;
  summaryCtxRef: React.RefObject<HTMLDivElement>;
  tableRef: React.RefObject<HTMLDivElement>;
  cancelRef: React.MutableRefObject<boolean>;
  abortRef: React.MutableRefObject<AbortController | null>;
  // Computed data
  dates: string[];
  displayPeriods: Array<{ key: string; periodStart: string; endDate: string; label: string; isToday: boolean; isWeekend: boolean }>;
  eventIndex: Record<string, Record<string, { pos: ATSPoEvent[]; sos: ATSSoEvent[] }>> | null;
  filtered: ATSRow[];
  statFiltered: ATSRow[];
  sortedFiltered: ATSRow[];
  pageRows: ATSRow[];
  totalPages: number;
  categories: string[];
  filteredSkuSet: Set<string>;
  todayKey: string;
  // Summary stats
  totalSoValue: number;
  totalPoValue: number;
  marginDollars: number;
  marginPct: number;
  lowStock: number;
  negATSCount: number;
  zeroStock: number;
  totalSKUs: number;
  totalPoQty: number;
  totalSoQty: number;
  syncProgress: { step: string; pct: number; log: string[] } | null;
  // Drag state (plain useState, not reducer)
  dragSku: string | null;
  setDragSku: (v: string | null) => void;
  dragOverSku: string | null;
  setDragOverSku: (v: string | null) => void;
  pendingMerge: { fromSku: string; toSku: string; similarity: number } | null;
  setPendingMerge: (v: { fromSku: string; toSku: string; similarity: number } | null) => void;
  isAdmin: boolean;
  // Callbacks
  handleFileUpload: (inv: File, pur: File | null, ord: File) => Promise<void>;
  refreshPOsFromWIP: () => Promise<void>;
  handleThClick: (col: string) => void;
  loadFromSupabase: () => Promise<void>;
  saveUploadData: (data: ExcelData) => Promise<void>;
  toggleStore: (current: string[], set: (v: string[]) => void, store: string) => void;
  exportToExcel: (rows: ATSRow[], periods: Array<{ endDate: string; label: string }>, atShip: boolean) => void;
  repositionCtxMenu: () => void;
  repositionSummaryCtx: () => void;
  cancelUpload: () => void;
  openSummaryCtx: (e: React.MouseEvent, type: "onHand" | "onOrder" | "onPO", row: ATSRow) => void;
  getEventsInPeriod: (sku: string, periodStart: string, endDate: string, rowStore?: string) => { pos: ATSPoEvent[]; sos: ATSSoEvent[] };
  applyNormReview: () => void;
  dismissNormReview: () => void;
  commitMerge: (fromSku: string, toSku: string) => void;
  handleSkuDrop: (fromSku: string, toSku: string) => void;
  undoLastMerge: () => Promise<void>;
  clearAllAtsData: () => Promise<void>;
  saveMergeHistory: (history: Array<{ fromSku: string; toSku: string }>) => Promise<void>;
}

export type ATSRenderCtx = ATSState & ATSStateSetters & ATSDerivedCtx;

export function atsRenderPanel(ctx: ATSRenderCtx): React.ReactElement {
  const { startDate, setStartDate, rangeUnit, setRangeUnit, rangeValue, setRangeValue, search, setSearch, filterCategory, setFilterCategory, filterStatus, setFilterStatus, minATS, setMinATS, storeFilter, setStoreFilter, poDropOpen, setPoDropOpen, soDropOpen, setSoDropOpen, rows, setRows, loading, mockMode, page, setPage, excelData, setExcelData, uploadingFile, uploadProgress, uploadSuccess, setUploadSuccess, uploadError, setUploadError, uploadWarnings, setUploadWarnings, pendingUploadData, setPendingUploadData, showUpload, setShowUpload, invFile, setInvFile, purFile, setPurFile, ordFile, setOrdFile, syncing, syncStatus, lastSync, syncError, setSyncError, hoveredCell, setHoveredCell, pinnedSku, setPinnedSku, ctxMenu, setCtxMenu, summaryCtx, setSummaryCtx, activeSort, setActiveSort, sortCol, sortDir, STORES, PAGE_SIZE, poStores, soStores, poDropRef, soDropRef, invRef, purRef, ordRef, ctxRef, summaryCtxRef, tableRef, dates, displayPeriods, eventIndex, filtered, statFiltered, sortedFiltered, pageRows, totalPages, categories, filteredSkuSet, totalSoValue, totalPoValue, marginDollars, marginPct, handleFileUpload, handleThClick, loadFromSupabase, saveUploadData, toggleStore, exportToExcel, repositionCtxMenu, repositionSummaryCtx, cancelRef, abortRef, cancelUpload, openSummaryCtx, getEventsInPeriod, lowStock, negATSCount, zeroStock, totalSKUs, totalPoQty, totalSoQty, todayKey, syncProgress, normChanges, setNormChanges, applyNormReview, dismissNormReview, customerFilter, setCustomerFilter, customerDropOpen, setCustomerDropOpen, customerSearch, setCustomerSearch, dragSku, setDragSku, dragOverSku, setDragOverSku, pendingMerge, setPendingMerge, isAdmin, commitMerge, handleSkuDrop,
  mergeHistory, undoLastMerge, clearAllAtsData,
  atShip, setAtShip } = ctx;

  return (
    <div style={S.app}>
      <style>{`
        input[type=number]::-webkit-outer-spin-button { display: none; }
        input[type=number]::-webkit-inner-spin-button {
          -webkit-appearance: none;
          appearance: none;
          cursor: pointer;
          width: 14px;
          background: transparent url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='18' viewBox='0 0 14 18'%3E%3Cpath d='M7 3 L11 8 L3 8 Z' fill='%2394A3B8'/%3E%3Cpath d='M7 15 L3 10 L11 10 Z' fill='%2394A3B8'/%3E%3C/svg%3E") no-repeat center;
          opacity: 0.7;
          border: none;
          border-left: 1px solid #334155;
        }
        input[type=number]::-webkit-inner-spin-button:hover { opacity: 1; }
      `}</style>
      <NavBar
        mergeHistory={mergeHistory}
        undoLastMerge={undoLastMerge}
        clearAllAtsData={clearAllAtsData}
        setShowUpload={setShowUpload}
        uploadingFile={uploadingFile}
        invFile={invFile}
        purFile={purFile}
        ordFile={ordFile}
        exportToExcel={exportToExcel}
        filtered={filtered}
        displayPeriods={displayPeriods}
        atShip={atShip}
      />
      <SyncProgressBanner syncProgress={syncProgress} />

      <div style={S.content}>
        {/* STAT CARDS */}
        <StatsRow
          lowStock={lowStock} zeroStock={zeroStock} negATSCount={negATSCount} totalSKUs={totalSKUs}
          totalSoQty={totalSoQty} totalSoValue={totalSoValue}
          totalPoQty={totalPoQty} totalPoValue={totalPoValue}
          marginDollars={marginDollars} marginPct={marginPct}
          activeSort={activeSort} setActiveSort={setActiveSort}
        />

        {/* TOOLBAR */}
        <Toolbar
          search={search} setSearch={setSearch}
          filterCategory={filterCategory} setFilterCategory={setFilterCategory} categories={categories}
          filterStatus={filterStatus} setFilterStatus={setFilterStatus}
          STORES={STORES} storeFilter={storeFilter} setStoreFilter={setStoreFilter}
          poDropOpen={poDropOpen} setPoDropOpen={setPoDropOpen} setSoDropOpen={setSoDropOpen}
          poDropRef={poDropRef} toggleStore={toggleStore}
          minATS={minATS} setMinATS={setMinATS}
          startDate={startDate} setStartDate={setStartDate}
          rangeUnit={rangeUnit} setRangeUnit={setRangeUnit}
          rangeValue={rangeValue} setRangeValue={setRangeValue}
          excelData={excelData}
          customerFilter={customerFilter} setCustomerFilter={setCustomerFilter}
          customerDropOpen={customerDropOpen} setCustomerDropOpen={setCustomerDropOpen}
          customerSearch={customerSearch} setCustomerSearch={setCustomerSearch}
          atShip={atShip} setAtShip={setAtShip}
          filteredCount={filtered.length} lastSync={lastSync}
        />

        {/* LEGEND */}
        <div style={S.legend}>
          {[
            { color: "#10B981", bg: "rgba(16,185,129,0.1)",  label: "In stock (>50)" },
            { color: "#3B82F6", bg: "rgba(59,130,246,0.12)", label: "OK (11–50)" },
            { color: "#F59E0B", bg: "rgba(245,158,11,0.15)", label: "Low (1–10)" },
            { color: "#EF4444", bg: "rgba(239,68,68,0.15)",  label: "Out of stock (0)" },
          ].map(l => (
            <div key={l.label} style={S.legendItem}>
              <div style={{ width: 10, height: 10, borderRadius: 2, background: l.bg, border: `1px solid ${l.color}`, flexShrink: 0 }} />
              <span style={{ color: "#9CA3AF", fontSize: 11 }}>{l.label}</span>
            </div>
          ))}
        </div>

        {/* GRID TABLE */}
        {loading ? (
          <div style={S.loadingState}>Loading ATS data…</div>
        ) : filtered.length === 0 ? (
          <div style={S.emptyState}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>▦</div>
            <p style={{ color: "#9CA3AF", margin: 0 }}>No SKUs match your filters.</p>
          </div>
        ) : (
          <div style={S.tableWrap} ref={tableRef}>
            <table style={S.table}>
              <thead>
                <tr>
                  {/* Sticky left columns */}
                  {(["sku","description","onHand","onOrder","onPO"] as const).map((col, ci) => {
                    const labels: Record<string, string> = { sku: "SKU", description: "Description", onHand: "On Hand", onOrder: "On Order", onPO: "On PO" };
                    const lefts = [0, 130, 330, 410, 490];
                    const widths = [130, 200, 80, 80, 80];
                    const isActive = sortCol === col;
                    return (
                      <th key={col} style={{ ...S.th, ...S.stickyCol, left: lefts[ci], minWidth: widths[ci], zIndex: 3, textAlign: ci >= 2 ? "center" : "left", cursor: "pointer",
                        color: isActive ? "#F1F5F9" : "#6B7280", background: isActive ? "#243048" : "#1E293B" }}
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
                      <th key={p.key} style={{
                        ...S.th,
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
                  const isPinned   = pinnedSku === row.sku;
                  const isDragging = dragSku === row.sku;
                  const isDropTarget = dragOverSku === row.sku && dragSku !== row.sku;
                  return (
                    <tr
                      key={`${row.sku}::${row.store ?? "ROF"}`}
                      draggable
                      onDragStart={e => { setDragSku(row.sku); e.dataTransfer.effectAllowed = "move"; }}
                      onDragEnd={() => { setDragSku(null); setDragOverSku(null); }}
                      onDragOver={e => { e.preventDefault(); if (dragSku && dragSku !== row.sku) setDragOverSku(row.sku); }}
                      onDragLeave={() => setDragOverSku(null)}
                      onDrop={e => { e.preventDefault(); if (dragSku && dragSku !== row.sku) { handleSkuDrop(dragSku, row.sku); setDragSku(null); setDragOverSku(null); } }}
                      style={{
                        background: isDropTarget ? "#1e3a2a" : isPinned ? "#1a2332" : ri % 2 === 0 ? "#0F172A" : "#111827",
                        opacity: isDragging ? 0.45 : 1,
                        outline: isDropTarget ? "2px solid #10B981" : "none",
                        transition: "background 0.1s, opacity 0.1s",
                        cursor: "grab",
                      }}
                    >
                      {/* SKU */}
                      <td
                        style={{ ...S.td, ...S.stickyCol, left: 0, background: isPinned ? "#1a2332" : ri % 2 === 0 ? "#0F172A" : "#111827" }}
                        onClick={() => setPinnedSku(isPinned ? null : row.sku)}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <div style={{ width: 6, height: 6, borderRadius: 2, background: getQtyColor(row.dates[todayKey] ?? row.onHand), flexShrink: 0 }} />
                          <span style={{ fontFamily: "monospace", color: "#60A5FA", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                            {row.sku}
                          </span>
                        </div>
                        {row.category && <div style={{ fontSize: 10, color: "#475569", marginTop: 2, paddingLeft: 12 }}>{row.category}</div>}
                      </td>
                      {/* Description */}
                      <td style={{ ...S.td, ...S.stickyCol, left: 130, background: isPinned ? "#1a2332" : ri % 2 === 0 ? "#0F172A" : "#111827", color: "#D1D5DB", fontSize: 13 }}>
                        {row.description}
                      </td>
                      {/* On Hand */}
                      <td
                        style={{ ...S.td, ...S.stickyCol, left: 330, background: isPinned ? "#1a2332" : ri % 2 === 0 ? "#0F172A" : "#111827", textAlign: "center", cursor: "context-menu" }}
                        onContextMenu={e => openSummaryCtx(e, "onHand", row)}
                      >
                        <span style={{ color: "#F1F5F9", fontWeight: 600, fontFamily: "monospace", fontSize: 13 }}>
                          {row.onHand.toLocaleString()}
                        </span>
                      </td>
                      {/* On Order (committed SOs) */}
                      <td
                        style={{ ...S.td, ...S.stickyCol, left: 410, background: isPinned ? "#1a2332" : ri % 2 === 0 ? "#0F172A" : "#111827", textAlign: "center", cursor: row.onCommitted > 0 ? "context-menu" : "default" }}
                        onContextMenu={e => { if (row.onCommitted > 0) openSummaryCtx(e, "onOrder", row); }}
                      >
                        <span style={{ color: "#F59E0B", fontWeight: 600, fontFamily: "monospace", fontSize: 13 }}>
                          {row.onCommitted > 0 ? row.onCommitted.toLocaleString() : "—"}
                        </span>
                      </td>
                      {/* On PO (open purchase orders) */}
                      <td
                        style={{ ...S.td, ...S.stickyCol, left: 490, background: isPinned ? "#1a2332" : ri % 2 === 0 ? "#0F172A" : "#111827", textAlign: "center", cursor: row.onOrder > 0 ? "context-menu" : "default" }}
                        onContextMenu={e => { if (row.onOrder > 0) openSummaryCtx(e, "onPO", row); }}
                      >
                        <span style={{ color: "#10B981", fontWeight: 600, fontFamily: "monospace", fontSize: 13 }}>
                          {row.onOrder > 0 ? `+${row.onOrder.toLocaleString()}` : "—"}
                        </span>
                      </td>
                      {/* Period cells */}
                      {displayPeriods.map(p => {
                        const fullQty = row.dates[p.endDate]; // real balance, may be negative
                        const qty     = atShip ? (row.freeMap?.[p.endDate] ?? fullQty) : fullQty;
                        const isNeg   = qty != null && qty < 0;
                        const isHov   = hoveredCell?.sku === row.sku && hoveredCell?.date === p.key;
                        const isEmpty = qty === undefined || qty === null;
                        const ev      = eventIndex ? getEventsInPeriod(row.sku, p.periodStart, p.endDate, row.store) : null;
                        const hasPO   = (ev?.pos.length ?? 0) > 0;
                        const hasSO   = (ev?.sos.length ?? 0) > 0;
                        const canClick = hasPO || hasSO || isNeg;
                        const freeQty  = row.freeMap?.[p.endDate];
                        // Cell background
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
                              const cellEl   = e.currentTarget as HTMLElement;
                              const cellRect = cellEl.getBoundingClientRect();
                              setSummaryCtx(null);
                              setCtxMenu({ x: cellRect.left, y: cellRect.bottom + 2, anchorY: cellRect.top, pos: ev?.pos ?? [], sos: ev?.sos ?? [], onHand: row.onHand, skuStore: row.store ?? "ROF", cellKey, cellEl, flipped: false, arrowLeft: 20 });
                            }}
                          >
                            {isEmpty ? (
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
                                {qty === 0 ? "0" : qty!.toLocaleString()}
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
        )}

        <Pagination page={page} totalPages={totalPages} setPage={setPage} filteredCount={filtered.length} />
      </div>

      <SummaryContextMenu summaryCtx={summaryCtx} summaryCtxRef={summaryCtxRef} setSummaryCtx={setSummaryCtx} />
      <CellContextMenu ctxMenu={ctxMenu} ctxRef={ctxRef} setCtxMenu={setCtxMenu} />

      <UploadWarningsModal
        uploadWarnings={uploadWarnings}
        pendingUploadData={pendingUploadData}
        saveUploadData={saveUploadData}
        setUploadWarnings={setUploadWarnings}
        setPendingUploadData={setPendingUploadData}
      />

      <NormalizationReviewModal
        normChanges={normChanges}
        setNormChanges={setNormChanges}
        applyNormReview={applyNormReview}
        dismissNormReview={dismissNormReview}
      />

      <UploadProgressOverlay uploadProgress={uploadProgress} cancelUpload={cancelUpload} />
      <SuccessToast uploadSuccess={uploadSuccess} setUploadSuccess={setUploadSuccess} />
      <SyncErrorModal syncError={syncError} setSyncError={setSyncError} />
      <UploadErrorModal uploadError={uploadError} setUploadError={setUploadError} />

      <UploadModal
        showUpload={showUpload} setShowUpload={setShowUpload}
        invFile={invFile} setInvFile={setInvFile}
        purFile={purFile} setPurFile={setPurFile}
        ordFile={ordFile} setOrdFile={setOrdFile}
        invRef={invRef} purRef={purRef} ordRef={ordRef}
        handleFileUpload={handleFileUpload}
      />

      <MergeConfirmModal
        pendingMerge={pendingMerge}
        isAdmin={isAdmin}
        commitMerge={commitMerge}
        setPendingMerge={setPendingMerge}
      />
    </div>
  );
}
