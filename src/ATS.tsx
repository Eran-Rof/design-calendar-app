import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from "react";
import XLSXStyle from "xlsx-js-style";
import { SB_URL, SB_KEY, SB_HEADERS } from "./utils/supabase";
import type { ATSRow, ATSSnapshot, ATSSkuData, ATSPoEvent, ATSSoEvent, UploadWarning, ExcelData, CtxMenu, SummaryCtxMenu } from "./ats/types";
import { addDays, fmtDate, fmtDateShort, fmtDateDisplay, fmtDateHeader, isToday, isWeekend, getQtyColor, getQtyBg, xoroSkuToExcel } from "./ats/helpers";
import { computeRowsFromExcelData } from "./ats/compute";
import { exportToExcel } from "./ats/exportExcel";
import { normalizeExcelData, detectNormChanges, applyNormChanges, type NormChange } from "./ats/normalize";
import S from "./ats/styles";
import { StatCard } from "./ats/StatCard";
import { ATSProvider, useATSState, useATSDispatch } from "./ats/state/ATSContext";
import type { ATSState } from "./ats/state/atsTypes";
import { atsRenderPanel } from "./ats/renderPanel";

// ── Main Component ────────────────────────────────────────────────────────────
export default function ATSReportWrapper() {
  return <ATSProvider><ATSReport /></ATSProvider>;
}

