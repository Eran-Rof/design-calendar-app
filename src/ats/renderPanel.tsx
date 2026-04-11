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
      {/* NAV */}
      <nav style={S.nav}>
        <div style={S.navLeft}>
          <div style={S.navLogo}>ATS</div>
          <span style={S.navTitle}>ATS Report</span>
          <span style={S.navSub}>Available to Sell</span>
        </div>
        <div style={S.navRight}>
          <button
            style={{ display: "none" }}
            onClick={() => {}}
          >
            {"" /* Demo button removed */}
          </button>
          {/* Undo last merge — only shown when there are merges */}
          {mergeHistory?.length > 0 && (
            <button
              style={{ ...S.navBtn, background: "#7C3AED", border: "1px solid #5B21B6", color: "#fff", fontWeight: 600 }}
              title={`Undo merge: ${mergeHistory[mergeHistory.length - 1]?.fromSku} → ${mergeHistory[mergeHistory.length - 1]?.toSku}`}
              onClick={undoLastMerge}
            >
              ↩ Undo Merge ({mergeHistory.length})
            </button>
          )}
          {/* Clear all ATS data */}
          <button
            style={{ ...S.navBtn, background: "#7F1D1D", border: "1px solid #991B1B", color: "#FCA5A5", fontWeight: 600 }}
            onClick={async () => {
              if (window.confirm("Delete ALL uploaded ATS data (Excel, PO, merges) and start fresh?\n\nThis cannot be undone.")) {
                await clearAllAtsData();
              }
            }}
          >
            🗑 Clear Data
          </button>
          <button style={S.navBtn} onClick={() => setShowUpload(true)} disabled={uploadingFile}>
            {uploadingFile ? "Uploading…" : "Upload Excel"}
            {!uploadingFile && (invFile || purFile || ordFile) && (
              <span style={{ marginLeft: 6, background: "#10B981", color: "#fff", borderRadius: 10, padding: "1px 6px", fontSize: 11, fontWeight: 700 }}>
                {[invFile, ordFile].filter(Boolean).length}/2{purFile ? "+PO" : ""}
              </span>
            )}
          </button>
          {/* PO data auto-refreshes from PO WIP on every load */}
          <button
            style={{ ...S.navBtn, background: "#1D6F42", border: "1px solid #155734", color: "#fff", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 6 }}
            onClick={() => exportToExcel(filtered, displayPeriods.map(p => ({ endDate: p.endDate, label: p.label })), atShip)}
          >
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect width="20" height="20" rx="3" fill="#1D6F42"/>
              <path d="M11 10l3-4.5h-2.1L10 8.3 8.1 5.5H6l3 4.5L6 14.5h2.1L10 11.7l1.9 2.8H14L11 10z" fill="white"/>
            </svg>
            Export Excel
          </button>
          <a href="/" style={{ ...S.navBtn, textDecoration: "none" }}>← PLM Home</a>
        </div>
      </nav>

      {/* BANNER */}
      {false && (
        <div style={S.demoBanner}>
          {"" /* Demo banner removed */}
        </div>
      )}

      {/* Sync Progress Bar + Log */}
      {syncProgress && (
        <div style={{ background: "#1E293B", borderBottom: "1px solid #334155", padding: "12px 24px" }}>
          <div style={{ maxWidth: 1600, margin: "0 auto" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
              <span style={{ fontSize: 13, color: "#F1F5F9", fontWeight: 600 }}>{syncProgress.step}</span>
              <span style={{ fontSize: 12, color: "#60A5FA", fontFamily: "monospace", fontWeight: 700 }}>{syncProgress.pct}%</span>
            </div>
            <div style={{ height: 8, borderRadius: 4, background: "#0F172A", overflow: "hidden", marginBottom: 8 }}>
              <div style={{ width: `${syncProgress.pct}%`, height: "100%", background: syncProgress.pct === 100 ? "linear-gradient(90deg, #6EE7B7, #047857)" : "linear-gradient(90deg, #93C5FD, #1D4ED8)", borderRadius: 4, transition: "width 0.3s" }} />
            </div>
            {syncProgress.log.length > 0 && (
              <div style={{ maxHeight: 120, overflowY: "auto", background: "#0F172A", borderRadius: 6, padding: "6px 10px", fontSize: 11, fontFamily: "monospace", color: "#94A3B8", lineHeight: 1.6 }}>
                {syncProgress.log.map((l, i) => (
                  <div key={i} style={{ color: l.includes("ERROR") ? "#EF4444" : l.includes("✅") ? "#10B981" : l.includes("FAILED") ? "#F59E0B" : "#94A3B8" }}>{l}</div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

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
        <div style={S.toolbar}>
          <input
            type="text"
            inputMode="text"
            style={S.searchInput}
            placeholder="Search SKU or description…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <select style={S.select} value={filterCategory} onChange={e => setFilterCategory(e.target.value)}>
            {categories.map(c => <option key={c}>{c}</option>)}
          </select>
          <select style={S.select} value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
            <option value="All">All status</option>
            <option value="InStock">In stock</option>
            <option value="Low">Low stock</option>
            <option value="Out">Out of stock</option>
          </select>
          {/* Store filter dropdown — single filter for everything */}
          <div ref={poDropRef} style={{ position: "relative" }}>
            <button
              style={{ ...S.select, display: "flex", alignItems: "center", gap: 6, cursor: "pointer", minWidth: 140, justifyContent: "space-between" }}
              onClick={() => { setPoDropOpen(o => !o); setSoDropOpen(false); }}
            >
              <span style={{ color: "#10B981", fontSize: 11, fontWeight: 600, marginRight: 2 }}>Store:</span>
              <span style={{ flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {storeFilter.includes("All") ? "All stores" : storeFilter.join(", ")}
              </span>
              <span style={{ fontSize: 9, color: "#6B7280" }}>▼</span>
            </button>
            {poDropOpen && (
              <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 200, background: "#1E293B", border: "1px solid #334155", borderRadius: 8, minWidth: 160, boxShadow: "0 8px 24px rgba(0,0,0,0.4)", padding: "6px 0" }}>
                {(["All", ...STORES] as string[]).map(s => {
                  const checked = s === "All" ? storeFilter.includes("All") : storeFilter.includes(s);
                  return (
                    <label key={s} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 14px", cursor: "pointer", background: checked ? "rgba(16,185,129,0.08)" : "transparent" }}
                      onMouseEnter={e => (e.currentTarget.style.background = "rgba(16,185,129,0.12)")}
                      onMouseLeave={e => (e.currentTarget.style.background = checked ? "rgba(16,185,129,0.08)" : "transparent")}
                    >
                      <input type="checkbox" checked={checked} onChange={() => toggleStore(storeFilter, setStoreFilter, s)} style={{ accentColor: "#10B981", cursor: "pointer" }} />
                      <span style={{ color: checked ? "#6EE7B7" : "#9CA3AF", fontSize: 13 }}>{s}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
          <div style={S.datePicker}>
            <label style={S.dateLabel}>Min ATS</label>
            <input
              type="number"
              style={{ ...S.dateInput, width: 72 }}
              placeholder="0"
              value={minATS}
              onChange={e => setMinATS(e.target.value === "" ? "" : Number(e.target.value))}
            />
          </div>
          <div style={S.datePicker}>
            <label style={S.dateLabel}>From</label>
            <input
              type="date"
              style={S.dateInput}
              value={startDate}
              onChange={e => setStartDate(e.target.value)}
            />
          </div>
          <div style={S.datePicker}>
            <label style={S.dateLabel}>Show</label>
            <input
              type="number"
              min="1"
              max={rangeUnit === "days" ? 365 : rangeUnit === "weeks" ? 52 : 24}
              style={{ ...S.dateInput, width: 60 }}
              value={rangeValue}
              onChange={e => { const v = Math.max(1, Number(e.target.value)); if (v) setRangeValue(v); }}
            />
            <select style={{ ...S.select, minWidth: 96 }} value={rangeUnit} onChange={e => { setRangeUnit(e.target.value as "days"|"weeks"|"months"); setRangeValue(e.target.value === "days" ? 14 : e.target.value === "weeks" ? 2 : 1); }}>
              <option value="days">Days</option>
              <option value="weeks">Weeks</option>
              <option value="months">Months</option>
            </select>
          </div>
          <div style={{ position: "relative" }}>
            <button
              style={{ ...S.select, display: "flex", alignItems: "center", gap: 6, cursor: "pointer", minWidth: 160, justifyContent: "space-between" }}
              onClick={() => setCustomerDropOpen(!customerDropOpen)}
            >
              <span style={{ color: "#10B981", fontSize: 11, fontWeight: 600, marginRight: 2 }}>Cust/Vend:</span>
              <span style={{ flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {customerFilter || "All"}
              </span>
              <span style={{ fontSize: 9, color: "#6B7280" }}>▼</span>
            </button>
            {customerDropOpen && (
              <div style={{ position: "absolute", top: "100%", left: 0, marginTop: 4, background: "#1E293B", border: "1px solid #334155", borderRadius: 8, zIndex: 100, width: 280, maxHeight: 340, display: "flex", flexDirection: "column", boxShadow: "0 8px 24px rgba(0,0,0,0.4)" }}>
                <div style={{ padding: "8px 10px", borderBottom: "1px solid #334155" }}>
                  <input
                    type="text"
                    placeholder="Search customers…"
                    value={customerSearch}
                    onChange={e => setCustomerSearch(e.target.value)}
                    autoFocus
                    style={{ width: "100%", background: "#0F172A", border: "1px solid #334155", borderRadius: 6, padding: "6px 10px", color: "#F1F5F9", fontSize: 12, fontFamily: "inherit", outline: "none" }}
                  />
                </div>
                <div style={{ overflowY: "auto", flex: 1 }}>
                  <div
                    style={{ padding: "7px 14px", cursor: "pointer", fontSize: 12, color: !customerFilter ? "#6EE7B7" : "#9CA3AF", background: !customerFilter ? "rgba(16,185,129,0.08)" : "transparent", fontWeight: !customerFilter ? 600 : 400 }}
                    onClick={() => { setCustomerFilter(""); setCustomerDropOpen(false); setCustomerSearch(""); }}
                    onMouseEnter={e => (e.currentTarget.style.background = "rgba(16,185,129,0.12)")}
                    onMouseLeave={e => (e.currentTarget.style.background = !customerFilter ? "rgba(16,185,129,0.08)" : "transparent")}
                  >All Customers</div>
                  {(() => {
                    const custSet = new Set<string>();
                    if (excelData) {
                      excelData.sos.forEach(s => { if (s.customerName) custSet.add(s.customerName); });
                      excelData.pos.forEach(p => { if (p.vendor) custSet.add(p.vendor); });
                    }
                    const all = [...custSet].sort();
                    const q = customerSearch.toLowerCase();
                    const filtered2 = q ? all.filter(c => c.toLowerCase().includes(q)) : all;
                    return filtered2.map(c => (
                      <div
                        key={c}
                        style={{ padding: "7px 14px", cursor: "pointer", fontSize: 12, color: customerFilter === c ? "#6EE7B7" : "#CBD5E1", background: customerFilter === c ? "rgba(16,185,129,0.08)" : "transparent", fontWeight: customerFilter === c ? 600 : 400 }}
                        onClick={() => { setCustomerFilter(c); setCustomerDropOpen(false); setCustomerSearch(""); }}
                        onMouseEnter={e => (e.currentTarget.style.background = "rgba(16,185,129,0.12)")}
                        onMouseLeave={e => (e.currentTarget.style.background = customerFilter === c ? "rgba(16,185,129,0.08)" : "transparent")}
                      >{c}</div>
                    ));
                  })()}
                </div>
              </div>
            )}
          </div>
          {/* AT SHIP toggle */}
          <label title="Show only qty free to ship — not reserved for future uncovered SOs" style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", padding: "4px 10px", borderRadius: 8, border: `1px solid ${atShip ? "#10B981" : "#334155"}`, background: atShip ? "rgba(16,185,129,0.12)" : "transparent", userSelect: "none", whiteSpace: "nowrap" }}>
            <input type="checkbox" checked={atShip} onChange={e => setAtShip(e.target.checked)} style={{ accentColor: "#10B981", cursor: "pointer", width: 14, height: 14 }} />
            <span style={{ color: atShip ? "#6EE7B7" : "#9CA3AF", fontSize: 12, fontWeight: atShip ? 700 : 400 }}>AT SHIP</span>
          </label>
          <div style={{ color: "#6B7280", fontSize: 12, whiteSpace: "nowrap" }}>
            {filtered.length.toLocaleString()} SKUs
            {lastSync && <span style={{ display: "block" }}>Synced {fmtDateDisplay(lastSync.split("T")[0])} {new Date(lastSync).toLocaleTimeString()}</span>}
          </div>
        </div>

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

        {/* PAGINATION */}
        {totalPages > 1 && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12, marginTop: 16, flexWrap: "wrap" }}>
            <button
              style={{ ...S.navBtn, opacity: page === 0 ? 0.3 : 1, cursor: page === 0 ? "default" : "pointer" }}
              disabled={page === 0}
              onClick={() => setPage(p => Math.max(0, p - 1))}
            >← Prev</button>
            <span style={{ color: "#9CA3AF", fontSize: 13 }}>
              Page {page + 1} of {totalPages} &nbsp;·&nbsp; {filtered.length.toLocaleString()} SKUs
            </span>
            <button
              style={{ ...S.navBtn, opacity: page >= totalPages - 1 ? 0.3 : 1, cursor: page >= totalPages - 1 ? "default" : "pointer" }}
              disabled={page >= totalPages - 1}
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
            >Next →</button>
          </div>
        )}
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
