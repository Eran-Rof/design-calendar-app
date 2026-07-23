import React, { useEffect, useMemo, useState } from "react";
import S from "./styles";
import { filterRows } from "./filter";
import { StatCard } from "./StatCard";
import { fmtDate, fmtDateDisplay, isToday, isWeekend, getQtyColor, getQtyBg } from "./helpers";
import { StatsRow } from "./panels/StatsRow";
import { MergeConfirmModal } from "./panels/MergeConfirmModal";
import { UploadWarningsModal } from "./panels/UploadWarningsModal";
import { NormalizationReviewModal } from "./panels/NormalizationReviewModal";
import { UploadProgressOverlay, SuccessToast, UploadErrorModal } from "./panels/StatusOverlays";
import { UploadModal } from "./panels/UploadModal";
import { SummaryContextMenu, CellContextMenu } from "./panels/ContextMenus";
import { SOLineItemsModal, type SOLineItem } from "./panels/SOLineItemsModal";
import { resolveItemMasterIds, getItemMasterById } from "./itemMasterLookup";
import { Pagination } from "./panels/Pagination";
import { NavBar } from "./panels/NavBar";
import { Toolbar } from "./panels/Toolbar";
import { GridTable } from "./panels/GridTable";
import { GridErrorBoundary } from "./panels/GridErrorBoundary";
import { UnmatchedBanner } from "./panels/UnmatchedBanner";
import { exportIncompleteSkus } from "./exportIncompleteSkus";
import { exportStockVsSo } from "./exportStockVsSo";
import type { ReportPayload } from "./reportPayload";
import type { AgedInvenResult } from "./exportAgedInven";
import type { ATSState } from "./state/atsTypes";
import type { ATSRow, ExcelData, ATSPoEvent, ATSSoEvent, UploadWarning } from "./types";
import { GlobalSearchPaletteAuto } from "../components/GlobalSearchPalette";
import { StyleGalleryHost } from "../shared/ui/StyleImageGallery";
import { useCanSeeMargins } from "../hooks/useCanSeeMargins";
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
  // LEAF rows (collapse NOT applied), filtered + sorted. Feeds the Excel
  // export, reports, and the AI snapshot so they're identical on any grid
  // view — the grid's collapse is a display-only transform carried by
  // pageRows. (ATS passes its `sortedLeaves` here.)
  sortedFiltered: ATSRow[];
  // Calc sets = filtered/sortedFiltered MINUS excluded ("X") rows. Feed
  // every aggregation + report; the grid display still uses filtered/pageRows
  // so excluded rows stay visible (greyed) and can be unchecked.
  // calcSortedFiltered is leaf-grain (see sortedFiltered above).
  calcFiltered: ATSRow[];
  calcSortedFiltered: ATSRow[];
  // Distinct excluded rows currently loaded — drives the pre-report warning.
  excludedReportRows: ATSRow[];
  // Excluded SKU set + per-row toggle, threaded to the grid's "X" column.
  excludedSet: ReadonlySet<string>;
  onToggleExclude: (sku: string) => void;
  // Bulk exclude/include for the "X" column header's select-all / clear-all.
  onToggleExcludeAll: (skus: string[], exclude: boolean) => void;
  pageRows: ATSRow[];
  totalPages: number;
  categories: string[];
  subCategories: string[];
  // master_style values scoped to the active Category + Sub Cat filters
  // (see ATS.tsx). Drives the Style multi-select dropdown in the toolbar.
  styles: string[];
  // Full brand_master name list (every brand the Tangerine app knows
  // about). Drives the Brand multi-select dropdown in the toolbar.
  brandOptions: string[];
  unmatchedRows: ATSRow[];
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
  // Drag state (plain useState, not reducer)
  dragSku: string | null;
  setDragSku: (v: string | null) => void;
  dragOverSku: string | null;
  setDragOverSku: (v: string | null) => void;
  pendingMerge: { fromSku: string; toSku: string; similarity: number } | null;
  setPendingMerge: (v: { fromSku: string; toSku: string; similarity: number } | null) => void;
  isAdmin: boolean;
  // True once the ip_item_master cache has loaded. Until then matchedRows
  // is empty (every row reads as unmatched) so the grid would otherwise
  // show "No SKUs match your filters" during the 2-4s master-cache fetch.
  // We treat that window as still-loading.
  masterReady: boolean;
  // Callbacks
  handleFileUpload: (inv: File, pur: File | null, ord: File) => Promise<void>;
  refreshPOsFromWIP: () => Promise<void>;
  handleThClick: (col: string) => void;
  loadFromSupabase: () => Promise<void>;
  saveUploadData: (data: ExcelData) => Promise<void>;
  toggleStore: (current: string[], set: (v: string[]) => void, store: string) => void;
  exportToExcel: (
    rows: ATSRow[],
    periods: Array<{ endDate: string; label: string }>,
    hiddenColumns: string[],
    totals?: import("./computeTotals").GridTotals | null,
    options?: import("./panels/ExportOptionsModal").ExportOptions,
    eventIndex?: Record<string, Record<string, { pos: ATSPoEvent[]; sos: ATSSoEvent[] }>> | null,
    salesAggregates?: import("./exportSalesFetch").SalesFetchResult,
    explodePpk?: boolean,
    customerSoMap?: Map<string, { qty: number; soPrice: number }>,
    sizeMatrix?: import("./exportExcel").AtsSizeMatrixResponse,
    bulkByStyleColor?: Map<string, { so: number; po: number }>,
    periodMatrices?: Array<{ name: string; matrix: import("./exportExcel").AtsSizeMatrixResponse }>,
  ) => void;
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
  clearMergeAndNavigate: () => Promise<void>;
  saveMergeHistory: (history: Array<{ fromSku: string; toSku: string }>) => Promise<void>;
  toggleExpandGroup: (key: string) => void;
  expandedGroupSet: ReadonlySet<string>;
  // Both report handlers now return a payload (or sentinel) so the
  // NavBar can route them through the shared preview-before-download
  // modal.
  onNegInven: (includeExcluded?: boolean) => ReportPayload | null;
  onAgedInven: (days: number, category: string, includeExcluded?: boolean) => AgedInvenResult;
  unreadNotifs: number;
  showingNotifications: boolean;
  onToggleNotifications: () => void;
  notificationsView?: React.ReactNode;
}