function ATSReport() {
  const st = useATSState();
  const stD = useATSDispatch();
  const stSet = <K extends keyof ATSState>(field: K, value: ATSState[K]) => stD({ type: "SET", field, value });
  const today = new Date();
  // ── State → useATSState() + useATSDispatch() (see ats/state/) ──
  const startDate = st.startDate;
  const rangeUnit = st.rangeUnit;
  const rangeValue = st.rangeValue;
  const search = st.search;
  const filterCategory = st.filterCategory;
  const filterStatus = st.filterStatus;
  const minATS = st.minATS;
  const storeFilter = st.storeFilter;
  const poDropOpen = st.poDropOpen;
  const soDropOpen = st.soDropOpen;
  const rows = st.rows;
  const loading = st.loading;
  const mockMode = st.mockMode;
  const page = st.page;
  const excelData = st.excelData;
  const uploadingFile = st.uploadingFile;
  const uploadProgress = st.uploadProgress;
  const uploadSuccess = st.uploadSuccess;
  const uploadError = st.uploadError;
  const uploadWarnings = st.uploadWarnings;
  const pendingUploadData = st.pendingUploadData;
  const showUpload = st.showUpload;
  const invFile = st.invFile;
  const purFile = st.purFile;
  const ordFile = st.ordFile;
  const syncing = st.syncing;
  const syncStatus = st.syncStatus;
  const lastSync = st.lastSync;
  const syncError = st.syncError;
  const hoveredCell = st.hoveredCell;
  const pinnedSku = st.pinnedSku;
  const ctxMenu = st.ctxMenu;
  const summaryCtx = st.summaryCtx;
  const activeSort = st.activeSort;
  const sortCol = st.sortCol;
  const sortDir = st.sortDir;
  const setStartDate = (v: string) => stSet("startDate", v);
  const setRangeUnit = (v: "days" | "weeks" | "months") => stSet("rangeUnit", v);
  const setRangeValue = (v: number) => stSet("rangeValue", v);
  const setSearch = (v: string) => stSet("search", v);
  const setFilterCategory = (v: string) => stSet("filterCategory", v);
  const setFilterStatus = (v: string) => stSet("filterStatus", v);
  const setMinATS = (v: number | "") => stSet("minATS", v);
  const setStoreFilter = (v: string[]) => stSet("storeFilter", v);
  const setPoDropOpen = (v: boolean) => stSet("poDropOpen", v);
  const setSoDropOpen = (v: boolean) => stSet("soDropOpen", v);
  const setRows = (v: any) => stSet("rows", v);
  const setLoading = (v: boolean) => stSet("loading", v);
  const setMockMode = (v: boolean) => stSet("mockMode", v);
  const setPage = (v: number) => stSet("page", v);
  const setExcelData = (v: any) => stSet("excelData", v);
  const setUploadingFile = (v: boolean) => stSet("uploadingFile", v);
  const setUploadProgress = (v: any) => stSet("uploadProgress", v);
  const setUploadSuccess = (v: any) => stSet("uploadSuccess", v);
  const setUploadError = (v: any) => stSet("uploadError", v);
  const setUploadWarnings = (v: any) => stSet("uploadWarnings", v);
  const setPendingUploadData = (v: any) => stSet("pendingUploadData", v);
  const setShowUpload = (v: boolean) => stSet("showUpload", v);
  const setInvFile = (v: any) => stSet("invFile", v);
  const setPurFile = (v: any) => stSet("purFile", v);
  const setOrdFile = (v: any) => stSet("ordFile", v);
  const setSyncing = (v: boolean) => stSet("syncing", v);
  const setSyncStatus = (v: string) => stSet("syncStatus", v);
  const setLastSync = (v: string) => stSet("lastSync", v);
  const setSyncError = (v: any) => stSet("syncError", v);
  const setHoveredCell = (v: any) => stSet("hoveredCell", v);
  const setPinnedSku = (v: any) => stSet("pinnedSku", v);
  const setCtxMenu = (v: any) => stSet("ctxMenu", v);
  const setSummaryCtx = (v: any) => stSet("summaryCtx", v);
  const setActiveSort = (v: any) => stSet("activeSort", v);
  const setSortCol = (v: any) => stSet("sortCol", v);
  const setSortDir = (v: "asc" | "desc") => stSet("sortDir", v);
  const normChanges = st.normChanges;
  const normPendingData = st.normPendingData;
  const normSource = st.normSource;
  const setNormChanges = (v: NormChange[] | null) => stSet("normChanges", v);
  const setNormPendingData = (v: ExcelData | null) => stSet("normPendingData", v);
  const setNormSource = (v: "upload" | "load") => stSet("normSource", v);
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
  const cancelRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);

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
    if (cell.top < theadBottom || cell.top >= window.innerHeight) { setSummaryCtx(null); return; }
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
    const scrollEls = [window, tableRef.current].filter(Boolean);
    scrollEls.forEach(el => el!.addEventListener("scroll", repositionSummaryCtx, { passive: true }));
    return () => scrollEls.forEach(el => el!.removeEventListener("scroll", repositionSummaryCtx));
  }, [summaryCtx, repositionSummaryCtx]);

  // ── Reposition popup + update arrow direction in DOM (no state re-render) ──
  const repositionCtxMenu = useCallback(() => {
    if (!ctxMenu?.cellEl || !ctxRef.current) return;
    const el   = ctxRef.current;
    const cell = ctxMenu.cellEl.getBoundingClientRect();
    // Auto-close if the anchor cell has scrolled under the sticky table header
    const theadBottom = tableRef.current?.querySelector("th")?.getBoundingClientRect().bottom ?? 0;
    if (cell.top < theadBottom || cell.top >= window.innerHeight) { setCtxMenu(null); return; }
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

  useEffect(() => {
    if (mockMode) {
      setRows(generateMockData(dates));
    } else if (excelData) {
      setRows(computeRowsFromExcelData(excelData, dates, poStores, soStores));
    }
  }, [mockMode, excelData, dates, poStores, soStores]);

  // PO data comes from PO WIP (tanda_pos) — no separate Xoro sync needed
  const syncProgress = null;

  async function loadFromSupabase() {
    setLoading(true);
    try {
      // Check for Excel data stored in app_data first
      const excelRes = await fetch(
        `${SB_URL}/rest/v1/app_data?key=eq.ats_excel_data&select=value`,
        { headers: SB_HEADERS }
      );
      const excelRows = await excelRes.json();
      if (Array.isArray(excelRows) && excelRows[0]?.value) {
        const raw: ExcelData = JSON.parse(excelRows[0].value);
        const changes = detectNormChanges(raw);
        if (changes.length > 0) {
          setNormPendingData(raw);
          setNormChanges(changes);
          setNormSource("load");
          // Still load with full normalization so the table is usable immediately
          const data = normalizeExcelData(raw);
          setExcelData(data);
          setRows(computeRowsFromExcelData(data, dates));
          setLastSync(data.syncedAt);
          setMockMode(false);
          return;
        }
        setExcelData(raw);
        setRows(computeRowsFromExcelData(raw, dates));
        setLastSync(raw.syncedAt);
        setMockMode(false);
        return;
      }
      // Fall back to ats_snapshots (Xoro sync data)
      const dateFilter = `date=gte.${startDate}&date=lte.${dates[dates.length - 1]}`;
      const res = await fetch(
        `${SB_URL}/rest/v1/ats_snapshots?select=*&${dateFilter}&order=sku,date`,
        { headers: SB_HEADERS }
      );
      const data: ATSSnapshot[] = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        const map: Record<string, ATSRow> = {};
        data.forEach(snap => {
          if (!map[snap.sku]) {
            map[snap.sku] = { sku: snap.sku, description: snap.description, category: snap.category, dates: {}, onHand: snap.qty_on_hand, onOrder: snap.qty_on_order, onCommitted: 0 };
          }
          map[snap.sku].dates[snap.date] = snap.qty_available;
        });
        setRows(Object.values(map));
        setMockMode(false);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  async function handleFileUpload(inv: File, pur: File | null, ord: File) {
    setUploadingFile(true);
    setShowUpload(false);
    cancelRef.current = false;
    abortRef.current = new AbortController();
    try {
      setUploadProgress({ step: "Parsing files…", pct: 15 });
      const formData = new FormData();
      formData.append("inventory", inv);
      if (pur) formData.append("purchases", pur);
      formData.append("orders",    ord);
      const res = await fetch("/api/parse-excel", {
        method: "POST",
        body: formData,
        signal: abortRef.current.signal,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Parse failed" }));
        throw new Error(err.error ?? "Parse failed");
      }
      if (cancelRef.current) return;
      setUploadProgress({ step: "Processing data…", pct: 50 });
      const data: ExcelData = await res.json();
      if (cancelRef.current) return;

      // If no purchases file was uploaded, pull PO data from PO WIP (tanda_pos in Supabase)
      // Always pull PO data from PO WIP (tanda_pos) — single source of truth
      {
        setUploadProgress({ step: "Fetching PO data from PO WIP…", pct: 60 });
        try {
          const poRes = await fetch(`${SB_URL}/rest/v1/tanda_pos?select=data`, { headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` } });
          if (poRes.ok) {
            const poRows = await poRes.json();
            for (const row of poRows) {
              const po = row.data;
              if (!po) continue;
              const poNum = po.PoNumber ?? "";
              const vendor = po.VendorName ?? "";
              const expDate = po.DateExpectedDelivery ?? "";
              const brandName = po.BrandName ?? "";
              const items = po.Items ?? po.PoLineArr ?? [];
              for (const item of items) {
                const rawItemSku = item.ItemNumber ?? "";
                if (!rawItemSku) continue;
                const sku = xoroSkuToExcel(rawItemSku);
                // Use QtyRemaining for partially received, fall back to QtyOrder
                const qty = item.QtyRemaining != null ? item.QtyRemaining : (item.QtyOrder ?? 0) - (item.QtyReceived ?? 0);
                const unitCost = item.UnitPrice ?? 0;
                if (qty <= 0) continue;
                // Parse expected date
                let date = "";
                if (expDate) {
                  const d = new Date(expDate);
                  if (!isNaN(d.getTime())) date = d.toISOString().split("T")[0];
                }
                // Detect store from PO number and brand
                const pn = (poNum).toUpperCase();
                const bn = (brandName).toUpperCase();
                const store = pn.includes("ECOM") ? "ROF ECOM" : (bn.includes("PSYCHO") || bn.includes("PTUNA") || bn.includes("P TUNA") || bn === "PT" || bn.startsWith("PT ")) ? "PT" : "ROF";
                // Add to SKU map if not already there
                if (!data.skus.find(s => s.sku === sku)) {
                  data.skus.push({ sku, description: item.Description ?? "", category: brandName || undefined, store, onHand: 0, onOrder: qty, onCommitted: 0 });
                } else {
                  const existing = data.skus.find(s => s.sku === sku)!;
                  existing.onOrder = (existing.onOrder || 0) + qty;
                }
                if (date) {
                  data.pos.push({ sku, date, qty, poNumber: poNum, vendor, store, unitCost });
                }
              }
            }
          }
        } catch (e) { console.warn("Failed to fetch PO WIP data:", e); }
      }

      setUploadProgress({ step: "Checking data…", pct: 70 });

      // If the API found any data quality issues, pause and ask user before saving
      if (data.warnings && data.warnings.length > 0) {
        setUploadProgress(null);
        setUploadingFile(false);
        setPendingUploadData(data);
        setUploadWarnings(data.warnings);
        return; // wait for user confirmation
      }

      await saveUploadData(data);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      console.error(e);
      setUploadError((e as Error).message);
    } finally {
      setUploadingFile(false);
      setUploadProgress(null);
      cancelRef.current = false;
      abortRef.current = null;
    }
  }

  async function saveUploadData(data: ExcelData) {
    setUploadingFile(true);
    setUploadWarnings(null);
    setPendingUploadData(null);
    try {
      setUploadProgress({ step: `Saving ${data.skus.length.toLocaleString()} SKUs…`, pct: 80 });
      const saveRes = await fetch(`${SB_URL}/rest/v1/app_data`, {
        method: "POST",
        headers: { ...SB_HEADERS, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ key: "ats_excel_data", value: JSON.stringify(data) }),
      });
      if (!saveRes.ok) throw new Error("Failed to save data to database");
      setUploadProgress({ step: "Checking SKU normalization…", pct: 93 });
      const changes = detectNormChanges(data);
      console.log(`[SKU Normalization] ${changes.length} changes detected out of ${data.skus.length} SKUs`, changes);
      if (changes.length > 0) {
        setNormPendingData(data);
        setNormChanges(changes);
        setNormSource("upload");
        setUploadProgress(null);
        setUploadingFile(false);
        return;
      }
      setUploadProgress({ step: "Computing ATS…", pct: 95 });
      setExcelData(data);
      setRows(computeRowsFromExcelData(data, dates));
      setLastSync(data.syncedAt);
      setMockMode(false);
      setInvFile(null); setPurFile(null); setOrdFile(null);
      setUploadProgress(null);
      setUploadSuccess(`${data.skus.length.toLocaleString()} SKUs uploaded successfully`);
      setTimeout(() => setUploadSuccess(null), 6000);
    } catch (e) {
      console.error(e);
      setUploadError((e as Error).message);
    } finally {
      setUploadingFile(false);
      setUploadProgress(null);
    }
  }

  function applyNormReview() {
    if (!normPendingData || !normChanges) return;
    const result = applyNormChanges(normPendingData, normChanges);
    setExcelData(result);
    setRows(computeRowsFromExcelData(result, dates));
    setLastSync(result.syncedAt);
    setMockMode(false);
    if (normSource === "upload") {
      setInvFile(null); setPurFile(null); setOrdFile(null);
      setUploadSuccess(`${result.skus.length.toLocaleString()} SKUs uploaded successfully`);
      setTimeout(() => setUploadSuccess(null), 6000);
    }
    setNormChanges(null);
    setNormPendingData(null);
  }

  function dismissNormReview() {
    if (!normPendingData) return;
    // Apply with no changes accepted
    const noChanges = (normChanges || []).map(c => ({ ...c, accepted: false }));
    const result = applyNormChanges(normPendingData, noChanges);
    setExcelData(result);
    setRows(computeRowsFromExcelData(result, dates));
    setLastSync(result.syncedAt);
    setMockMode(false);
    if (normSource === "upload") {
      setInvFile(null); setPurFile(null); setOrdFile(null);
      setUploadSuccess(`${result.skus.length.toLocaleString()} SKUs uploaded successfully`);
      setTimeout(() => setUploadSuccess(null), 6000);
    }
    setNormChanges(null);
    setNormPendingData(null);
  }

  function cancelUpload() {
    cancelRef.current = true;
    abortRef.current?.abort();
    setUploadingFile(false);
    setUploadProgress(null);
  }

  // ── Filtering ──────────────────────────────────────────────────────────
  const categories = ["All", ...Array.from(new Set(rows.map(r => r.category ?? "Uncategorized"))).sort()];

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

  const filtered = rows.filter(r => {
    const s = search.toLowerCase();
    const matchSearch = !s || r.sku.toLowerCase().includes(s) || r.description.toLowerCase().includes(s);
    const matchCat = filterCategory === "All" || r.category === filterCategory;
    const todayQty = r.dates[fmtDate(today)] ?? r.onHand;
    const matchStatus =
      filterStatus === "All" ? true :
      filterStatus === "Out" ? todayQty <= 0 :
      filterStatus === "Low" ? todayQty > 0 && todayQty <= 10 :
      todayQty > 10;
    const matchMin    = minATS === "" || todayQty >= minATS;
    // Store filter
    const matchStore = storeFilter.includes("All") || storeFilter.includes(r.store ?? "ROF");
    return matchSearch && matchCat && matchStatus && matchMin && matchStore;
  });

  // ── Summary stats (all based on filtered rows) ─────────────────────────
  const todayKey     = fmtDate(today);
  const totalSKUs    = filtered.length;
  const zeroStock    = filtered.filter(r => (r.dates[todayKey] ?? r.onHand) <= 0).length;
  const lowStock     = filtered.filter(r => { const q = r.dates[todayKey] ?? r.onHand; return q > 0 && q <= 10; }).length;
  const negATSCount  = filtered.filter(r => Object.values(r.dates).some(q => q < 0)).length;
  const totalSoQty   = filtered.reduce((s, r) => s + r.onCommitted, 0);
  const totalPoQty   = filtered.reduce((s, r) => s + r.onOrder, 0);

  const filteredSkuSet = useMemo(() => new Set(filtered.map(r => r.sku)), [filtered]);

  const { totalSoValue, totalPoValue } = useMemo(() => {
    if (!excelData) return { totalSoValue: 0, totalPoValue: 0 };
    const isAll = storeFilter.includes("All");
    const soV = excelData.sos.filter(s => (isAll || storeFilter.includes(s.store ?? "ROF")) && filteredSkuSet.has(s.sku)).reduce((a, s) => a + (s.totalPrice || s.unitPrice * s.qty || 0), 0);
    const poV = excelData.pos.filter(p => (isAll || storeFilter.includes(p.store ?? "ROF")) && filteredSkuSet.has(p.sku)).reduce((a, p) => a + p.qty * (p.unitCost || 0), 0);
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

  // ── Stat-card filter: show only rows matching the active stat in ANY column ─
  const statFiltered = useMemo(() => {
    if (!activeSort) return filtered;
    if (activeSort === "negATS")    return filtered.filter(r => Object.values(r.dates).some(q => q < 0));
    if (activeSort === "zeroStock") return filtered.filter(r => displayPeriods.some(p => { const q = r.dates[p.endDate]; return q != null && q <= 0; }));
    if (activeSort === "lowStock")  return filtered.filter(r => displayPeriods.some(p => { const q = r.dates[p.endDate]; return q != null && q > 0 && q <= 10; }));
    return filtered;
  }, [activeSort, filtered, displayPeriods]);

  // ── Sort by column header click ─────────────────────────────────────────
  function handleThClick(col: string) {
    if (sortCol === col) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortCol(col); setSortDir("asc"); }
  }

  const sortedFiltered = useMemo(() => {
    if (!sortCol) return statFiltered;
    return [...statFiltered].sort((a, b) => {
      let av: string | number, bv: string | number;
      if      (sortCol === "sku")         { av = a.sku;         bv = b.sku; }
      else if (sortCol === "description") { av = a.description; bv = b.description; }
      else if (sortCol === "onHand")      { av = a.onHand;      bv = b.onHand; }
      else if (sortCol === "onOrder")     { av = a.onCommitted; bv = b.onCommitted; }
      else if (sortCol === "onPO")        { av = a.onOrder;     bv = b.onOrder; }
      else { av = a.dates[sortCol] ?? 0; bv = b.dates[sortCol] ?? 0; }
      if (typeof av === "string") return sortDir === "asc" ? av.localeCompare(bv as string) : (bv as string).localeCompare(av);
      return sortDir === "asc" ? (av as number) - (bv as number) : (bv as number) - (av as number);
    });
  }, [sortCol, sortDir, statFiltered]);

  const totalPages = Math.ceil(sortedFiltered.length / PAGE_SIZE);
  const pageRows   = sortedFiltered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  // Reset to page 0 whenever filters/search/sort change
  useEffect(() => { setPage(0); }, [search, filterCategory, filterStatus, minATS, poStores, soStores, rows, activeSort, sortCol, sortDir]);

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER — see ats/renderPanel.tsx
  return atsRenderPanel({
    startDate, setStartDate, rangeUnit, setRangeUnit, rangeValue, setRangeValue,
    search, setSearch, filterCategory, setFilterCategory, filterStatus, setFilterStatus,
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
    handleFileUpload, handleThClick, loadFromSupabase, saveUploadData, toggleStore, exportToExcel,
    repositionCtxMenu, repositionSummaryCtx, cancelRef, abortRef,
    cancelUpload, openSummaryCtx, getEventsInPeriod, lowStock, negATSCount, zeroStock, totalSKUs, totalPoQty, totalSoQty, todayKey, syncProgress,
    normChanges, setNormChanges, applyNormReview, dismissNormReview,
  });
}
