import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from "react";
import XLSXStyle from "xlsx-js-style";
import { SB_URL, SB_KEY, SB_HEADERS } from "./utils/supabase";
import type { ATSRow, ATSSnapshot, ATSSkuData, ATSPoEvent, ATSSoEvent, UploadWarning, ExcelData, CtxMenu, SummaryCtxMenu } from "./ats/types";
import { addDays, fmtDate, fmtDateShort, fmtDateDisplay, fmtDateHeader, isToday, isWeekend, getQtyColor, getQtyBg, xoroSkuToExcel, skuSimilarity } from "./ats/helpers";
import { computeRowsFromExcelData } from "./ats/compute";
import { mergeExcelDataSkus, mergeRows, dedupeExcelData } from "./ats/merge";
import { useMergeHistory } from "./ats/hooks/useMergeHistory";
import { usePOWIPSync } from "./ats/hooks/usePOWIPSync";
import { useRowFiltering } from "./ats/hooks/useRowFiltering";
import { useExcelUpload } from "./ats/hooks/useExcelUpload";
import { exportToExcel } from "./ats/exportExcel";
import { exportNegInven } from "./ats/exportNegInven";
import { exportAgedInven } from "./ats/exportAgedInven";
import { normalizeExcelData, detectNormChanges, applyNormChanges, mergeNormDecisions, type NormChange, type NormDecisions } from "./ats/normalize";
import S from "./ats/styles";
import { StatCard } from "./ats/StatCard";
import { ATSProvider, useATSState, useATSDispatch } from "./ats/state/ATSContext";
import type { ATSState, ATSAction } from "./ats/state/atsTypes";
import { atsRenderPanel } from "./ats/renderPanel";

// ── Main Component ────────────────────────────────────────────────────────────
export default function ATSReportWrapper() {
  return <ATSProvider><ATSReport /></ATSProvider>;
}

