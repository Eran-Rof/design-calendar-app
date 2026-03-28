import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from "react";
import XLSXStyle from "xlsx-js-style";

// ── Supabase ──────────────────────────────────────────────────────────────────
const SB_URL = "https://qcvqvxxoperiurauoxmp.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFjdnF2eHhvcGVyaXVyYXVveG1wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2ODU4MjksImV4cCI6MjA4OTI2MTgyOX0.YoBmIdlqqPYt9roTsDPGSBegNnoupCYSsnyCHMo24Zw";
const SB_HEADERS = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  "Content-Type": "application/json",
};

// ── Types ─────────────────────────────────────────────────────────────────────
interface ATSRow {
  sku: string;
  description: string;
  category?: string;
  store?: string;      // "ROF" | "PT" — derived from brand
  dates: Record<string, number>;
  onOrder:     number; // open PO qty (incoming from vendors)
  onCommitted: number; // committed SO qty (outgoing to customers)
  onHand: number;
  avgCost?: number;
  lastReceiptDate?: string;
  totalAmount?: number;
}

interface ATSSnapshot {
  id: string;
  sku: string;
  description: string;
  category?: string;
  date: string;
  qty_available: number;
  qty_on_hand: number;
  qty_on_order: number;
  source: "xoro" | "excel";
  synced_at: string;
}

// Compact format stored in app_data — compute timeline client-side
interface ATSSkuData     { sku: string; description: string; category?: string; store?: string; onHand: number; onOrder: number; onCommitted?: number; lastReceiptDate?: string; totalAmount?: number; avgCost?: number; }
interface ATSPoEvent     { sku: string; date: string; qty: number; poNumber: string; vendor: string; store: string; unitCost: number; }
interface ATSSoEvent     { sku: string; date: string; qty: number; orderNumber: string; customerName: string; unitPrice: number; totalPrice: number; store: string; }
interface UploadWarning  { severity: "error" | "warn"; field: string; affected: number; total: number; message: string; }
interface ExcelData      { syncedAt: string; skus: ATSSkuData[]; pos: ATSPoEvent[]; sos: ATSSoEvent[]; warnings?: UploadWarning[]; columnNames?: { inventory: string[]; purchases: string[]; orders: string[] }; }
interface CtxMenu        { x: number; y: number; anchorY: number; pos: ATSPoEvent[]; sos: ATSSoEvent[]; onHand: number; skuStore: string; cellKey: string; cellEl: HTMLElement | null; flipped: boolean; arrowLeft: number; }
interface SummaryCtxMenu { type: "onHand" | "onOrder" | "onPO"; row: ATSRow; pos: ATSPoEvent[]; sos: ATSSoEvent[]; cellEl: HTMLElement; }