export type ATSRenderCtx = ATSState & ATSStateSetters & ATSDerivedCtx;

export function atsRenderPanel(ctx: ATSRenderCtx): React.ReactElement {
  const { startDate, setStartDate, rangeUnit, setRangeUnit, rangeValue, setRangeValue, search, setSearch, filterCategory, setFilterCategory, filterSubCategory, setFilterSubCategory, filterStyle, setFilterStyle, styles, filterGender, setFilterGender, filterBrand, setFilterBrand, brandOptions, filterStatus, setFilterStatus, minATS, setMinATS, soWinFrom, setSoWinFrom, soWinTo, setSoWinTo, storeFilter, setStoreFilter, poDropOpen, setPoDropOpen, soDropOpen, setSoDropOpen, rows, setRows, loading, mockMode, page, setPage, excelData, setExcelData, uploadingFile, uploadProgress, uploadSuccess, setUploadSuccess, uploadError, setUploadError, uploadWarnings, setUploadWarnings, pendingUploadData, setPendingUploadData, showUpload, setShowUpload, invFile, setInvFile, purFile, setPurFile, ordFile, setOrdFile, lastSync, hoveredCell, setHoveredCell, pinnedSku, setPinnedSku, ctxMenu, setCtxMenu, summaryCtx, setSummaryCtx, activeSort, setActiveSort, sortCol, setSortCol, sortDir, setSortDir, STORES, PAGE_SIZE, poStores, soStores, poDropRef, soDropRef, invRef, purRef, ordRef, ctxRef, summaryCtxRef, tableRef, dates, displayPeriods, eventIndex, filtered, statFiltered, sortedFiltered, calcFiltered, calcSortedFiltered, excludedReportRows, excludedSet, onToggleExclude, onToggleExcludeAll, pageRows, totalPages, categories, subCategories, unmatchedRows, filteredSkuSet, totalSoValue, totalPoValue, marginDollars, marginPct, handleFileUpload, handleThClick, loadFromSupabase, saveUploadData, toggleStore, exportToExcel, repositionCtxMenu, repositionSummaryCtx, cancelRef, abortRef, cancelUpload, openSummaryCtx, getEventsInPeriod, lowStock, negATSCount, zeroStock, totalSKUs, totalPoQty, totalSoQty, todayKey, normChanges, setNormChanges, applyNormReview, dismissNormReview, customerFilter, setCustomerFilter, customerDropOpen, setCustomerDropOpen, customerSearch, setCustomerSearch, dragSku, setDragSku, dragOverSku, setDragOverSku, pendingMerge, setPendingMerge, isAdmin, commitMerge, handleSkuDrop,
  mergeHistory, undoLastMerge, clearMergeAndNavigate,
  viewMode, setViewMode, onNegInven, onAgedInven,
  showTotalsRow, setShowTotalsRow,
  showStatsCards, setShowStatsCards,
  explodePpk, setExplodePpk,
  showImages, setShowImages,
  freezeKey, setFreezeKey,
  hiddenColumns, setHiddenColumns,
  generalMarginPct, setGeneralMarginPct,
  collapseLevel, setCollapseLevel, expandedGroups, expandedGroupSet, toggleExpandGroup,
  unreadNotifs, showingNotifications, onToggleNotifications, notificationsView, masterReady } = ctx;

  // Margin visibility gate (P14 RBAC `margins:read`). Fails open until
  // enforcement is live. Drives the Margin KPI card in StatsRow.
  const { canView: canViewMargin } = useCanSeeMargins();

  // ── Reciprocal filter cascade for the grid toolbar (#9) ────────────────
  // Each toolbar dropdown's options reflect the rows that pass EVERY OTHER
  // active filter (search + the other dropdowns + store + status), so
  // selecting a Category / Sub Cat / Style / Gender narrows the others to
  // what actually exists, and clearing one re-widens them. Built on the same
  // `filterRows` predicate the grid itself uses, so options never diverge
  // from results. These grid* lists feed ONLY the toolbar — the broader
  // `categories/subCategories/styles` (passed to NavBar) stay full so Sales
  // Comps can still broaden a report past the grid's current filter.
  // customerSkuSet is intentionally null: the customer overlay is an
  // orthogonal scope and must not hide otherwise-valid filter values.
  const cascadeMatched = useMemo(() => rows.filter(r => r.master_match_source != null), [rows]);
  const cascadeToday = useMemo(() => new Date(), []);
  const cascadeBase = useMemo(() => ({
    search,
    filterCategory, filterSubCategory, filterStyle, filterGender, filterBrand,
    filterStatus, minATS, storeFilter,
    customerSkuSet: null as Set<string> | null,
    today: cascadeToday,
    displayPeriods: displayPeriods.map(p => ({ endDate: p.endDate })),
  }), [search, filterCategory, filterSubCategory, filterStyle, filterGender, filterBrand, filterStatus, minATS, storeFilter, cascadeToday, displayPeriods]);

  // Category keeps its "active rows only" declutter AND narrows by the others.
  const gridCategories = useMemo(() => ["All", ...Array.from(new Set(
    filterRows(cascadeMatched, { ...cascadeBase, filterCategory: [] })
      .filter(r => r.onHand > 0 || r.onPO > 0 || r.onOrder > 0)
      .map(r => r.master_category).filter(Boolean) as string[],
  )).sort()], [cascadeMatched, cascadeBase]);
  const gridSubCategories = useMemo(() => ["All", ...Array.from(new Set(
    filterRows(cascadeMatched, { ...cascadeBase, filterSubCategory: [] })
      .map(r => r.master_sub_category).filter(Boolean) as string[],
  )).sort()], [cascadeMatched, cascadeBase]);
  const gridStyles = useMemo(() => Array.from(new Set(
    filterRows(cascadeMatched, { ...cascadeBase, filterStyle: [] })
      .map(r => r.master_style).filter(Boolean) as string[],
  )).sort(), [cascadeMatched, cascadeBase]);
  // Gender: the canonical short codes (preserves the toolbar's M/B/C/Wms/G
  // order + labels) that actually appear in the cross-filtered pool.
  const gridGenders = useMemo(() => {
    const present = new Set(
      filterRows(cascadeMatched, { ...cascadeBase, filterGender: [] })
        .map(r => (r.master_gender ?? r.gender ?? "").trim().toUpperCase())
        .filter(Boolean),
    );
    return ["M", "B", "C", "Wms", "G"].filter(c => present.has(c.toUpperCase()));
  }, [cascadeMatched, cascadeBase]);

  // Drop selections that fall out of scope as other filters change, so a
  // stale pick doesn't silently narrow the grid to nothing. Each list is
  // computed with its OWN dimension omitted, so these prunes only remove and
  // can't oscillate.
  useEffect(() => {
    if (filterSubCategory.length === 0) return;
    const valid = new Set(gridSubCategories);
    const next = filterSubCategory.filter(v => valid.has(v));
    if (next.length !== filterSubCategory.length) setFilterSubCategory(next);
  }, [gridSubCategories, filterSubCategory, setFilterSubCategory]);
  useEffect(() => {
    if (filterStyle.length === 0) return;
    const valid = new Set(gridStyles);
    const next = filterStyle.filter(v => valid.has(v));
    if (next.length !== filterStyle.length) setFilterStyle(next);
  }, [gridStyles, filterStyle, setFilterStyle]);
  useEffect(() => {
    if (filterGender.length === 0) return;
    const valid = new Set(gridGenders);
    const next = filterGender.filter(v => valid.has(v));
    if (next.length !== filterGender.length) setFilterGender(next);
  }, [gridGenders, filterGender, setFilterGender]);

  // SO line-items modal — opened by clicking an SO order number in
  // the On Order right-click menu. Holds the selected orderNumber;
  // the lineItems are derived from excelData.sos + master unit_cost.
  const [soDetailOrder, setSoDetailOrder] = useState<string | null>(null);

  // Build the full line-item set for the selected SO at click time.
  // Pulls every SO event from excelData.sos that matches orderNumber,
  // looks up unit_cost via the item-master cache (per-sku weighted-
  // avg across resolved variant ids), and feeds the modal.
  const soDetailLineItems = useMemo<SOLineItem[]>(() => {
    if (!soDetailOrder || !excelData) return [];
    const matches = excelData.sos.filter(s => s.orderNumber === soDetailOrder);
    return matches.map(s => {
      // Cost lookup mirrors the export's master-id resolution: try
      // variant-level first, fall back to style-level via the row's
      // base part. resolveItemMasterIds returns every variant under
      // the (style, color) family — we weighted-avg their unit_costs
      // since size variants typically share the same cost.
      const spaceDelim = s.sku.indexOf(" - ");
      const stylePart = spaceDelim !== -1 ? s.sku.slice(0, spaceDelim).trim() : s.sku.trim();
      const ids = resolveItemMasterIds(s.sku, stylePart || null);
      let costSum = 0, costCount = 0;
      for (const id of ids) {
        const rec = getItemMasterById(id);
        const uc = rec?.unit_cost;
        if (typeof uc === "number" && uc > 0) {
          costSum += uc;
          costCount += 1;
        }
      }
      const unitCost = costCount > 0 ? costSum / costCount : 0;
      return {
        sku: s.sku,
        description: s.sku, // SO event itself doesn't carry a clean description; sku stands in
        qty: s.qty,
        unitPrice: s.unitPrice,
        totalPrice: s.totalPrice,
        unitCost,
        customerName: s.customerName,
        store: s.store,
        date: s.date,
        customerPo: s.customerPo,
      };
    });
  }, [soDetailOrder, excelData]);

  const soDetailHeader = useMemo(() => {
    if (soDetailLineItems.length === 0) return { customerName: "", customerPo: "" };
    // First line's metadata is fine — SO header fields don't vary by line.
    const first = soDetailLineItems[0];
    return {
      customerName: first.customerName ?? "",
      customerPo: first.customerPo ?? "",
    };
  }, [soDetailLineItems]);

  // Ask AI: build a fresh snapshot of grid context every time the user
  // hits Send. Snapshot is computed inside the closure so it always
  // reflects live filter/sort/row state (renderPanel re-runs on every
  // ATS state change, so the captured variables are current).
  const aiBuildContext = () => {
    const rowsForSnapshot = sortedFiltered;
    const SAMPLE_LIMIT = 20;
    const sample = rowsForSnapshot.slice(0, SAMPLE_LIMIT).map(r => ({
      sku: r.sku,
      description: r.master_description ?? r.description ?? "",
      category: r.master_category ?? r.category ?? null,
      sub_category: r.master_sub_category ?? null,
      style: r.master_style ?? null,
      color: r.master_color ?? null,
      gender: r.master_gender ?? r.gender ?? null,
      store: r.store ?? null,
      onHand: r.onHand,
      onPO: r.onPO,
      onOrder: r.onOrder,
      avgCost: r.avgCost ?? null,
    }));
    const totalOnHand  = rowsForSnapshot.reduce((s, r) => s + (r.onHand  || 0), 0);
    const totalOnPO    = rowsForSnapshot.reduce((s, r) => s + (r.onPO    || 0), 0);
    const totalOnOrder = rowsForSnapshot.reduce((s, r) => s + (r.onOrder || 0), 0);
    const distinctSet = (vals: Array<string | null | undefined>) =>
      Array.from(new Set(vals.filter((v): v is string => !!v && v.length > 0))).sort();
    return {
      columns: ["sku","description","category","sub_category","style","color","gender","store","onHand","onPO","onOrder","avgCost"],
      active_filters: {
        search: search || undefined,
        category: filterCategory,
        sub_category: filterSubCategory,
        style: filterStyle,
        gender: filterGender,
        status: filterStatus,
        min_ats: minATS === "" ? null : minATS,
        store: storeFilter,
        customer: customerFilter || undefined,
      },
      sort: sortCol ? { col: sortCol, dir: sortDir } : null,
      row_count: rowsForSnapshot.length,
      // These totals describe the CURRENT VISIBLE GRID ONLY — the sum across
      // every row the operator is looking at, NOT scoped by customer or by
      // date. They are useful for grid-state questions ("how many SKUs are
      // low stock right now") but MUST NOT be used as a substitute for a
      // real DB query when answering customer-scoped or date-scoped
      // questions (those need query_shipments / customer_card / style_card).
      // The grid_fallback_margin_pct is an operator-set assumption used by
      // the ATS export when per-SKU costs are missing — it is NOT a measured
      // margin and NEVER reflects actual historical margin for any customer.
      totals: {
        _caveat: "Grid-wide visible totals only. Sum across all currently-filtered rows, NOT scoped by customer or date. For 'how much did X buy', run query_shipments. NEVER multiply grid_visible_so_value by grid_fallback_margin_pct — that does not produce a real margin.",
        grid_visible_on_hand:  totalOnHand,
        grid_visible_on_po:    totalOnPO,
        grid_visible_on_order: totalOnOrder,
        grid_visible_so_value: totalSoValue,
        grid_visible_po_value: totalPoValue,
        grid_fallback_margin_pct: marginPct,
      },
      distinct: {
        categories:     distinctSet(rows.map(r => r.master_category ?? r.category)),
        sub_categories: distinctSet(rows.map(r => r.master_sub_category)),
        styles:         distinctSet(rows.map(r => r.master_style)),
        genders:        distinctSet(rows.map(r => r.master_gender ?? r.gender)),
        stores:         distinctSet(rows.map(r => r.store)),
      },
      sample_rows: sample,
    };
  };
  const aiSetters = {
    setSearch, setFilterCategory, setFilterSubCategory, setFilterStyle,
    setFilterGender, setFilterStatus, setMinATS, setStoreFilter,
    setSortCol, setSortDir, setActiveSort,
  };

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
        /* App-wide scrollbar theme lives in index.html so it applies to
           every scroll surface (page, modals, this grid). The grid's
           always-visible behaviour comes from overflowX:"scroll" in
           styles.ts — the visual styling is inherited from the global
           rules. */
      `}</style>
      <NavBar
        mergeHistory={mergeHistory}
        undoLastMerge={undoLastMerge}
        onNavigateHome={clearMergeAndNavigate}
        setShowUpload={setShowUpload}
        uploadingFile={uploadingFile}
        invFile={invFile}
        purFile={purFile}
        ordFile={ordFile}
        exportToExcel={exportToExcel}
        filtered={calcSortedFiltered}
        fullFiltered={sortedFiltered}
        excludedRows={excludedReportRows}
        displayPeriods={displayPeriods}
        hiddenColumns={hiddenColumns ?? []}
        showTotalsRow={showTotalsRow ?? false}
        eventIndex={eventIndex}
        viewMode={viewMode ?? "ats"}
        generalMarginPct={generalMarginPct ?? 21}
        onNegInven={onNegInven}
        onAgedInven={onAgedInven}
        // Both report builders now return a payload (instead of
        // downloading directly) so the NavBar can route them through
        // the shared preview-before-download modal. Excel output is
        // unchanged — the modal flushes the same workbook on Download.
        onDownloadIncompleteSkus={(includeExcluded) => exportIncompleteSkus(includeExcluded ? filtered : calcFiltered, eventIndex)}
        onDownloadStockVsSo={(includeExcluded) => exportStockVsSo(includeExcluded ? filtered : calcFiltered, eventIndex)}
        categories={categories}
        subCategories={subCategories}
        styles={styles ?? []}
        STORES={STORES}
        filterCategory={filterCategory.length === 1 ? filterCategory[0] : "All"}
        customerFilter={customerFilter ?? ""}
        exportFilterOpts={{
          search,
          filterCategory,
          filterSubCategory,
          filterStyle,
          filterGender,
          filterStatus,
          minATS,
          storeFilter,
          today: new Date(),
        }}
        explodePpk={explodePpk ?? true}
        unreadNotifs={unreadNotifs}
        showingNotifications={showingNotifications}
        onToggleNotifications={onToggleNotifications}
        excelData={excelData}
        setExcelData={setExcelData}
        aiBuildContext={aiBuildContext}
        aiSetters={aiSetters}
        filteredCount={filtered.length}
        lastSync={lastSync}
      />
      <UnmatchedBanner
        unmatchedRows={unmatchedRows}
        // The banner is only "ready" once the master-aware enrichment
        // has actually run on `rows` — checked via the cheap
        // `rows.some(... master_match_source != null)`. masterReady
        // flips true the moment the cache resolves, but there's a
        // microtask gap before the rows useEffect re-runs and
        // produces the post-master row set. Waiting on `rows` to
        // contain at least one matched row guarantees the count
        // shown is the stable post-load value (e.g. 12) instead of
        // the pre-load transient (e.g. 2760 every row unmatched).
        // The banner adds its own 200ms grace on top.
        ready={
          !loading
          && masterReady
          && rows.length > 0
          && rows.some(r => r.master_match_source != null)
        }
      />

      {showingNotifications ? (
        <div style={{ ...S.content, padding: "24px 24px 60px" }}>
          {notificationsView}
        </div>
      ) : (
      <div style={S.content}>
        {/* STAT CARDS — toggleable. The ▼/▶ triangle sits in its own
            thin row ABOVE the cards, anchored hard-right. Sits above
            the cards (never overlaps card content), stays in the same
            spot when cards collapsed. */}
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 4 }}>
          <button
            onClick={() => setShowStatsCards!(!showStatsCards)}
            title={showStatsCards ? "Hide the stat cards on top" : "Show the stat cards on top"}
            style={{
              background: "transparent",
              border: `1px solid ${showStatsCards ? "#10B981" : "#334155"}`,
              color: "#10B981",
              cursor: "pointer",
              padding: "4px 10px",
              borderRadius: 8,
              fontSize: 13,
              lineHeight: 1,
              display: "inline-flex",
              alignItems: "center",
              whiteSpace: "nowrap",
            }}
          >
            {showStatsCards ? "▼" : "▶"}
          </button>
        </div>
        {showStatsCards && (
          <StatsRow
            lowStock={lowStock} zeroStock={zeroStock} negATSCount={negATSCount} totalSKUs={totalSKUs}
            totalSoQty={totalSoQty} totalSoValue={totalSoValue}
            totalPoQty={totalPoQty} totalPoValue={totalPoValue}
            marginDollars={marginDollars} marginPct={marginPct}
            canViewMargin={canViewMargin}
            activeSort={activeSort} setActiveSort={setActiveSort}
          />
        )}

        {/* TOOLBAR */}
        <Toolbar
          search={search} setSearch={setSearch}
          filterCategory={filterCategory} setFilterCategory={setFilterCategory} categories={gridCategories}
          filterSubCategory={filterSubCategory} setFilterSubCategory={setFilterSubCategory} subCategories={gridSubCategories}
          filterStyle={filterStyle ?? []} setFilterStyle={setFilterStyle!} styles={gridStyles}
          filterGender={filterGender} setFilterGender={setFilterGender} genderOptions={gridGenders}
          filterBrand={filterBrand ?? []} setFilterBrand={setFilterBrand!} brandOptions={brandOptions ?? []}
          setFilterStatus={setFilterStatus}
          STORES={STORES} storeFilter={storeFilter} setStoreFilter={setStoreFilter}
          poDropOpen={poDropOpen} setPoDropOpen={setPoDropOpen} setSoDropOpen={setSoDropOpen}
          poDropRef={poDropRef} toggleStore={toggleStore}
          minATS={minATS} setMinATS={setMinATS}
          soWinFrom={soWinFrom ?? ""} setSoWinFrom={setSoWinFrom ?? (() => {})}
          soWinTo={soWinTo ?? ""} setSoWinTo={setSoWinTo ?? (() => {})}
          startDate={startDate} setStartDate={setStartDate}
          rangeUnit={rangeUnit} setRangeUnit={setRangeUnit}
          rangeValue={rangeValue} setRangeValue={setRangeValue}
          excelData={excelData}
          customerFilter={customerFilter} setCustomerFilter={setCustomerFilter}
          customerDropOpen={customerDropOpen} setCustomerDropOpen={setCustomerDropOpen}
          customerSearch={customerSearch} setCustomerSearch={setCustomerSearch}
          collapseLevel={collapseLevel} setCollapseLevel={setCollapseLevel!}
          viewMode={viewMode ?? "ats"} setViewMode={setViewMode!}
          showTotalsRow={showTotalsRow} setShowTotalsRow={setShowTotalsRow!}
          explodePpk={explodePpk ?? true} setExplodePpk={setExplodePpk!}
          showImages={showImages ?? true} setShowImages={setShowImages!}
          freezeKey={freezeKey ?? null} setFreezeKey={setFreezeKey!}
          hiddenColumns={hiddenColumns ?? []} setHiddenColumns={setHiddenColumns!}
          generalMarginPct={generalMarginPct ?? 21} setGeneralMarginPct={setGeneralMarginPct!}
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
        <GridErrorBoundary>
          <GridTable
            loading={loading
              || (excelData != null && excelData.skus.length > 0 && rows.length === 0)
              || (excelData != null && excelData.skus.length > 0 && !masterReady && filtered.length === 0)
            } filtered={filtered} totalsRows={calcFiltered} pageRows={pageRows}
            excludedSet={excludedSet} onToggleExclude={onToggleExclude} onToggleExcludeAll={onToggleExcludeAll}
            displayPeriods={displayPeriods} tableRef={tableRef}
            sortCol={sortCol} sortDir={sortDir} handleThClick={handleThClick} rangeUnit={rangeUnit}
            pinnedSku={pinnedSku} setPinnedSku={setPinnedSku}
            dragSku={dragSku} setDragSku={setDragSku}
            dragOverSku={dragOverSku} setDragOverSku={setDragOverSku}
            hoveredCell={hoveredCell} setHoveredCell={setHoveredCell}
            todayKey={todayKey} viewMode={viewMode ?? "ats"}
            negMode={activeSort === "negATS"}
            showTotalsRow={showTotalsRow}
            explodePpk={explodePpk ?? true}
            showImages={showImages ?? true}
            freezeKey={freezeKey ?? null}
            hiddenColumns={hiddenColumns ?? []}
            generalMarginPct={generalMarginPct ?? 21}
            eventIndex={eventIndex} getEventsInPeriod={getEventsInPeriod}
            ctxMenu={ctxMenu} setCtxMenu={setCtxMenu} setSummaryCtx={setSummaryCtx}
            openSummaryCtx={openSummaryCtx} handleSkuDrop={handleSkuDrop}
            toggleExpandGroup={toggleExpandGroup}
            expandedGroupSet={expandedGroupSet}
          />
        </GridErrorBoundary>

        <Pagination page={page} totalPages={totalPages} setPage={setPage} filteredCount={filtered.length} />
      </div>
      )}

      <SummaryContextMenu
        summaryCtx={summaryCtx}
        summaryCtxRef={summaryCtxRef}
        setSummaryCtx={setSummaryCtx}
        customerFilter={customerFilter ?? ""}
        onOpenSoDetails={(orderNumber) => { setSoDetailOrder(orderNumber); setSummaryCtx(null); }}
      />
      <SOLineItemsModal
        open={soDetailOrder !== null}
        orderNumber={soDetailOrder ?? ""}
        customerName={soDetailHeader.customerName}
        customerPo={soDetailHeader.customerPo}
        lineItems={soDetailLineItems}
        onClose={() => setSoDetailOrder(null)}
      />
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

      {/* Cross-cutter T6-3 — ⌘K / Ctrl-K global search palette. */}
      <GlobalSearchPaletteAuto />

      {/* Image gallery host — openStyleGallery() (from the per-row style
          thumbnails) renders its lightbox into this singleton. Mounted
          here so the ATS app gets the same enlarge / download / print
          gallery the Tangerine app uses. */}
      <StyleGalleryHost />
    </div>
  );
}