function ATSReport() {
  const st = useATSState();
  const stD = useATSDispatch();
  // Typed setter factory: accepts a plain value OR a functional updater
  // (prev => next), mirroring React's useState API. The reducer resolves
  // updaters against current state, so functional form is always safe.
  type Updater<T> = T | ((prev: T) => T);
  // The `as ATSAction` cast is required because TS can't prove a generic K
  // satisfies any individual variant of the discriminated SetAction union.
  // The runtime shape is correct — the reducer handles both plain values and
  // functional updaters.
  const mk = <K extends keyof ATSState>(field: K) =>
    (value: Updater<ATSState[K]>) => stD({ type: "SET", field, value } as ATSAction);
  const today = new Date();
  // ── State → useATSState() + useATSDispatch() (see ats/state/) ──
  const {
    startDate, rangeUnit, rangeValue, search, filterCategory, filterGender, filterStatus,
    minATS, storeFilter, poDropOpen, soDropOpen, rows, loading, mockMode,
    page, excelData, uploadingFile, uploadProgress, uploadSuccess, uploadError,
    uploadWarnings, pendingUploadData, showUpload, invFile, purFile, ordFile,
    syncing, syncStatus, lastSync, syncError, hoveredCell, pinnedSku, ctxMenu,
    summaryCtx, activeSort, sortCol, sortDir, mergeHistory, atShip,
    normChanges, normPendingData, normSource, customerFilter, customerDropOpen,
    customerSearch,
  } = st;
  const setStartDate         = mk("startDate");
  const setRangeUnit         = mk("rangeUnit");
  const setRangeValue        = mk("rangeValue");
  const setSearch            = mk("search");
  const setFilterCategory    = mk("filterCategory");
  const setFilterGender      = mk("filterGender");
  const setFilterStatus      = mk("filterStatus");
  const setMinATS            = mk("minATS");
  const setStoreFilter       = mk("storeFilter");
  const setPoDropOpen        = mk("poDropOpen");
  const setSoDropOpen        = mk("soDropOpen");
  const setRows              = mk("rows");
  const setLoading           = mk("loading");
  const setMockMode          = mk("mockMode");
  const setPage              = mk("page");
  const setExcelData         = mk("excelData");
  const setUploadingFile     = mk("uploadingFile");
  const setUploadProgress    = mk("uploadProgress");
  const setUploadSuccess     = mk("uploadSuccess");
  const setUploadError       = mk("uploadError");
  const setUploadWarnings    = mk("uploadWarnings");
  const setPendingUploadData = mk("pendingUploadData");
  const setShowUpload        = mk("showUpload");
  const setInvFile           = mk("invFile");
  const setPurFile           = mk("purFile");
  const setOrdFile           = mk("ordFile");
  const setSyncing           = mk("syncing");
  const setSyncStatus        = mk("syncStatus");
  const setLastSync          = mk("lastSync");
  const setSyncError         = mk("syncError");
  const setHoveredCell       = mk("hoveredCell");
  const setPinnedSku         = mk("pinnedSku");
  const setCtxMenu           = mk("ctxMenu");
  const setSummaryCtx        = mk("summaryCtx");
  const setActiveSort        = mk("activeSort");
  const setSortCol           = mk("sortCol");
  const setSortDir           = mk("sortDir");
  const setMergeHistory      = mk("mergeHistory");
  const setAtShip            = mk("atShip");
  const setNormChanges       = mk("normChanges");
  const setNormPendingData   = mk("normPendingData");
  const setNormSource        = mk("normSource");
  const setCustomerFilter    = mk("customerFilter");
  const setCustomerDropOpen  = mk("customerDropOpen");
  const setCustomerSearch    = mk("customerSearch");
  const STORES = ["ROF", "ROF ECOM", "PT"] as const;
  const poStores = storeFilter;
  const soStores = storeFilter;
  const setPoStores = setStoreFilter;
  const setSoStores = setStoreFilter;
  const PAGE_SIZE = 100;
  const poDropRef = useRef<HTMLDivElement>(null);
  const soDropRef = useRef<HTMLDivElement>(null);
  const invRef = useRef<HTMLInputElement>(null);
  const purRef = useRef<HTMLInputElement>(null);
  const ordRef = useRef<HTMLInputElement>(null);
  const ctxRef = useRef<HTMLDivElement>(null);
  const summaryCtxRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);

  // ── Drag-to-merge state ──────────────────────────────────────────────────
  const [dragSku,     setDragSku]     = useState<string | null>(null);
  const [dragOverSku, setDragOverSku] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);

  // PO WIP sync — order matters: useMergeHistory needs applyPOWIPData.
  const { applyPOWIPData, refreshPOsFromWIP } = usePOWIPSync({
    excelData,
    setExcelData,
    setUploadingFile,
    setUploadSuccess,
  });

  // Merge history + pending-merge UI state + commit/undo/drop flows live in
  // their own hook (see useMergeHistory). The hook is stateless about
  // mergeHistory itself (owned by the ATS reducer) but owns pendingMerge.
  const mergeActions = useMergeHistory({
    mergeHistory,
    setMergeHistory,
    excelData,
    setExcelData,
    rows,
    setRows,
    applyPOWIPData,
    saveNormResult: (d: ExcelData) => saveNormResult(d),
    isAdmin,
  });
  const {
    pendingMerge, setPendingMerge,
    saveMergeHistory, commitMerge, handleSkuDrop, undoLastMerge,
  } = mergeActions;

  useEffect(() => {
    fetch(`${SB_URL}/rest/v1/app_data?key=eq.users&select=value`, { headers: SB_HEADERS })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(rows => {
        if (!rows?.length) return;
        const users: Array<{ name: string; role?: string }> = JSON.parse(rows[0].value);
        const stored = localStorage.getItem("ats_user");
        const match = stored ? users.find(u => u.name === stored) : null;
        setIsAdmin((match ?? users[0])?.role === "admin");
      })
      .catch(e => console.warn("Failed to load admin users:", e));
  }, []);

  // commitMerge, handleSkuDrop, saveMergeHistory, undoLastMerge, pendingMerge
  // all provided by useMergeHistory hook — see the destructure above.

  // ── Close context menu on outside click ────────────────────────────────
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [ctxMenu]);

  useEffect(() => {
    if (!summaryCtx) return;
    const close = () => setSummaryCtx(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [summaryCtx]);

  const repositionSummaryCtx = useCallback(() => {
    if (!summaryCtx?.cellEl || !summaryCtxRef.current) return;
    const el   = summaryCtxRef.current;
    const cell = summaryCtx.cellEl.getBoundingClientRect();
    const theadBottom = tableRef.current?.querySelector("th")?.getBoundingClientRect().bottom ?? 0;
    if (cell.bottom <= theadBottom + 2 || cell.top >= window.innerHeight) { setSummaryCtx(null); return; }
    const ph   = el.offsetHeight;
    const pw   = el.offsetWidth;
    const vh   = window.innerHeight;
    const vw   = window.innerWidth;
    const pad  = 8;
    let top     = cell.bottom + 4;
    let flipped = false;
    if (top + ph > vh - pad) { top = Math.max(pad, cell.top - ph - 4); flipped = true; }
    let left = Math.max(pad, Math.min(vw - pw - pad, cell.left));
    el.style.top  = `${top}px`;
    el.style.left = `${left}px`;
    const arrowLeft = Math.max(10, Math.min(cell.left + cell.width / 2 - left - 9, pw - 28));
    const upEl   = el.querySelector("[data-arrow='up']")   as HTMLElement | null;
    const downEl = el.querySelector("[data-arrow='down']") as HTMLElement | null;
    if (upEl)   { upEl.style.display   = flipped ? "none" : "block"; upEl.style.left   = `${arrowLeft}px`; }
    if (downEl) { downEl.style.display = flipped ? "block" : "none"; downEl.style.left = `${arrowLeft}px`; }
  }, [summaryCtx]);

  useLayoutEffect(() => { repositionSummaryCtx(); }, [repositionSummaryCtx]);

  useEffect(() => {
    if (!summaryCtx) return;
    const scrollEls = [window, tableRef.current].filter(Boolean) as EventTarget[];
    scrollEls.forEach(el => el.addEventListener("scroll", repositionSummaryCtx, { passive: true }));
    return () => scrollEls.forEach(el => el.removeEventListener("scroll", repositionSummaryCtx));
  }, [summaryCtx, repositionSummaryCtx]);

  // ── Reposition popup + update arrow direction in DOM (no state re-render) ──
  const repositionCtxMenu = useCallback(() => {
    if (!ctxMenu?.cellEl || !ctxRef.current) return;
    const el   = ctxRef.current;
    const cell = ctxMenu.cellEl.getBoundingClientRect();
    // Auto-close if the anchor cell has scrolled under the sticky table header
    const theadBottom = tableRef.current?.querySelector("th")?.getBoundingClientRect().bottom ?? 0;
    if (cell.bottom <= theadBottom + 2 || cell.top >= window.innerHeight) { setCtxMenu(null); return; }
    const ph   = el.offsetHeight;
    const pw   = el.offsetWidth;
    const vh   = window.innerHeight;
    const vw   = window.innerWidth;
    const pad  = 8;

    let top     = cell.bottom + 2;
    let left    = cell.left;
    let flipped = false;

    if (top + ph > vh - pad) { top = Math.max(pad, cell.top - ph - 2); flipped = true; }
    if (left + pw > vw - pad) left = Math.max(pad, vw - pw - pad);

    el.style.top  = `${top}px`;
    el.style.left = `${left}px`;

    // Centre arrow on the anchor cell and toggle direction in DOM directly
    const arrowLeft = Math.max(10, Math.min(cell.left + cell.width / 2 - left - 9, pw - 28));
    const upEl   = el.querySelector("[data-arrow='up']")   as HTMLElement | null;
    const downEl = el.querySelector("[data-arrow='down']") as HTMLElement | null;
    if (upEl)   { upEl.style.display   = flipped ? "none" : "block"; upEl.style.left   = `${arrowLeft}px`; }
    if (downEl) { downEl.style.display = flipped ? "block" : "none"; downEl.style.left = `${arrowLeft}px`; }
  }, [ctxMenu]);

  useLayoutEffect(() => { repositionCtxMenu(); }, [repositionCtxMenu]);

  useEffect(() => {
    if (!ctxMenu) return;
    const scrollEls = [window, tableRef.current].filter(Boolean);
    scrollEls.forEach(el => el!.addEventListener("scroll", repositionCtxMenu, { passive: true }));
    return () => scrollEls.forEach(el => el!.removeEventListener("scroll", repositionCtxMenu));
  }, [ctxMenu, repositionCtxMenu]);

  // ── Close store dropdowns on outside click ─────────────────────────────
  useEffect(() => {
    if (!poDropOpen && !soDropOpen) return;
    const close = (e: MouseEvent) => {
      if (poDropOpen && poDropRef.current && !poDropRef.current.contains(e.target as Node)) setPoDropOpen(false);
      if (soDropOpen && soDropRef.current && !soDropRef.current.contains(e.target as Node)) setSoDropOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [poDropOpen, soDropOpen]);

  // ── Event index: sku → date → {pos, sos} for fast period lookup ────────
  const eventIndex = useMemo(() => {
    if (!excelData) return null;
    const idx: Record<string, Record<string, { pos: ATSPoEvent[]; sos: ATSSoEvent[] }>> = {};
    for (const p of excelData.pos) {
      if (!idx[p.sku]) idx[p.sku] = {};
      if (!idx[p.sku][p.date]) idx[p.sku][p.date] = { pos: [], sos: [] };
      idx[p.sku][p.date].pos.push(p);
    }
    for (const s of excelData.sos) {
      if (!idx[s.sku]) idx[s.sku] = {};
      if (!idx[s.sku][s.date]) idx[s.sku][s.date] = { pos: [], sos: [] };
      idx[s.sku][s.date].sos.push(s);
    }
    return idx;
  }, [excelData]);

  function toggleStore(current: string[], set: (v: string[]) => void, store: string) {
    if (store === "All") { set(["All"]); return; }
    const without = current.filter(s => s !== "All");
    const next = without.includes(store) ? without.filter(s => s !== store) : [...without, store];
    set(next.length === 0 ? ["All"] : next);
  }

  const poStoreActive  = (s: string) => poStores.includes("All") ? s === "All" : poStores.includes(s);
  const soStoreActive  = (s: string) => soStores.includes("All") ? s === "All" : soStores.includes(s);

  function getEventsInPeriod(sku: string, periodStart: string, endDate: string, rowStore?: string) {
    const skuIdx = eventIndex?.[sku];
    if (!skuIdx) return { pos: [] as ATSPoEvent[], sos: [] as ATSSoEvent[] };
    const pos: ATSPoEvent[] = [], sos: ATSSoEvent[] = [];
    for (const [date, ev] of Object.entries(skuIdx)) {
      if (date >= periodStart && date <= endDate) {
        pos.push(...ev.pos.filter(p => !rowStore || (p.store ?? "ROF") === rowStore));
        sos.push(...ev.sos.filter(s => !rowStore || (s.store ?? "ROF") === rowStore));
      }
    }
    return { pos, sos };
  }

  function getAllSkuEvents(sku: string, store?: string): { pos: ATSPoEvent[]; sos: ATSSoEvent[] } {
    if (!excelData) return { pos: [], sos: [] };
    return {
      pos: excelData.pos.filter(p => p.sku === sku && (!store || p.store === store)),
      sos: excelData.sos.filter(s => s.sku === sku && (!store || s.store === store)),
    };
  }

  function openSummaryCtx(e: React.MouseEvent, type: SummaryCtxMenu["type"], row: ATSRow) {
    e.preventDefault();
    const { pos, sos } = getAllSkuEvents(row.sku, row.store);
    const cellEl = e.currentTarget as HTMLElement;
    setSummaryCtx({ type, row, pos, sos, cellEl });
    setCtxMenu(null);
  }

  // ── Compute date range (all daily dates, used for ATS computation) ───────
  const dates = useMemo(() => {
    const start = new Date(startDate + "T00:00:00");
    let end: Date;
    if (rangeUnit === "days") {
      end = addDays(start, rangeValue);
    } else if (rangeUnit === "weeks") {
      end = addDays(start, rangeValue * 7 + 1); // +1 so Fri of last week is included
    } else {
      end = new Date(start);
      end.setMonth(end.getMonth() + rangeValue);
      end = addDays(end, 1); // include last day of last month
    }
    const result: string[] = [];
    let d = new Date(start);
    while (d < end) { result.push(fmtDate(d)); d = addDays(d, 1); }
    return result;
  }, [startDate, rangeUnit, rangeValue]);

  // ── Display periods: what columns to render in the table ─────────────────
  const displayPeriods = useMemo(() => {
    if (rangeUnit === "days") {
      return dates.map(d => ({ key: d, periodStart: d, endDate: d, label: fmtDateHeader(d), isToday: isToday(d), isWeekend: isWeekend(d) }));
    }
    if (rangeUnit === "weeks") {
      const start = new Date(startDate + "T00:00:00");
      return Array.from({ length: rangeValue }, (_, i) => {
        const wStart = addDays(start, i * 7);
        const wEnd   = addDays(wStart, 4);
        const s = wStart.toLocaleDateString("en-US", { month: "short", day: "numeric" });
        const e = wEnd.toLocaleDateString("en-US",   { month: "short", day: "numeric" });
        return { key: fmtDate(wEnd), periodStart: fmtDate(wStart), endDate: fmtDate(wEnd), label: `${s} – ${e}`, isToday: false, isWeekend: false };
      });
    }
    const start = new Date(startDate + "T00:00:00");
    return Array.from({ length: rangeValue }, (_, i) => {
      const m = new Date(start);
      m.setMonth(m.getMonth() + i);
      const firstDay = new Date(m.getFullYear(), m.getMonth(), 1);
      const lastDay  = new Date(m.getFullYear(), m.getMonth() + 1, 0);
      return {
        key:         fmtDate(lastDay),
        periodStart: fmtDate(firstDay),
        endDate:     fmtDate(lastDay),
        label:       m.toLocaleDateString("en-US", { month: "short", year: "numeric" }),
        isToday:     false,
        isWeekend:   false,
      };
    });
  }, [startDate, rangeUnit, rangeValue, dates]);

  // ── Recompute rows whenever date range, data, or store filters change ───
  // Load saved data from Supabase on mount
  useEffect(() => {
    loadFromSupabase();
  }, []);

  // Clear merge history in Supabase when the user leaves the ATS page (tab
  // close, browser close, or any navigation away). keepalive keeps the request
  // alive past the page unload. Module-level SB_URL/SB_HEADERS are stable refs.
  useEffect(() => {
    const clearOnExit = () => {
      fetch(`${SB_URL}/rest/v1/app_data`, {
        method: "POST",
        headers: { ...SB_HEADERS, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ key: "ats_merge_history", value: JSON.stringify([]) }),
        keepalive: true,
      }).catch(() => {});
    };
    window.addEventListener("pagehide", clearOnExit);
    return () => window.removeEventListener("pagehide", clearOnExit);
  }, []);

  useEffect(() => {
    if (excelData) {
      let computed = computeRowsFromExcelData(excelData, dates, poStores, soStores);
      for (const op of mergeHistory) computed = mergeRows(computed, op.fromSku, op.toSku);
      setRows(computed);
    }
  }, [excelData, dates, poStores, soStores, mergeHistory]);

  // PO data comes from PO WIP (tanda_pos) — no separate Xoro sync needed
  const syncProgress = null;

  // mergeRows (row-level) imported from ./ats/merge.ts.

  // saveMergeHistory now lives in useMergeHistory hook.

  async function loadFromSupabase() {
    setLoading(true);
    try {
      // Load persisted merge history
      let savedHistory: Array<{ fromSku: string; toSku: string }> = [];
      try {
        const histRes = await fetch(`${SB_URL}/rest/v1/app_data?key=eq.ats_merge_history&select=value`, { headers: SB_HEADERS });
        const histRows = await histRes.json();
        if (Array.isArray(histRows) && histRows[0]?.value) {
          savedHistory = JSON.parse(histRows[0].value);
          setMergeHistory(savedHistory);
        }
      } catch {}

      // Check for Excel data stored in app_data first
      const excelRes = await fetch(
        `${SB_URL}/rest/v1/app_data?key=eq.ats_excel_data&select=value`,
        { headers: SB_HEADERS }
      );
      if (!excelRes.ok) throw new Error(`Failed to load Excel data: ${excelRes.status}`);
      const excelRows = await excelRes.json();
      if (Array.isArray(excelRows) && excelRows[0]?.value) {
        // Clean stored blob on load (legacy uploads may have duplicates baked in).
        const data: ExcelData = dedupeExcelData(JSON.parse(excelRows[0].value));
        // Auto-refresh PO data from PO WIP on every load
        let freshData = data;
        try {
          const base = { ...data, pos: [], skus: data.skus.map((s: any) => ({ ...s, onPO: 0 })) };
          freshData = dedupeExcelData(await applyPOWIPData(base));
        } catch (e) {
          console.warn("Auto PO refresh failed, using cached data:", e);
        }
        // Ensure we have a clean base snapshot (pre-merge) for undo functionality
        try {
          const baseCheck = await fetch(`${SB_URL}/rest/v1/app_data?key=eq.ats_base_data&select=value`, { headers: SB_HEADERS });
          const baseCheckRows = await baseCheck.json();
          if (!Array.isArray(baseCheckRows) || !baseCheckRows[0]?.value) {
            // No base saved yet — save freshData (pre-merge) as the base
            saveBaseData(freshData);
          }
        } catch {}
        // Bake any pending merges into excelData (covers merges done before the fix
        // that updated rows only, without touching excelData)
        let mergedData = freshData;
        for (const op of savedHistory) {
          mergedData = mergeExcelDataSkus(mergedData, op.fromSku, op.toSku);
        }
        if (mergedData !== freshData) {
          // Persist the now-baked state so we don't need to re-apply on next load
          saveNormResult(mergedData);
        }
        setExcelData(mergedData);
        // rows will be recomputed by the excelData useEffect (which also re-applies mergeHistory)
        setLastSync(mergedData.syncedAt);
        setMockMode(false);
        return;
      }
      // Fall back to ats_snapshots (Xoro sync data)
      const dateFilter = `date=gte.${startDate}&date=lte.${dates[dates.length - 1]}`;
      const res = await fetch(
        `${SB_URL}/rest/v1/ats_snapshots?select=*&${dateFilter}&order=sku,date`,
        { headers: SB_HEADERS }
      );
      if (!res.ok) throw new Error(`Failed to load snapshots: ${res.status}`);
      const data: ATSSnapshot[] = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        const map: Record<string, ATSRow> = {};
        data.forEach(snap => {
          if (!map[snap.sku]) {
            map[snap.sku] = { sku: snap.sku, description: snap.description, category: snap.category, dates: {}, onHand: snap.qty_on_hand, onPO: snap.qty_on_order, onOrder: 0 };
          }
          map[snap.sku].dates[snap.date] = snap.qty_available;
        });
        let computed = Object.values(map);
        for (const op of savedHistory) computed = mergeRows(computed, op.fromSku, op.toSku);
        setRows(computed);
        setMockMode(false);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  // applyPOWIPData + refreshPOsFromWIP now live in usePOWIPSync hook.
  // handleFileUpload + saveUploadData + cancelUpload now live in useExcelUpload hook.
  const {
    handleFileUpload, saveUploadData, cancelUpload, cancelRef, abortRef,
  } = useExcelUpload({
    applyPOWIPData,
    saveMergeHistory,
    saveBaseData: (d: ExcelData) => saveBaseData(d),
    mergeHistory,
    loadNormDecisions,
    dates,
    setUploadingFile, setShowUpload, setUploadProgress, setUploadError,
    setUploadSuccess, setUploadWarnings, setPendingUploadData,
    setExcelData, setRows, setLastSync, setMockMode, setMergeHistory,
    setInvFile, setPurFile, setOrdFile,
    setNormChanges, setNormPendingData, setNormSource,
  });

  async function saveNormResult(result: ExcelData) {
    try {
      const res = await fetch(`${SB_URL}/rest/v1/app_data`, {
        method: "POST",
        headers: { ...SB_HEADERS, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ key: "ats_excel_data", value: JSON.stringify(result) }),
      });
      if (!res.ok) console.warn("Normalized data save failed:", res.status);
    } catch (e) { console.error("Failed to save normalized data:", e); }
  }

  async function saveBaseData(data: ExcelData) {
    try {
      await fetch(`${SB_URL}/rest/v1/app_data`, {
        method: "POST",
        headers: { ...SB_HEADERS, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ key: "ats_base_data", value: JSON.stringify(data) }),
      });
    } catch (e) { console.error("Failed to save base data:", e); }
  }

  async function loadNormDecisions(): Promise<NormDecisions> {
    try {
      const res = await fetch(`${SB_URL}/rest/v1/app_data?key=eq.ats_norm_decisions&select=value`, { headers: SB_HEADERS });
      if (!res.ok) {
        console.warn("[norm] load decisions failed:", res.status);
        return {};
      }
      const rows = await res.json();
      if (Array.isArray(rows) && rows[0]?.value) {
        const parsed = JSON.parse(rows[0].value);
        console.info(`[norm] loaded ${Object.keys(parsed).length} decisions`);
        return parsed;
      }
      console.info("[norm] no saved decisions yet");
      return {};
    } catch (e) {
      console.warn("[norm] load decisions threw:", e);
      return {};
    }
  }

  async function saveNormDecisions(next: NormDecisions) {
    try {
      const res = await fetch(`${SB_URL}/rest/v1/app_data`, {
        method: "POST",
        headers: { ...SB_HEADERS, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ key: "ats_norm_decisions", value: JSON.stringify(next) }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error(`[norm] save failed: ${res.status} ${body}`);
        setUploadError(`Normalization decisions couldn't be saved (${res.status}). You may be re-prompted on next upload.`);
      } else {
        console.info(`[norm] saved ${Object.keys(next).length} decisions`);
      }
    } catch (e) {
      console.error("[norm] save threw:", e);
      setUploadError("Normalization decisions couldn't be saved (network). You may be re-prompted on next upload.");
    }
  }

  // undoLastMerge now lives in useMergeHistory hook.


  const clearMergeAndNavigate = useCallback(async () => {
    setMergeHistory([]);
    await saveMergeHistory([]);
    window.location.href = "/";
  }, [saveMergeHistory]);

  const onNegInven = useCallback(() => {
    setActiveSort("negATS");
    exportNegInven(rows, displayPeriods, atShip);
  }, [rows, displayPeriods, atShip]);

  const onAgedInven = useCallback((days: number, category: string): "ok" | "empty" => {
    return exportAgedInven(rows, days, category);
  }, [rows]);

  async function applyNormReview() {
    if (!normPendingData || !normChanges) return;
    // Persist the user's accept/reject decisions so future uploads can
    // auto-apply the accepts and skip the rejects without re-prompting.
    // Await — if we fire-and-forget and the user re-uploads quickly, the
    // POST can race past and lose the decisions.
    try {
      const existing = await loadNormDecisions();
      await saveNormDecisions(mergeNormDecisions(existing, normChanges));
    } catch (e) { console.error("[norm] persist decisions failed:", e); }
    // Dedupe after normalization — two raw SKUs that normalize to the same
    // value (e.g., "Md Wash" and "Med Wash" → "Med Wash") produce duplicate
    // entries in skus[]. Without this, the saved data stays duplicated until
    // next reload when dedupeExcelData runs.
    const baseResult = dedupeExcelData(applyNormChanges(normPendingData, normChanges));
    // On upload, the pending data is pre-merge — replay the saved merges over
    // the normalized result so row-level merges survive re-uploading. On
    // "load" (background normalization pass on already-saved data), merges
    // are already applied; replaying would double-apply them.
    let result = baseResult;
    if (normSource === "upload") {
      for (const op of mergeHistory) result = mergeExcelDataSkus(result, op.fromSku, op.toSku);
    }
    setExcelData(result);
    setRows(computeRowsFromExcelData(result, dates));
    setLastSync(result.syncedAt);
    setMockMode(false);
    // Save clean (pre-merge) base so undo can rebuild from scratch — on
    // "load" we don't overwrite the base (it's already the true pre-merge snapshot).
    if (normSource === "upload") saveBaseData(baseResult);
    saveNormResult(result);
    if (normSource === "upload") {
      setInvFile(null); setPurFile(null); setOrdFile(null);
    }
    const accepted = normChanges.filter(c => c.accepted).length;
    setUploadSuccess(accepted > 0 ? `${accepted} SKU${accepted !== 1 ? "s" : ""} normalized` : `${result.skus.length.toLocaleString()} SKUs uploaded`);
    setTimeout(() => setUploadSuccess(null), 6000);
    setNormChanges(null);
    setNormPendingData(null);
  }

  async function dismissNormReview() {
    if (!normPendingData) return;
    // Persist rejections so we stop asking about these SKUs. If the modal
    // was opened with some pre-accepted changes, those count as rejects too
    // — the user explicitly chose to skip.
    if (normChanges && normChanges.length > 0) {
      const rejected = normChanges.map(c => ({ ...c, accepted: false }));
      try {
        const existing = await loadNormDecisions();
        await saveNormDecisions(mergeNormDecisions(existing, rejected));
      } catch (e) { console.error("[norm] persist rejects failed:", e); }
    }
    // Keep original SKUs — replay saved merges so row-level merges survive.
    let result = normPendingData;
    if (normSource === "upload") {
      for (const op of mergeHistory) result = mergeExcelDataSkus(result, op.fromSku, op.toSku);
    }
    setExcelData(result);
    setRows(computeRowsFromExcelData(result, dates));
    setLastSync(result.syncedAt);
    setMockMode(false);
    if (normSource === "upload") saveBaseData(normPendingData);
    saveNormResult(result);
    if (normSource === "upload") {
      setInvFile(null); setPurFile(null); setOrdFile(null);
      setUploadSuccess(`${normPendingData.skus.length.toLocaleString()} SKUs uploaded — normalization skipped`);
      setTimeout(() => setUploadSuccess(null), 6000);
    }
    setNormChanges(null);
    setNormPendingData(null);
  }

  // cancelUpload now lives in useExcelUpload hook.

  // ── Filtering ──────────────────────────────────────────────────────────
  const categories = ["All", ...Array.from(new Set(
    rows.filter(r => r.onHand > 0 || r.onPO > 0 || r.onOrder > 0)
        .map(r => r.category).filter(Boolean) as string[]
  )).sort()];

  // Build SKU sets keyed by store for fast row filtering
  const poSkusByStore = useMemo(() => {
    if (!excelData) return {} as Record<string, Set<string>>;
    const map: Record<string, Set<string>> = {};
    for (const p of excelData.pos) {
      const st = p.store ?? "ROF";
      if (!map[st]) map[st] = new Set();
      map[st].add(p.sku);
    }
    return map;
  }, [excelData]);

  const soSkusByStore = useMemo(() => {
    if (!excelData) return {} as Record<string, Set<string>>;
    const map: Record<string, Set<string>> = {};
    for (const s of excelData.sos) {
      const st = s.store ?? "ROF";
      if (!map[st]) map[st] = new Set();
      map[st].add(s.sku);
    }
    return map;
  }, [excelData]);

  const poFilterSkus = useMemo(() => {
    if (poStores.includes("All")) return null;
    return new Set(poStores.flatMap(st => [...(poSkusByStore[st] ?? new Set<string>())]));
  }, [poStores, poSkusByStore]);

  const soFilterSkus = useMemo(() => {
    if (soStores.includes("All")) return null;
    return new Set(soStores.flatMap(st => [...(soSkusByStore[st] ?? new Set<string>())]));
  }, [soStores, soSkusByStore]);

  // Build customer SKU set for filtering
  // Filtered/sorted/paginated row chain lives in useRowFiltering.
  const {
    customerSkuSet, filtered, statFiltered, sortedFiltered, pageRows, totalPages, filteredSkuSet,
  } = useRowFiltering({
    rows, excelData, search, filterCategory, filterGender, filterStatus, minATS, storeFilter,
    customerFilter, activeSort, sortCol, sortDir, displayPeriods, today,
    pageSize: PAGE_SIZE, page,
  });

  // ── Summary stats (all based on filtered rows) ─────────────────────────
  const todayKey     = fmtDate(today);
  const totalSKUs    = filtered.length;
  const zeroStock    = filtered.filter(r => (r.dates[todayKey] ?? r.onHand) <= 0).length;
  const lowStock     = filtered.filter(r => { const q = r.dates[todayKey] ?? r.onHand; return q > 0 && q <= 10; }).length;
  const negATSCount  = filtered.filter(r => displayPeriods.some(p => { const q = r.dates[p.endDate]; return q != null && q < 0; })).length;
  const totalSoQty   = filtered.reduce((s, r) => s + r.onOrder, 0);
  const totalPoQty   = filtered.reduce((s, r) => s + r.onPO, 0);

  const { totalSoValue, totalPoValue } = useMemo(() => {
    if (!excelData) return { totalSoValue: 0, totalPoValue: 0 };
    const isAll = storeFilter.includes("All");
    const soV = excelData.sos.filter(s => (isAll || storeFilter.includes(s.store ?? "ROF")) && filteredSkuSet.has(s.sku)).reduce((a, s) => a + (s.totalPrice || s.unitPrice * s.qty || 0), 0);
    // Build avgCost lookup from inventory skus as fallback when PO has no unitCost
    const avgCostBySku: Record<string, number> = {};
    for (const s of excelData.skus) { if (s.avgCost) avgCostBySku[s.sku] = s.avgCost; }
    const poV = excelData.pos.filter(p => (isAll || storeFilter.includes(p.store ?? "ROF")) && filteredSkuSet.has(p.sku)).reduce((a, p) => a + p.qty * (p.unitCost || avgCostBySku[p.sku] || 0), 0);
    return { totalSoValue: soV, totalPoValue: poV };
  }, [excelData, filteredSkuSet, storeFilter]);

  const { marginDollars, marginPct } = useMemo(() => {
    if (!excelData || totalSoValue === 0) return { marginDollars: 0, marginPct: 0 };
    const isAll = storeFilter.includes("All");
    // Build avg cost per SKU — prefer inventory snapshot avgCost, fall back to PO-derived
    const snapshotCost: Record<string, number> = {};
    for (const s of excelData.skus) {
      if (s.avgCost && s.avgCost > 0) snapshotCost[s.sku] = s.avgCost;
    }
    // PO-derived weighted avg as fallback
    const poCostBySku: Record<string, number> = {};
    const poQtyBySku:  Record<string, number> = {};
    for (const p of excelData.pos) {
      if (p.unitCost <= 0) continue;
      poCostBySku[p.sku] = (poCostBySku[p.sku] ?? 0) + p.qty * p.unitCost;
      poQtyBySku[p.sku]  = (poQtyBySku[p.sku]  ?? 0) + p.qty;
    }
    const avgCostBySku: Record<string, number> = {};
    for (const sku of new Set([...Object.keys(snapshotCost), ...Object.keys(poCostBySku)])) {
      avgCostBySku[sku] = snapshotCost[sku] ?? (poQtyBySku[sku] > 0 ? poCostBySku[sku] / poQtyBySku[sku] : 0);
    }
    // Sum cost of each SO line using that SKU's avg cost — same filter as totalSoValue
    let totalCost = 0;
    for (const s of excelData.sos) {
      if (!filteredSkuSet.has(s.sku)) continue;
      if (!isAll && !storeFilter.includes(s.store ?? "ROF")) continue;
      totalCost += (avgCostBySku[s.sku] ?? 0) * s.qty;
    }
    const margin = totalSoValue - totalCost;
    return { marginDollars: margin, marginPct: margin / totalSoValue };
  }, [excelData, filteredSkuSet, totalSoValue, storeFilter]);

  // Sort by column header click — the actual sort happens inside useRowFiltering.
  function handleThClick(col: string) {
    if (sortCol === col) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortCol(col); setSortDir("asc"); }
  }

  // Reset to page 0 whenever filters/search/sort change
  useEffect(() => { setPage(0); }, [search, filterCategory, filterGender, filterStatus, minATS, poStores, soStores, rows, activeSort, sortCol, sortDir, customerFilter]);

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER — see ats/renderPanel.tsx
  return atsRenderPanel({
    startDate, setStartDate, rangeUnit, setRangeUnit, rangeValue, setRangeValue,
    search, setSearch, filterCategory, setFilterCategory, filterGender, setFilterGender, filterStatus, setFilterStatus,
    minATS, setMinATS, storeFilter, setStoreFilter, poDropOpen, setPoDropOpen,
    soDropOpen, setSoDropOpen, rows, setRows, loading, mockMode, page, setPage,
    excelData, setExcelData, uploadingFile, uploadProgress, uploadSuccess, setUploadSuccess,
    uploadError, setUploadError, uploadWarnings, setUploadWarnings, pendingUploadData,
    setPendingUploadData, showUpload, setShowUpload, invFile, setInvFile, purFile, setPurFile,
    ordFile, setOrdFile, syncing, syncStatus, lastSync, syncError, setSyncError,
    hoveredCell, setHoveredCell, pinnedSku, setPinnedSku, ctxMenu, setCtxMenu,
    summaryCtx, setSummaryCtx, activeSort, setActiveSort, sortCol, sortDir,
    STORES, PAGE_SIZE, poStores, soStores, poDropRef, soDropRef, invRef, purRef, ordRef,
    ctxRef, summaryCtxRef, tableRef, dates, displayPeriods, eventIndex, filtered,
    statFiltered, sortedFiltered, pageRows, totalPages, categories, filteredSkuSet, totalSoValue, totalPoValue, marginDollars, marginPct,
    handleFileUpload, refreshPOsFromWIP, handleThClick, loadFromSupabase, saveUploadData, toggleStore, exportToExcel,
    repositionCtxMenu, repositionSummaryCtx, cancelRef, abortRef,
    cancelUpload, openSummaryCtx, getEventsInPeriod, lowStock, negATSCount, zeroStock, totalSKUs, totalPoQty, totalSoQty, todayKey, syncProgress,
    normChanges, setNormChanges, normPendingData, setNormPendingData, normSource, setNormSource,
    applyNormReview, dismissNormReview,
    customerFilter, setCustomerFilter, customerDropOpen, setCustomerDropOpen, customerSearch, setCustomerSearch,
    dragSku, setDragSku, dragOverSku, setDragOverSku,
    pendingMerge, setPendingMerge, isAdmin, commitMerge, handleSkuDrop,
    mergeHistory, setMergeHistory, saveMergeHistory, undoLastMerge, clearMergeAndNavigate,
    atShip, setAtShip, onNegInven, onAgedInven,
  });
}