// ── Helpers ───────────────────────────────────────────────────────────────────
function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}
function fmtDate(d: Date): string {
  return d.toISOString().split("T")[0];
}
function fmtDateShort(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function fmtDateDisplay(dateStr: string): string {
  if (!dateStr) return "—";
  // Handle both ISO (YYYY-MM-DD) and US (MM/DD/YYYY) formats
  const d = dateStr.includes("-") ? new Date(dateStr + "T00:00:00") : new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[d.getMonth()]}/${String(d.getDate()).padStart(2,"0")}/${d.getFullYear()}`;
}
function fmtDateHeader(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  const day = d.toLocaleDateString("en-US", { weekday: "short" });
  return `${day}\n${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}
function isToday(iso: string): boolean {
  return iso === fmtDate(new Date());
}
function isWeekend(iso: string): boolean {
  const d = new Date(iso + "T00:00:00");
  const day = d.getDay();
  return day === 0 || day === 6;
}

function getQtyColor(qty: number): string {
  if (qty <= 0)   return "#EF4444";
  if (qty <= 10)  return "#F59E0B";
  if (qty <= 50)  return "#3B82F6";
  return "#10B981";
}
function getQtyBg(qty: number): string {
  if (qty <= 0)   return "rgba(239,68,68,0.15)";
  if (qty <= 10)  return "rgba(245,158,11,0.15)";
  if (qty <= 50)  return "rgba(59,130,246,0.12)";
  return "rgba(16,185,129,0.1)";
}

function generateMockData(_dates: string[]): ATSRow[] {
  return [];
}

// ── Compute ATS rows from compact Excel data ─────────────────────────────────
function computeRowsFromExcelData(data: ExcelData, dates: string[], poStores: string[] = ["All"], soStores: string[] = ["All"]): ATSRow[] {
  const allPo = poStores.includes("All");
  const allSo = soStores.includes("All");

  // Pre-index events by SKU → date → qty, respecting store filters
  const poIdx: Record<string, Record<string, number>> = {};
  const soIdx: Record<string, Record<string, number>> = {};
  for (const p of data.pos) {
    if (!allPo && !poStores.includes(p.store ?? "ROF")) continue;
    if (!poIdx[p.sku]) poIdx[p.sku] = {};
    poIdx[p.sku][p.date] = (poIdx[p.sku][p.date] ?? 0) + p.qty;
  }
  for (const o of data.sos) {
    if (!allSo && !soStores.includes(o.store ?? "ROF")) continue;
    if (!soIdx[o.sku]) soIdx[o.sku] = {};
    soIdx[o.sku][o.date] = (soIdx[o.sku][o.date] ?? 0) + o.qty;
  }

  // Compute onCommitted from soIdx (fallback for old cached data missing the field on skus)
  const committedBySku: Record<string, number> = {};
  for (const [sku, datemap] of Object.entries(soIdx)) {
    committedBySku[sku] = Object.values(datemap).reduce((a, b) => a + b, 0);
  }

  const rangeStart = dates[0]; // earliest date in the display window

  return data.skus.map(s => {
    const poDates = poIdx[s.sku] ?? {};
    const soDates = soIdx[s.sku] ?? {};

    // Apply events that fall BEFORE the display range to the opening balance.
    // Without this, past SOs (cancel date < startDate) never reduce ATS.
    let ats = s.onHand;
    for (const [date, qty] of Object.entries(poDates)) {
      if (date < rangeStart) ats += qty;
    }
    for (const [date, qty] of Object.entries(soDates)) {
      if (date < rangeStart) ats -= qty;
    }
    if (ats < 0) ats = 0;

    // Walk forward through the display range — do NOT clamp to 0 mid-stream;
    // clamping causes subsequent POs to appear as fresh inventory rather than
    // restoring the true running balance (e.g. OH 205 - SO 2878 + PO 2878 = 205).
    const dateMap: Record<string, number> = {};
    for (const date of dates) {
      ats += (poDates[date] ?? 0) - (soDates[date] ?? 0);
      dateMap[date] = ats; // store the real balance; display layer shows 0 for negatives
    }

    // Column totals use the filtered indices so On Order / On PO reflect the active store filter
    const filteredOnOrder     = Object.values(poIdx[s.sku] ?? {}).reduce((a, b) => a + b, 0);
    const filteredOnCommitted = Object.values(soIdx[s.sku] ?? {}).reduce((a, b) => a + b, 0);
    return { sku: s.sku, description: s.description, category: s.category, store: s.store, onHand: s.onHand, onOrder: filteredOnOrder, onCommitted: filteredOnCommitted, dates: dateMap, avgCost: s.avgCost, lastReceiptDate: s.lastReceiptDate, totalAmount: s.totalAmount };
  });
}

// ── Export to Excel ────────────────────────────────────────────────────────
function exportToExcel(rows: ATSRow[], periods: Array<{ endDate: string; label: string }>) {
  // ── Styles ──────────────────────────────────────────────────────────────
  const HDR: any = {
    font:      { bold: true, color: { rgb: "FFFFFF" }, sz: 11, name: "Calibri" },
    fill:      { fgColor: { rgb: "1F497D" }, patternType: "solid" },
    alignment: { horizontal: "center", vertical: "center", wrapText: false },
    border: {
      top:    { style: "thin", color: { rgb: "4472C4" } },
      bottom: { style: "medium", color: { rgb: "4472C4" } },
      left:   { style: "thin", color: { rgb: "4472C4" } },
      right:  { style: "thin", color: { rgb: "4472C4" } },
    },
  };
  const HDR_LEFT: any = { ...HDR, alignment: { horizontal: "left", vertical: "center" } };
  const HDR_NUM:  any = { ...HDR, alignment: { horizontal: "right", vertical: "center" } };

  const cellEven: any = {
    fill:      { fgColor: { rgb: "EEF3FA" }, patternType: "solid" },
    alignment: { horizontal: "left", vertical: "center" },
    border: { left: { style: "thin", color: { rgb: "D0D8E4" } }, right: { style: "thin", color: { rgb: "D0D8E4" } } },
  };
  const cellOdd: any = {
    fill:      { fgColor: { rgb: "FFFFFF" }, patternType: "solid" },
    alignment: { horizontal: "left", vertical: "center" },
    border: { left: { style: "thin", color: { rgb: "D0D8E4" } }, right: { style: "thin", color: { rgb: "D0D8E4" } } },
  };
  const numEven: any = { ...cellEven, alignment: { horizontal: "right", vertical: "center" } };
  const numOdd:  any = { ...cellOdd,  alignment: { horizontal: "right", vertical: "center" } };

  const negStyle = (base: any): any => ({ ...base, font: { bold: true, color: { rgb: "C00000" }, sz: 11, name: "Calibri" } });
  const lowStyle = (base: any): any => ({ ...base, font: { bold: true, color: { rgb: "7F6000" }, sz: 11, name: "Calibri" }, fill: { fgColor: { rgb: "FFEB9C" }, patternType: "solid" } });
  const outStyle = (base: any): any => ({ ...base, font: { bold: true, color: { rgb: "9C0006" }, sz: 11, name: "Calibri" }, fill: { fgColor: { rgb: "FFC7CE" }, patternType: "solid" } });

  // ── Columns ─────────────────────────────────────────────────────────────
  const fixedHdrs = ["SKU", "Description", "Category", "Store", "On Hand", "On Order (SO)", "On PO"];
  const dateLabels = periods.map(p => p.label.replace(/\n/g, " "));
  const allHdrs = [...fixedHdrs, ...dateLabels];

  // ── Header row ──────────────────────────────────────────────────────────
  const headerRow = allHdrs.map((h, ci) => ({
    v: h,
    t: "s",
    s: ci < 2 ? HDR_LEFT : ci >= 4 ? HDR_NUM : HDR,
  }));

  // ── Data rows ───────────────────────────────────────────────────────────
  const dataRows = rows.map((r, ri) => {
    const isEven = ri % 2 === 0;
    const base   = isEven ? cellEven : cellOdd;
    const numB   = isEven ? numEven  : numOdd;
    const todayQ = r.dates[fmtDate(new Date())] ?? r.onHand;

    return [
      { v: r.sku,              t: "s", s: { ...base, font: { bold: true, color: { rgb: "1F497D" }, sz: 11, name: "Calibri" } } },
      { v: r.description,      t: "s", s: base },
      { v: r.category ?? "",   t: "s", s: base },
      { v: r.store ?? "ROF",   t: "s", s: base },
      { v: r.onHand,           t: "n", s: todayQ <= 0 ? outStyle(numB) : todayQ <= 10 ? lowStyle(numB) : numB },
      { v: r.onCommitted || 0, t: "n", s: numB },
      { v: r.onOrder    || 0,  t: "n", s: numB },
      ...periods.map(p => {
        const q = r.dates[p.endDate];
        if (q == null) return { v: "", t: "s", s: base };
        const nb = numB;
        const style = q < 0 ? negStyle(nb) : q === 0 ? outStyle(nb) : q <= 10 ? lowStyle(nb) : nb;
        return { v: q, t: "n", s: style };
      }),
    ];
  });

  // ── Build worksheet ─────────────────────────────────────────────────────
  const aoa = [headerRow, ...dataRows];
  const ws  = XLSXStyle.utils.aoa_to_sheet(aoa, { skipHeader: true });

  // Column widths
  ws["!cols"] = [
    { wch: 20 }, // SKU
    { wch: 34 }, // Description
    { wch: 16 }, // Category
    { wch: 10 }, // Store
    { wch: 11 }, // On Hand
    { wch: 14 }, // On Order
    { wch: 10 }, // On PO
    ...periods.map(() => ({ wch: 13 })),
  ];

  // Row height for header
  ws["!rows"] = [{ hpt: 20 }];

  // Freeze: row 1 (header) + first 3 columns (SKU, Description, Category)
  ws["!freeze"] = { xSplit: 3, ySplit: 1 };

  const wb = XLSXStyle.utils.book_new();
  XLSXStyle.utils.book_append_sheet(wb, ws, "ATS Report");

  const buf  = XLSXStyle.write(wb, { bookType: "xlsx", type: "array" });
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `ATS_Report_${fmtDate(new Date())}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function ATSReport() {
  const today = new Date();
  const [startDate, setStartDate] = useState(() => fmtDate(addDays(today, -5)));
  const [rangeUnit, setRangeUnit]   = useState<"days" | "weeks" | "months">("months");
  const [rangeValue, setRangeValue] = useState(6);
  const [search, setSearch] = useState("");
  const [filterCategory, setFilterCategory] = useState("All");
  const [filterStatus, setFilterStatus] = useState("All"); // All, Low, Out, InStock
  const [minATS, setMinATS] = useState<number | "">("");
  const STORES = ["ROF", "ROF ECOM", "PT"] as const;
  const [poStores, setPoStores]     = useState<string[]>(["All"]);
  const [soStores, setSoStores]     = useState<string[]>(["All"]);
  const [poDropOpen, setPoDropOpen] = useState(false);
  const [soDropOpen, setSoDropOpen] = useState(false);
  const poDropRef = useRef<HTMLDivElement>(null);
  const soDropRef = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState<ATSRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [mockMode, setMockMode] = useState(false);
  const [page, setPage]         = useState(0);
  const PAGE_SIZE = 100;
  const [uploadingFile, setUploadingFile] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ step: string; pct: number } | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState("");
  const [lastSync, setLastSync] = useState("");
  const [syncError, setSyncError] = useState<{ title: string; detail: string } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadWarnings, setUploadWarnings] = useState<UploadWarning[] | null>(null);
  const [pendingUploadData, setPendingUploadData] = useState<ExcelData | null>(null);
  const [excelData, setExcelData] = useState<ExcelData | null>(null);
  const [hoveredCell, setHoveredCell] = useState<{ sku: string; date: string } | null>(null);
  const [pinnedSku, setPinnedSku] = useState<string | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const [invFile, setInvFile] = useState<File | null>(null);
  const [purFile, setPurFile] = useState<File | null>(null);
  const [ordFile, setOrdFile] = useState<File | null>(null);
  const invRef = useRef<HTMLInputElement>(null);
  const purRef = useRef<HTMLInputElement>(null);
  const ordRef = useRef<HTMLInputElement>(null);
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const ctxRef   = useRef<HTMLDivElement>(null);
  const [summaryCtx, setSummaryCtx] = useState<SummaryCtxMenu | null>(null);
  const summaryCtxRef = useRef<HTMLDivElement>(null);
  const [activeSort, setActiveSort] = useState<string | null>(null);
  const [sortCol, setSortCol]   = useState<string | null>(null);
  const [sortDir, setSortDir]   = useState<"asc" | "desc">("asc");
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

  function getEventsInPeriod(sku: string, periodStart: string, endDate: string) {
    const skuIdx = eventIndex?.[sku];
    if (!skuIdx) return { pos: [] as ATSPoEvent[], sos: [] as ATSSoEvent[] };
    const pos: ATSPoEvent[] = [], sos: ATSSoEvent[] = [];
    const allPo = poStores.includes("All");
    const allSo = soStores.includes("All");
    for (const [date, ev] of Object.entries(skuIdx)) {
      if (date >= periodStart && date <= endDate) {
        pos.push(...(allPo ? ev.pos : ev.pos.filter(p => poStores.includes(p.store ?? "ROF"))));
        sos.push(...(allSo ? ev.sos : ev.sos.filter(s => soStores.includes(s.store ?? "ROF"))));
      }
    }
    return { pos, sos };
  }

  function getAllSkuEvents(sku: string): { pos: ATSPoEvent[]; sos: ATSSoEvent[] } {
    if (!excelData) return { pos: [], sos: [] };
    return {
      pos: excelData.pos.filter(p => p.sku === sku),
      sos: excelData.sos.filter(s => s.sku === sku),
    };
  }

  function openSummaryCtx(e: React.MouseEvent, type: SummaryCtxMenu["type"], row: ATSRow) {
    e.preventDefault();
    const { pos, sos } = getAllSkuEvents(row.sku);
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
  useEffect(() => {
    if (mockMode) {
      setRows(generateMockData(dates));
    } else if (excelData) {
      setRows(computeRowsFromExcelData(excelData, dates, poStores, soStores));
    }
  }, [mockMode, excelData, dates, poStores, soStores]);

  async function syncFromXoro() {
    setSyncing(true);
    try {
      const today = fmtDate(new Date());
      const now   = new Date().toISOString();

      // ── Helper: fetch all pages from a Xoro endpoint ──────────────────────
      async function fetchAllPages(path: string, extraParams: Record<string, string> = {}): Promise<any[]> {
        const all: any[] = [];
        let page = 1;
        while (true) {
          const params = new URLSearchParams({ path, page: String(page), ...extraParams });
          const res  = await fetch(`/api/xoro-proxy?${params}`);
          if (!res.ok) throw new Error(`Xoro proxy returned HTTP ${res.status} for "${path}"`);
          const text = await res.text();
          let json: any;
          try { json = JSON.parse(text); } catch {
            throw new Error(`Xoro returned an unexpected response for "${path}". The endpoint path may be incorrect.`);
          }
          if (!json.Result) {
            // Not a fatal error for optional endpoints — just return what we have
            break;
          }
          const rows = Array.isArray(json.Data) ? json.Data : json.Data?.Items ?? [];
          all.push(...rows);
          if (page >= (json.TotalPages ?? 1)) break;
          page++;
        }
        return all;
      }

      // ── 1. Inventory (on-hand + Xoro's own available/on-order) ────────────
      setSyncStatus("Fetching inventory…");
      const invItems = await fetchAllPages("inventory");

      // Base map: sku → snapshot from inventory
      const skuMap: Record<string, {
        sku: string; description: string; category?: string;
        qty_on_hand: number; qty_on_order_po: number; qty_committed: number;
      }> = {};

      for (const item of invItems) {
        const sku = String(item.ItemNumber ?? item.ItemCode ?? "").trim();
        if (!sku) continue;
        skuMap[sku] = {
          sku,
          description: String(item.Description ?? item.ItemName ?? "").trim(),
          category:    item.CategoryName ?? item.Category ?? undefined,
          qty_on_hand:     Number(item.QtyOnHand ?? item.QtyAvailable ?? 0),
          qty_on_order_po: Number(item.QtyOnOrder ?? 0),
          qty_committed:   0,
        };
      }

      // ── 2. Open Purchase Orders → aggregate qty_on_order per SKU ──────────
      setSyncStatus("Fetching purchase orders…");
      const openPOs = await fetchAllPages("purchaseorder/getpurchaseorder", {
        status: "Open,Released,Pending",
      });

      for (const po of openPOs) {
        const lines = po.poLines ?? po.PoLineArr ?? po.Items ?? [];
        for (const line of lines) {
          const sku = String(line.PoItemNumber ?? line.ItemNumber ?? "").trim();
          if (!sku) continue;
          if (!skuMap[sku]) {
            skuMap[sku] = {
              sku,
              description: String(line.Description ?? "").trim(),
              qty_on_hand: 0, qty_on_order_po: 0, qty_committed: 0,
            };
          }
          skuMap[sku].qty_on_order_po += Number(line.QtyOrder ?? line.QtyOrdered ?? 0);
        }
      }

      // ── 3. Open Sales Orders → aggregate qty_committed per SKU ────────────
      setSyncStatus("Fetching sales orders…");
      const openSOs = await fetchAllPages("salesorder/getsalesorder", {
        status: "Open,Released,Pending",
      });

      for (const so of openSOs) {
        const lines = so.soLines ?? so.SoLineArr ?? so.Items ?? [];
        for (const line of lines) {
          const sku = String(line.ItemNumber ?? line.SoItemNumber ?? "").trim();
          if (!sku) continue;
          if (!skuMap[sku]) {
            skuMap[sku] = {
              sku,
              description: String(line.Description ?? "").trim(),
              qty_on_hand: 0, qty_on_order_po: 0, qty_committed: 0,
            };
          }
          skuMap[sku].qty_committed += Number(line.QtyOrder ?? line.QtyOrdered ?? line.QtyShipped ?? 0);
        }
      }

      // ── 4. Build snapshots and upsert ──────────────────────────────────────
      setSyncStatus(`Saving ${Object.keys(skuMap).length} SKUs…`);
      const snapshots = Object.values(skuMap)
        .filter(s => s.sku)
        .map(s => ({
          sku:           s.sku,
          description:   s.description,
          category:      s.category,
          date:          today,
          qty_on_hand:   s.qty_on_hand,
          qty_on_order:  s.qty_on_order_po,
          qty_available: Math.max(0, s.qty_on_hand - s.qty_committed),
          source:        "xoro" as const,
          synced_at:     now,
        }));

      // Batch upsert in chunks of 500
      for (let i = 0; i < snapshots.length; i += 500) {
        await fetch(`${SB_URL}/rest/v1/ats_snapshots`, {
          method: "POST",
          headers: { ...SB_HEADERS, Prefer: "resolution=merge-duplicates,return=representation" },
          body: JSON.stringify(snapshots.slice(i, i + 500)),
        });
      }

      setSyncStatus("Loading…");
      setLastSync(now);
      setMockMode(false);
      await loadFromSupabase();
      setSyncStatus("");
    } catch (e) {
      console.error(e);
      setSyncStatus("");
      setSyncError({
        title: "Xoro Sync Failed",
        detail: (e as Error).message,
      });
    } finally {
      setSyncing(false);
    }
  }

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
        const data: ExcelData = JSON.parse(excelRows[0].value);
        setExcelData(data);
        setRows(computeRowsFromExcelData(data, dates));
        setLastSync(data.syncedAt);
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
      if (!pur && data.pos.length === 0) {
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
                const sku = item.ItemNumber ?? "";
                if (!sku) continue;
                const qty = item.QtyOrder ?? 0;
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
    // A row matches the store filter if it has matching PO/SO events OR its brand belongs to the selected store.
    // "ROF ECOM" maps to "ROF" at the brand level (ECOM is a channel, not a brand).
    const skuBrand = r.store ?? "ROF";
    const brandMatchesPo = !poStores.includes("All") && poStores.some(s => s === skuBrand || (s === "ROF ECOM" && skuBrand === "ROF"));
    const brandMatchesSo = !soStores.includes("All") && soStores.some(s => s === skuBrand || (s === "ROF ECOM" && skuBrand === "ROF"));
    const matchPOStore = !poFilterSkus || poFilterSkus.has(r.sku) || brandMatchesPo;
    const matchSOStore = !soFilterSkus || soFilterSkus.has(r.sku) || brandMatchesSo;
    return matchSearch && matchCat && matchStatus && matchMin && matchPOStore && matchSOStore;
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
    const soV = excelData.sos.filter(s => filteredSkuSet.has(s.sku)).reduce((a, s) => a + (s.totalPrice || 0), 0);
    const poV = excelData.pos.filter(p => filteredSkuSet.has(p.sku)).reduce((a, p) => a + p.qty * (p.unitCost || 0), 0);
    return { totalSoValue: soV, totalPoValue: poV };
  }, [excelData, filteredSkuSet]);

  const { marginDollars, marginPct } = useMemo(() => {
    if (!excelData || totalSoValue === 0) return { marginDollars: 0, marginPct: 0 };
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
    // Sum cost of each SO line using that SKU's avg cost
    let totalCost = 0;
    for (const s of excelData.sos) {
      if (!filteredSkuSet.has(s.sku)) continue;
      totalCost += (avgCostBySku[s.sku] ?? 0) * s.qty;
    }
    const margin = totalSoValue - totalCost;
    return { marginDollars: margin, marginPct: margin / totalSoValue };
  }, [excelData, filteredSkuSet, totalSoValue]);

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
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────
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
          <button style={S.navBtn} onClick={() => setShowUpload(true)} disabled={uploadingFile}>
            {uploadingFile ? "Uploading…" : "Upload Excel"}
            {!uploadingFile && (invFile || purFile || ordFile) && (
              <span style={{ marginLeft: 6, background: "#10B981", color: "#fff", borderRadius: 10, padding: "1px 6px", fontSize: 11, fontWeight: 700 }}>
                {[invFile, ordFile].filter(Boolean).length}/2{purFile ? "+PO" : ""}
              </span>
            )}
          </button>
          <button style={S.navBtn} onClick={syncFromXoro} disabled={syncing}>
            {syncing ? (syncStatus || "Syncing…") : "Sync Xoro"}
          </button>
          <button
            style={{ ...S.navBtn, background: "#1D6F42", border: "1px solid #155734", color: "#fff", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 6 }}
            onClick={() => exportToExcel(filtered, displayPeriods.map(p => ({ endDate: p.endDate, label: p.label })))}
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

      <div style={S.content}>
        {/* STAT CARDS */}
        <div style={{ ...S.statsRow, gridTemplateColumns: "repeat(9,1fr)" }}>
          <StatCard icon="△" label="Low Stock (≤10)"  value={lowStock}        color="#F59E0B" sortKey="lowStock"   activeSort={activeSort} onSort={k => setActiveSort(k)} />
          <StatCard icon="▽" label="Zero Stock"        value={zeroStock}       color="#EF4444" sortKey="zeroStock"  activeSort={activeSort} onSort={k => setActiveSort(k)} />
          <StatCard icon="↓" label="Negative ATS"      value={negATSCount}     color="#F87171" sortKey="negATS"     activeSort={activeSort} onSort={k => setActiveSort(k)} />
          <StatCard icon="▦" label="Total SKUs"         value={totalSKUs}       color="#3B82F6" sortKey="total"      activeSort={activeSort} onSort={k => setActiveSort(k)} />
          <StatCard icon="↑" label="Units on Order"     value={totalSoQty}      color="#10B981" sortKey="onOrder"   activeSort={activeSort} onSort={k => setActiveSort(k)} />
          <StatCard icon="$" label="$ on Order"         value={totalSoValue}    color="#10B981" fmt="dollar" />
          <StatCard icon="⬆" label="Units on PO"        value={totalPoQty}      color="#60A5FA" />
          <StatCard icon="$" label="$ on PO"            value={totalPoValue}    color="#60A5FA" fmt="dollar" />
          <StatCard icon="%" label="Margin"             value={marginDollars}   color={marginDollars >= 0 ? "#A3E635" : "#F87171"} fmt="margin" marginPct={marginPct} />
        </div>

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
          {/* PO Store filter dropdown */}
          <div ref={poDropRef} style={{ position: "relative" }}>
            <button
              style={{ ...S.select, display: "flex", alignItems: "center", gap: 6, cursor: "pointer", minWidth: 120, justifyContent: "space-between" }}
              onClick={() => { setPoDropOpen(o => !o); setSoDropOpen(false); }}
            >
              <span style={{ color: "#F59E0B", fontSize: 11, fontWeight: 600, marginRight: 2 }}>PO:</span>
              <span style={{ flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {poStores.includes("All") ? "All stores" : poStores.join(", ")}
              </span>
              <span style={{ fontSize: 9, color: "#6B7280" }}>▼</span>
            </button>
            {poDropOpen && (
              <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 200, background: "#1E293B", border: "1px solid #334155", borderRadius: 8, minWidth: 160, boxShadow: "0 8px 24px rgba(0,0,0,0.4)", padding: "6px 0" }}>
                {(["All", ...STORES] as string[]).map(s => {
                  const checked = s === "All" ? poStores.includes("All") : poStores.includes(s);
                  return (
                    <label key={s} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 14px", cursor: "pointer", background: checked ? "rgba(245,158,11,0.08)" : "transparent" }}
                      onMouseEnter={e => (e.currentTarget.style.background = "rgba(245,158,11,0.12)")}
                      onMouseLeave={e => (e.currentTarget.style.background = checked ? "rgba(245,158,11,0.08)" : "transparent")}
                    >
                      <input type="checkbox" checked={checked} onChange={() => toggleStore(poStores, setPoStores, s)} style={{ accentColor: "#F59E0B", cursor: "pointer" }} />
                      <span style={{ color: checked ? "#FCD34D" : "#9CA3AF", fontSize: 13 }}>{s}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
          {/* SO Store filter dropdown */}
          <div ref={soDropRef} style={{ position: "relative" }}>
            <button
              style={{ ...S.select, display: "flex", alignItems: "center", gap: 6, cursor: "pointer", minWidth: 120, justifyContent: "space-between" }}
              onClick={() => { setSoDropOpen(o => !o); setPoDropOpen(false); }}
            >
              <span style={{ color: "#3B82F6", fontSize: 11, fontWeight: 600, marginRight: 2 }}>SO:</span>
              <span style={{ flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {soStores.includes("All") ? "All stores" : soStores.join(", ")}
              </span>
              <span style={{ fontSize: 9, color: "#6B7280" }}>▼</span>
            </button>
            {soDropOpen && (
              <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 200, background: "#1E293B", border: "1px solid #334155", borderRadius: 8, minWidth: 160, boxShadow: "0 8px 24px rgba(0,0,0,0.4)", padding: "6px 0" }}>
                {(["All", ...STORES] as string[]).map(s => {
                  const checked = s === "All" ? soStores.includes("All") : soStores.includes(s);
                  return (
                    <label key={s} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 14px", cursor: "pointer", background: checked ? "rgba(59,130,246,0.08)" : "transparent" }}
                      onMouseEnter={e => (e.currentTarget.style.background = "rgba(59,130,246,0.12)")}
                      onMouseLeave={e => (e.currentTarget.style.background = checked ? "rgba(59,130,246,0.08)" : "transparent")}
                    >
                      <input type="checkbox" checked={checked} onChange={() => toggleStore(soStores, setSoStores, s)} style={{ accentColor: "#3B82F6", cursor: "pointer" }} />
                      <span style={{ color: checked ? "#93C5FD" : "#9CA3AF", fontSize: 13 }}>{s}</span>
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
          <button style={S.navBtn} onClick={() => loadFromSupabase()} disabled={loading}>
            {loading ? "Loading…" : "↺ Refresh"}
          </button>
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
                  const isPinned = pinnedSku === row.sku;
                  return (
                    <tr
                      key={row.sku}
                      style={{
                        background: isPinned ? "#1a2332" : ri % 2 === 0 ? "#0F172A" : "#111827",
                        transition: "background 0.15s",
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
                        const qty = row.dates[p.endDate]; // real balance, may be negative
                        const isNeg   = qty != null && qty < 0;
                        const isHov   = hoveredCell?.sku === row.sku && hoveredCell?.date === p.key;
                        const isEmpty = qty === undefined || qty === null;
                        const ev      = eventIndex ? getEventsInPeriod(row.sku, p.periodStart, p.endDate) : null;
                        const hasPO   = (ev?.pos.length ?? 0) > 0;
                        const hasSO   = (ev?.sos.length ?? 0) > 0;
                        const canClick = hasPO || hasSO || isNeg;
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

      {/* SUMMARY COLUMN RIGHT-CLICK CONTEXT MENU */}
      {summaryCtx && (() => {
        const { type, row, pos, sos } = summaryCtx;
        const storeTag = (store: string) => (
          <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 8,
            background: store === "ROF ECOM" ? "rgba(14,165,233,0.2)" : store === "PT" ? "rgba(139,92,246,0.2)" : "rgba(59,130,246,0.2)",
            color:      store === "ROF ECOM" ? "#7dd3fc"              : store === "PT" ? "#c4b5fd"              : "#93c5fd" }}>
            {store}
          </span>
        );
        const poByStore: Record<string, number> = {};
        for (const p of pos) poByStore[p.store ?? "ROF"] = (poByStore[p.store ?? "ROF"] ?? 0) + p.qty;
        const soByStore: Record<string, number> = {};
        for (const s of sos) soByStore[s.store ?? "ROF"] = (soByStore[s.store ?? "ROF"] ?? 0) + s.qty;
        // Average cost from PO history
        const avgCost = (() => {
          const skuPos = pos.filter(p => p.unitCost > 0);
          const totalQty = skuPos.reduce((s, p) => s + p.qty, 0);
          return totalQty > 0 ? skuPos.reduce((s, p) => s + p.qty * p.unitCost, 0) / totalQty : 0;
        })();
        return (
          <div ref={summaryCtxRef} style={{ position: "fixed", left: 0, top: 0, zIndex: 500, minWidth: 280, maxWidth: 420, filter: "drop-shadow(0 8px 24px rgba(0,0,0,0.55))" }} onClick={e => e.stopPropagation()}>
            {/* Up arrow (normal, popup below cell) */}
            <div data-arrow="up" style={{ position: "relative", height: 8, overflow: "visible" }}>
              <div style={{ position: "absolute", top: 0, left: 20, width: 0, height: 0, borderLeft: "9px solid transparent", borderRight: "9px solid transparent", borderBottom: "9px solid #334155", pointerEvents: "none" }} />
              <div style={{ position: "absolute", top: 1, left: 21, width: 0, height: 0, borderLeft: "8px solid transparent", borderRight: "8px solid transparent", borderBottom: "8px solid #1E293B", pointerEvents: "none" }} />
            </div>
            <div style={{ background: "#1E293B", border: "1px solid #334155", borderRadius: 10, overflow: "hidden", maxHeight: "70vh", overflowY: "auto" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 14px 6px", borderBottom: "1px solid #1a2030", position: "sticky", top: 0, background: "#1E293B", zIndex: 1 }}>
                <span style={{ color: "#60A5FA", fontFamily: "monospace", fontWeight: 700, fontSize: 12 }}>{row.sku}</span>
                <button style={{ background: "none", border: "none", color: "#475569", fontSize: 16, cursor: "pointer", lineHeight: 1, padding: "2px 4px", borderRadius: 4 }} onClick={() => setSummaryCtx(null)}>✕</button>
              </div>
              {/* ON HAND */}
              {type === "onHand" && (
                <div>
                  <div style={{ background: "rgba(241,245,249,0.08)", padding: "7px 14px", fontSize: 11, fontWeight: 700, color: "#F1F5F9", textTransform: "uppercase", letterSpacing: "0.07em", borderBottom: "1px solid #334155" }}>On Hand</div>
                  <div style={{ padding: "10px 14px", fontSize: 12, borderBottom: "1px solid #1a2030" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>{storeTag(row.store ?? "ROF")}<span style={{ color: "#94A3B8" }}>{row.description}</span></span>
                      <span style={{ color: "#F1F5F9", fontWeight: 700, fontFamily: "monospace" }}>{row.onHand.toLocaleString()} units</span>
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
              {/* ON ORDER (committed SOs) */}
              {type === "onOrder" && (
                <div>
                  <div style={{ background: "rgba(245,158,11,0.12)", padding: "7px 14px", fontSize: 11, fontWeight: 700, color: "#FCD34D", textTransform: "uppercase", letterSpacing: "0.07em", borderBottom: "1px solid #3D2E00" }}>Committed Sales Orders — {sos.length} line{sos.length !== 1 ? "s" : ""}</div>
                  {Object.keys(soByStore).length > 1 && (
                    <div style={{ padding: "6px 14px", borderBottom: "1px solid #1a2030", display: "flex", gap: 12, flexWrap: "wrap" }}>
                      {Object.entries(soByStore).map(([st, qty]) => (
                        <span key={st} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11 }}>{storeTag(st)}<span style={{ color: "#F59E0B", fontFamily: "monospace", fontWeight: 600 }}>{qty.toLocaleString()}</span></span>
                      ))}
                    </div>
                  )}
                  {sos.map((s, i) => (
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
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {/* ON PO */}
              {type === "onPO" && (
                <div>
                  <div style={{ background: "rgba(16,185,129,0.12)", padding: "7px 14px", fontSize: 11, fontWeight: 700, color: "#6EE7B7", textTransform: "uppercase", letterSpacing: "0.07em", borderBottom: "1px solid #064E3B" }}>Open Purchase Orders — {pos.length} line{pos.length !== 1 ? "s" : ""}</div>
                  {Object.keys(poByStore).length > 1 && (
                    <div style={{ padding: "6px 14px", borderBottom: "1px solid #1a2030", display: "flex", gap: 12, flexWrap: "wrap" }}>
                      {Object.entries(poByStore).map(([st, qty]) => (
                        <span key={st} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11 }}>{storeTag(st)}<span style={{ color: "#10B981", fontFamily: "monospace", fontWeight: 600 }}>+{qty.toLocaleString()}</span></span>
                      ))}
                    </div>
                  )}
                  {pos.map((p, i) => (
                    <div key={i} style={{ padding: "8px 14px", borderBottom: "1px solid #1a2030", fontSize: 12, cursor: p.poNumber ? "pointer" : "default" }}
                      title={p.poNumber ? "Click to open PO in PO WIP" : undefined}
                      onClick={() => { if (p.poNumber) { window.open(`/tanda?po=${encodeURIComponent(p.poNumber)}`, "_blank"); setSummaryCtx(null); } }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                        <span style={{ color: "#FCD34D", fontFamily: "monospace", fontWeight: 700, textDecoration: p.poNumber ? "underline" : "none", textUnderlineOffset: 2 }}>{p.poNumber || "—"}</span>
                        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>{p.store && storeTag(p.store)}<span style={{ color: "#10B981", fontWeight: 700 }}>+{p.qty.toLocaleString()} units</span></span>
                      </div>
                      <div style={{ color: "#CBD5E1", marginBottom: 2 }}>{p.vendor || "—"}</div>
                      <div style={{ display: "flex", gap: 16 }}>
                        <span style={{ color: "#94A3B8", fontSize: 11 }}>Expected: {fmtDateDisplay(p.date)}</span>
                        {p.unitCost > 0 && <span style={{ color: "#94A3B8", fontSize: 11 }}>Unit Cost: ${p.unitCost.toFixed(2)}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {/* Down arrow (flipped, popup above cell) — hidden by default */}
            <div data-arrow="down" style={{ position: "relative", height: 8, overflow: "visible", display: "none" }}>
              <div style={{ position: "absolute", top: 0, left: 20, width: 0, height: 0, borderLeft: "9px solid transparent", borderRight: "9px solid transparent", borderTop: "9px solid #334155", pointerEvents: "none" }} />
              <div style={{ position: "absolute", top: 0, left: 21, width: 0, height: 0, borderLeft: "8px solid transparent", borderRight: "8px solid transparent", borderTop: "8px solid #1E293B", pointerEvents: "none" }} />
            </div>
          </div>
        );
      })()}

      {/* RIGHT-CLICK CONTEXT MENU */}
      {ctxMenu && (
        <div
          ref={ctxRef}
          style={{ position: "fixed", left: ctxMenu.x, top: ctxMenu.y, zIndex: 500, minWidth: 260, maxWidth: 380, filter: "drop-shadow(0 8px 24px rgba(0,0,0,0.55))" }}
          onClick={e => e.stopPropagation()}
        >
          {/* Caret arrow — sits outside the clipped inner box so it's visible */}
          {!ctxMenu.flipped ? (
            <div style={{ position: "relative", height: 8, overflow: "visible" }}>
              <div style={{ position: "absolute", top: 0, left: ctxMenu.arrowLeft, width: 0, height: 0, borderLeft: "9px solid transparent", borderRight: "9px solid transparent", borderBottom: "9px solid #334155", pointerEvents: "none" }} />
              <div style={{ position: "absolute", top: 1, left: ctxMenu.arrowLeft + 1, width: 0, height: 0, borderLeft: "8px solid transparent", borderRight: "8px solid transparent", borderBottom: "8px solid #1E293B", pointerEvents: "none" }} />
            </div>
          ) : null}
          {/* Inner box — overflow hidden for rounded corners, does not clip the caret */}
          <div style={{ background: "#1E293B", border: "1px solid #334155", borderRadius: 10, overflow: "hidden" }}>
          {/* Close button + On Hand */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 14px 6px 14px", borderBottom: "1px solid #1a2030" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 8,
                background: ctxMenu.skuStore === "PT" ? "rgba(139,92,246,0.2)" : "rgba(59,130,246,0.2)",
                color:      ctxMenu.skuStore === "PT" ? "#c4b5fd"              : "#93c5fd" }}>
                {ctxMenu.skuStore}
              </span>
              <span style={{ color: "#94A3B8", fontSize: 11 }}>On Hand:</span>
              <span style={{ color: "#F1F5F9", fontFamily: "monospace", fontWeight: 700, fontSize: 12 }}>{ctxMenu.onHand.toLocaleString()}</span>
            </div>
            <button
              style={{ background: "none", border: "none", color: "#475569", fontSize: 16, cursor: "pointer", lineHeight: 1, padding: "2px 4px", borderRadius: 4 }}
              onClick={() => setCtxMenu(null)}
              title="Close"
            >✕</button>
          </div>
          {ctxMenu.sos.length > 0 && (
            <div>
              <div style={{ background: "rgba(59,130,246,0.15)", padding: "7px 14px", fontSize: 11, fontWeight: 700, color: "#93C5FD", textTransform: "uppercase", letterSpacing: "0.07em", borderBottom: "1px solid #1E3A5F" }}>
                Sales Orders ({ctxMenu.sos.length})
              </div>
              {ctxMenu.sos.map((s, i) => (
                <div key={i} style={{ padding: "8px 14px", borderBottom: "1px solid #1a2030", fontSize: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                    <span style={{ color: "#60A5FA", fontFamily: "monospace", fontWeight: 700 }}>{s.orderNumber || "—"}</span>
                    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      {s.store && <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 8, background: s.store === "ROF ECOM" ? "rgba(14,165,233,0.2)" : s.store === "PT" ? "rgba(139,92,246,0.2)" : "rgba(59,130,246,0.2)", color: s.store === "ROF ECOM" ? "#7dd3fc" : s.store === "PT" ? "#c4b5fd" : "#93c5fd" }}>{s.store}</span>}
                      <span style={{ color: "#10B981", fontWeight: 700 }}>{s.qty.toLocaleString()} units</span>
                    </span>
                  </div>
                  <div style={{ color: "#CBD5E1", marginBottom: 2 }}>{s.customerName || "—"}</div>
                  <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                    <span style={{ color: "#94A3B8", fontSize: 11 }}>Cancel: {fmtDateDisplay(s.date)}</span>
                    <span style={{ color: "#94A3B8", fontSize: 11 }}>Unit: ${s.unitPrice?.toFixed(2) ?? "—"}</span>
                    <span style={{ color: "#94A3B8", fontSize: 11 }}>Total: ${s.totalPrice?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) ?? "—"}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
          {ctxMenu.pos.length > 0 && (
            <div>
              <div style={{ background: "rgba(245,158,11,0.15)", padding: "7px 14px", fontSize: 11, fontWeight: 700, color: "#FCD34D", textTransform: "uppercase", letterSpacing: "0.07em", borderBottom: "1px solid #3D2E00" }}>
                Purchase Orders ({ctxMenu.pos.length})
              </div>
              {ctxMenu.pos.map((p, i) => (
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
                    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      {p.store && <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 8, background: p.store === "ROF ECOM" ? "rgba(14,165,233,0.2)" : p.store === "PT" ? "rgba(139,92,246,0.2)" : "rgba(245,158,11,0.2)", color: p.store === "ROF ECOM" ? "#7dd3fc" : p.store === "PT" ? "#c4b5fd" : "#fcd34d" }}>{p.store}</span>}
                      <span style={{ color: "#10B981", fontWeight: 700 }}>+{p.qty.toLocaleString()} units</span>
                    </span>
                  </div>
                  <div style={{ color: "#CBD5E1", marginBottom: 2 }}>{p.vendor || "—"}</div>
                  <div style={{ display: "flex", gap: 16 }}>
                    <span style={{ color: "#94A3B8", fontSize: 11 }}>Expected: {fmtDateDisplay(p.date)}</span>
                    {p.unitCost > 0 && <span style={{ color: "#94A3B8", fontSize: 11 }}>Unit Cost: ${p.unitCost.toFixed(2)}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
          </div>{/* end inner clipped box */}
          {/* Down-arrow caret when popup is flipped above the cell */}
          {ctxMenu.flipped && (
            <div style={{ position: "relative", height: 8, overflow: "visible" }}>
              <div style={{ position: "absolute", top: 0, left: ctxMenu.arrowLeft, width: 0, height: 0, borderLeft: "9px solid transparent", borderRight: "9px solid transparent", borderTop: "9px solid #334155", pointerEvents: "none" }} />
              <div style={{ position: "absolute", top: 0, left: ctxMenu.arrowLeft + 1, width: 0, height: 0, borderLeft: "8px solid transparent", borderRight: "8px solid transparent", borderTop: "8px solid #1E293B", pointerEvents: "none" }} />
            </div>
          )}
        </div>
      )}

      {/* UPLOAD WARNINGS CONFIRMATION MODAL */}
      {uploadWarnings && pendingUploadData && (
        <div style={S.modalOverlay}>
          <div style={{ ...S.modal, width: 560, border: "1px solid #F59E0B" }} onClick={e => e.stopPropagation()}>
            <div style={{ ...S.modalHeader, borderBottom: "1px solid #78350f" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 32, height: 32, borderRadius: 8, background: "rgba(245,158,11,0.15)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>⚠</div>
                <div>
                  <h2 style={{ ...S.modalTitle, color: "#FCD34D", margin: 0 }}>Review Data Issues</h2>
                  <div style={{ color: "#94A3B8", fontSize: 12, marginTop: 2 }}>
                    {pendingUploadData.skus.length.toLocaleString()} SKUs · {pendingUploadData.pos.length.toLocaleString()} PO lines · {pendingUploadData.sos.length.toLocaleString()} SO lines parsed
                  </div>
                </div>
              </div>
            </div>
            <div style={S.modalBody}>
              <p style={{ color: "#CBD5E1", fontSize: 13, marginBottom: 16 }}>
                The following issues were found in your files. Review them before deciding whether to proceed.
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 24 }}>
                {uploadWarnings.map((w, i) => (
                  <div key={i} style={{
                    background: w.severity === "error" ? "rgba(239,68,68,0.08)" : "rgba(245,158,11,0.08)",
                    border: `1px solid ${w.severity === "error" ? "rgba(239,68,68,0.3)" : "rgba(245,158,11,0.3)"}`,
                    borderRadius: 8, padding: "10px 14px",
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 14 }}>{w.severity === "error" ? "✗" : "△"}</span>
                      <span style={{ color: w.severity === "error" ? "#FCA5A5" : "#FCD34D", fontWeight: 700, fontSize: 13 }}>{w.field}</span>
                      <span style={{ marginLeft: "auto", color: w.severity === "error" ? "#FCA5A5" : "#FCD34D", fontFamily: "monospace", fontSize: 12, fontWeight: 700 }}>
                        {w.affected.toLocaleString()} / {w.total.toLocaleString()}
                      </span>
                    </div>
                    <div style={{ color: "#94A3B8", fontSize: 12, lineHeight: 1.5, paddingLeft: 22 }}>{w.message}</div>
                  </div>
                ))}
              </div>
              {pendingUploadData.columnNames && (
                <details style={{ marginBottom: 18 }}>
                  <summary style={{ color: "#60A5FA", fontSize: 12, cursor: "pointer", userSelect: "none" }}>
                    Show detected column names (click to expand)
                  </summary>
                  <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                    {(["purchases", "orders"] as const).map(file => (
                      <div key={file} style={{ background: "#0F172A", borderRadius: 6, padding: "8px 12px", border: "1px solid #334155" }}>
                        <div style={{ color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4, fontWeight: 600 }}>
                          {file === "purchases" ? "Purchases (PO) file" : "Orders (SO) file"}
                        </div>
                        <div style={{ color: "#94A3B8", fontSize: 11, fontFamily: "monospace", lineHeight: 1.8 }}>
                          {pendingUploadData.columnNames![file].join(" · ")}
                        </div>
                      </div>
                    ))}
                  </div>
                </details>
              )}
              <div style={{ display: "flex", gap: 10 }}>
                <button
                  style={{ flex: 1, background: "none", border: "1px solid #475569", color: "#94A3B8", borderRadius: 8, padding: "10px 0", fontSize: 13, cursor: "pointer", fontWeight: 600 }}
                  onClick={() => { setUploadWarnings(null); setPendingUploadData(null); }}
                >
                  Cancel — Go Back
                </button>
                <button
                  style={{ flex: 2, background: "#F59E0B", border: "none", color: "#0F172A", borderRadius: 8, padding: "10px 0", fontSize: 13, cursor: "pointer", fontWeight: 700 }}
                  onClick={() => saveUploadData(pendingUploadData)}
                >
                  Upload Anyway
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* UPLOAD PROGRESS OVERLAY */}
      {uploadProgress && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "#1E293B", borderRadius: 14, padding: "28px 32px", width: 380, border: "1px solid #334155" }}>
            <div style={{ fontWeight: 700, fontSize: 16, color: "#F1F5F9", marginBottom: 8 }}>Uploading…</div>
            <div style={{ fontSize: 13, color: "#94A3B8", marginBottom: 20 }}>{uploadProgress.step}</div>
            <div style={{ background: "#0F172A", borderRadius: 8, height: 10, overflow: "hidden", marginBottom: 20 }}>
              <div style={{ height: "100%", borderRadius: 8, background: "linear-gradient(90deg,#10B981,#3B82F6)", width: `${uploadProgress.pct}%`, transition: "width 0.4s ease" }} />
            </div>
            <button
              style={{ background: "none", border: "1px solid #EF4444", color: "#EF4444", borderRadius: 6, padding: "7px 18px", fontSize: 13, cursor: "pointer", width: "100%" }}
              onClick={cancelUpload}
            >
              Cancel Upload
            </button>
          </div>
        </div>
      )}

      {/* SUCCESS TOAST */}
      {uploadSuccess && (
        <div style={{ position: "fixed", bottom: 28, left: "50%", transform: "translateX(-50%)", background: "#064e3b", border: "1px solid #10B981", borderRadius: 10, padding: "12px 24px", color: "#6ee7b7", fontSize: 14, fontWeight: 600, zIndex: 300, display: "flex", alignItems: "center", gap: 10, boxShadow: "0 4px 24px rgba(0,0,0,0.4)" }}>
          <span style={{ fontSize: 18 }}>✓</span>
          {uploadSuccess}
          <button style={{ background: "none", border: "none", color: "#6ee7b7", cursor: "pointer", fontSize: 16, marginLeft: 8 }} onClick={() => setUploadSuccess(null)}>✕</button>
        </div>
      )}

      {/* SYNC ERROR MODAL */}
      {syncError && (
        <div style={S.modalOverlay} onClick={() => setSyncError(null)}>
          <div style={{ ...S.modal, width: 460, border: "1px solid #EF4444" }} onClick={e => e.stopPropagation()}>
            <div style={{ ...S.modalHeader, borderBottom: "1px solid #7f1d1d" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 32, height: 32, borderRadius: 8, background: "rgba(239,68,68,0.15)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>⚠</div>
                <h2 style={{ ...S.modalTitle, color: "#FCA5A5" }}>{syncError.title}</h2>
              </div>
              <button style={S.closeBtn} onClick={() => setSyncError(null)}>✕</button>
            </div>
            <div style={{ ...S.modalBody, paddingTop: 20 }}>
              <p style={{ color: "#F1F5F9", fontSize: 14, marginBottom: 16, lineHeight: 1.6 }}>
                {syncError.detail}
              </p>
              <div style={{ background: "#0F172A", borderRadius: 8, padding: "10px 14px", marginBottom: 20, border: "1px solid #334155" }}>
                <div style={{ color: "#6B7280", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6, fontWeight: 600 }}>What to check</div>
                <div style={{ color: "#94A3B8", fontSize: 12, lineHeight: 1.8 }}>
                  • Verify <span style={{ color: "#60A5FA", fontFamily: "monospace" }}>VITE_XORO_API_KEY</span> and <span style={{ color: "#60A5FA", fontFamily: "monospace" }}>VITE_XORO_API_SECRET</span> are set in Vercel<br/>
                  • Confirm Xoro API access is enabled for your account<br/>
                  • Check the browser console for the full error trace
                </div>
              </div>
              <button
                style={{ ...S.navBtnPrimary, width: "100%", justifyContent: "center", padding: "10px 0" }}
                onClick={() => setSyncError(null)}
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}

      {/* UPLOAD ERROR MODAL */}
      {uploadError && (
        <div style={S.modalOverlay} onClick={() => setUploadError(null)}>
          <div style={{ ...S.modal, width: 440, border: "1px solid #EF4444" }} onClick={e => e.stopPropagation()}>
            <div style={{ ...S.modalHeader, borderBottom: "1px solid #7f1d1d" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 32, height: 32, borderRadius: 8, background: "rgba(239,68,68,0.15)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>⚠</div>
                <h2 style={{ ...S.modalTitle, color: "#FCA5A5" }}>Upload Failed</h2>
              </div>
              <button style={S.closeBtn} onClick={() => setUploadError(null)}>✕</button>
            </div>
            <div style={{ ...S.modalBody, paddingTop: 20 }}>
              <p style={{ color: "#F1F5F9", fontSize: 14, marginBottom: 20, lineHeight: 1.6 }}>{uploadError}</p>
              <button style={{ ...S.navBtnPrimary, width: "100%", justifyContent: "center", padding: "10px 0" }} onClick={() => setUploadError(null)}>Dismiss</button>
            </div>
          </div>
        </div>
      )}

      {/* UPLOAD MODAL */}
      {showUpload && (
        <div style={S.modalOverlay} onClick={() => setShowUpload(false)}>
          <div style={{ ...S.modal, width: 560 }} onClick={e => e.stopPropagation()}>
            <div style={S.modalHeader}>
              <h2 style={S.modalTitle}>Upload Excel Files</h2>
              <button style={S.closeBtn} onClick={() => setShowUpload(false)}>✕</button>
            </div>
            <div style={S.modalBody}>
              <p style={{ color: "#9CA3AF", fontSize: 13, marginBottom: 20 }}>
                Upload all three Xoro report exports to compute Available to Sell. All files are required before processing.
              </p>

              {/* File slot helper */}
              {(
                [
                  { label: "Inventory Snapshot", sub: "On-hand quantities by SKU", key: "inv", file: invFile, setFile: setInvFile, ref: invRef, color: "#10B981" },
                  { label: "Purchased Items Report", sub: "Optional — PO data pulled from PO WIP if skipped", key: "pur", file: purFile, setFile: setPurFile, ref: purRef, color: "#3B82F6" },
                  { label: "All Orders Report", sub: "Sales orders by ship date (outgoing)", key: "ord", file: ordFile, setFile: setOrdFile, ref: ordRef, color: "#F59E0B" },
                ] as Array<{ label: string; sub: string; key: string; file: File | null; setFile: (f: File | null) => void; ref: React.RefObject<HTMLInputElement>; color: string }>
              ).map(slot => (
                <div key={slot.key} style={{ marginBottom: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    <div style={{ width: 10, height: 10, borderRadius: 2, background: slot.color, flexShrink: 0 }} />
                    <span style={{ color: "#F1F5F9", fontWeight: 600, fontSize: 13 }}>{slot.label}</span>
                    <span style={{ color: "#6B7280", fontSize: 12 }}>{slot.sub}</span>
                  </div>
                  <div
                    style={{
                      ...S.dropZone,
                      padding: "14px 16px",
                      borderColor: slot.file ? slot.color : "#334155",
                      background: slot.file ? `${slot.color}10` : "transparent",
                      display: "flex", alignItems: "center", gap: 12,
                    }}
                    onClick={() => slot.ref.current?.click()}
                    onDragOver={e => e.preventDefault()}
                    onDrop={e => {
                      e.preventDefault();
                      const f = e.dataTransfer.files[0];
                      if (f) slot.setFile(f);
                    }}
                  >
                    <span style={{ fontSize: 20, flexShrink: 0 }}>{slot.file ? "✓" : "↑"}</span>
                    {slot.file ? (
                      <div style={{ flex: 1, overflow: "hidden" }}>
                        <div style={{ color: slot.color, fontWeight: 600, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{slot.file.name}</div>
                        <div style={{ color: "#6B7280", fontSize: 11 }}>{(slot.file.size / 1024).toFixed(0)} KB</div>
                      </div>
                    ) : (
                      <div style={{ flex: 1 }}>
                        <div style={{ color: "#D1D5DB", fontSize: 13 }}>Drop file or click to browse</div>
                        <div style={{ color: "#475569", fontSize: 11 }}>.xlsx</div>
                      </div>
                    )}
                    {slot.file && (
                      <button
                        style={{ background: "none", border: "none", color: "#6B7280", cursor: "pointer", fontSize: 14, flexShrink: 0 }}
                        onClick={e => { e.stopPropagation(); slot.setFile(null); }}
                      >✕</button>
                    )}
                    <input
                      ref={slot.ref}
                      type="file"
                      accept=".xlsx,.xls"
                      style={{ display: "none" }}
                      onChange={e => { const f = e.target.files?.[0]; if (f) slot.setFile(f); }}
                    />
                  </div>
                </div>
              ))}

              <button
                style={{
                  ...S.navBtnPrimary,
                  width: "100%", justifyContent: "center", padding: "11px 0", marginTop: 8, fontSize: 14,
                  opacity: (invFile && ordFile) ? 1 : 0.4,
                  cursor: (invFile && purFile && ordFile) ? "pointer" : "not-allowed",
                }}
                disabled={!(invFile && ordFile)}
                onClick={() => {
                  if (invFile && ordFile) {
                    setShowUpload(false);
                    handleFileUpload(invFile, purFile, ordFile);
                  }
                }}
              >
                {invFile && ordFile ? `Process Files →${!purFile ? " (PO data from PO WIP)" : ""}` : `Select required files (${[invFile, ordFile].filter(Boolean).length}/2 ready)`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  function StatCard({ icon, label, value, color, sortKey, activeSort, onSort, fmt, marginPct }: {
    icon: string; label: string; value: number; color: string;
    sortKey?: string; activeSort?: string | null; onSort?: (k: string | null) => void;
    fmt?: "dollar" | "margin"; marginPct?: number;
  }) {
    const isActive = !!(sortKey && activeSort === sortKey);
    let display: string;
    if (fmt === "dollar") {
      display = value >= 1000 ? `$${(value / 1000).toFixed(1)}k` : `$${value.toFixed(0)}`;
      if (value >= 1000000) display = `$${(value / 1000000).toFixed(2)}M`;
    } else if (fmt === "margin") {
      display = value >= 1000000 ? `$${(value / 1000000).toFixed(2)}M` : value >= 1000 ? `$${(value / 1000).toFixed(1)}k` : `$${value.toFixed(0)}`;
    } else {
      display = value.toLocaleString();
    }
    return (
      <div
        style={{ ...S.statCard, borderTop: `2px solid ${color}`, cursor: sortKey ? "pointer" : "default",
          outline: isActive ? `2px solid ${color}` : "none", outlineOffset: -2,
          background: isActive ? `${color}18` : "#1E293B" }}
        onClick={() => sortKey && onSort && onSort(isActive ? null : sortKey)}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <span style={{ fontSize: 11, color: "#9CA3AF", lineHeight: 1.3 }}>{label}</span>
          <span style={{ fontSize: 14, color, opacity: 0.7 }}>{icon}</span>
        </div>
        <div style={{ fontSize: 22, fontWeight: 700, color, fontFamily: "monospace", marginTop: 4, lineHeight: 1.2 }}>
          {display}
        </div>
        {fmt === "margin" && marginPct != null && (
          <div style={{ fontSize: 11, color, opacity: 0.75, fontFamily: "monospace" }}>
            {(marginPct * 100).toFixed(1)}%
          </div>
        )}
      </div>
    );
  }
}

// ── Styles ────────────────────────────────────────────────────────────────────
const S: Record<string, React.CSSProperties> = {
  app:         { minHeight: "100vh", background: "#0F172A", color: "#F1F5F9", fontFamily: "'DM Sans','Segoe UI',sans-serif" },

  nav:         { background: "#1E293B", borderBottom: "1px solid #334155", padding: "0 24px", display: "flex", alignItems: "center", justifyContent: "space-between", height: 56, position: "sticky", top: 0, zIndex: 100 },
  navLeft:     { display: "flex", alignItems: "center", gap: 12 },
  navLogo:     { width: 32, height: 32, borderRadius: 8, background: "linear-gradient(135deg,#10B981,#3B82F6)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 800, fontSize: 12, letterSpacing: "-0.5px" },
  navTitle:    { fontWeight: 700, fontSize: 16, color: "#F1F5F9" },
  navSub:      { fontSize: 12, color: "#6B7280" },
  navRight:    { display: "flex", alignItems: "center", gap: 8 },
  navBtn:      { background: "none", border: "1px solid #334155", color: "#94A3B8", borderRadius: 6, padding: "5px 12px", fontSize: 13, cursor: "pointer", textDecoration: "none", display: "inline-flex", alignItems: "center" },
  navBtnPrimary: { background: "linear-gradient(135deg,#10B981,#3B82F6)", border: "none", color: "#fff", borderRadius: 6, padding: "5px 14px", fontSize: 13, cursor: "pointer", fontWeight: 600 },

  demoBanner:  { background: "#78350F", color: "#FCD34D", padding: "8px 24px", fontSize: 13 },

  content:     { maxWidth: 1600, margin: "0 auto", padding: "20px" },

  statsRow:    { display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 16 },
  statCard:    { background: "#1E293B", borderRadius: 10, padding: "16px 18px", display: "flex", flexDirection: "column", gap: 4 },

  toolbar:     { display: "flex", gap: 10, alignItems: "center", marginBottom: 12, flexWrap: "wrap" },
  searchInput: { background: "#1E293B", border: "1px solid #334155", borderRadius: 8, padding: "8px 14px", color: "#F1F5F9", fontSize: 13, outline: "none", width: 240, boxSizing: "border-box" as const },
  select:      { background: "#1E293B", border: "1px solid #334155", borderRadius: 8, padding: "8px 10px", color: "#F1F5F9", fontSize: 13, outline: "none", cursor: "pointer" },
  datePicker:  { display: "flex", alignItems: "center", gap: 6 },
  dateLabel:   { fontSize: 12, color: "#6B7280", whiteSpace: "nowrap" as const },
  dateInput:   { background: "#1E293B", border: "1px solid #334155", borderRadius: 8, padding: "7px 10px", color: "#F1F5F9", fontSize: 13, outline: "none" },

  legend:      { display: "flex", gap: 16, marginBottom: 10, alignItems: "center", flexWrap: "wrap" as const },
  legendItem:  { display: "flex", alignItems: "center", gap: 5 },

  tableWrap:   { overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 300px)", borderRadius: 10, border: "1px solid #334155", background: "#0F172A" },
  table:       { borderCollapse: "collapse" as const, width: "100%", fontSize: 13 },
  th:          { background: "#1E293B", color: "#6B7280", fontWeight: 600, fontSize: 11, textTransform: "uppercase" as const, letterSpacing: "0.05em", padding: "10px 12px", borderBottom: "1px solid #334155", borderRight: "1px solid #1a2030", whiteSpace: "nowrap" as const, position: "sticky" as const, top: 0, zIndex: 2 },
  td:          { padding: "7px 10px", borderBottom: "1px solid #1a2030", borderRight: "1px solid #1a2030", whiteSpace: "nowrap" as const, verticalAlign: "middle" as const },
  stickyCol:   { position: "sticky" as const, zIndex: 2, borderRight: "1px solid #334155" },

  loadingState:{ textAlign: "center" as const, padding: 60, color: "#6B7280", background: "#1E293B", borderRadius: 10 },
  emptyState:  { textAlign: "center" as const, padding: 60, color: "#6B7280", background: "#1E293B", borderRadius: 10 },

  modalOverlay:{ position: "fixed" as const, inset: 0, background: "rgba(0,0,0,.75)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center" },
  modal:       { background: "#1E293B", borderRadius: 14, width: 500, maxHeight: "80vh", overflow: "hidden", display: "flex", flexDirection: "column" as const, border: "1px solid #334155" },
  modalHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 20px", borderBottom: "1px solid #334155" },
  modalTitle:  { margin: 0, fontSize: 17, fontWeight: 700, color: "#F1F5F9" },
  modalBody:   { padding: 20, overflowY: "auto" as const },
  closeBtn:    { background: "none", border: "none", color: "#6B7280", fontSize: 18, cursor: "pointer", lineHeight: 1 },

  dropZone:    { border: "2px dashed #334155", borderRadius: 10, padding: "32px 20px", textAlign: "center" as const, cursor: "pointer", transition: "border-color 0.2s" },
};
