import { useState, useEffect, useCallback, useRef } from "react";

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
  dates: Record<string, number>;
  onOrder: number;
  onHand: number;
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
interface ATSSkuData   { sku: string; description: string; category?: string; onHand: number; onOrder: number; }
interface ATSEventData { sku: string; date: string; qty: number; }
interface ExcelData    { syncedAt: string; skus: ATSSkuData[]; pos: ATSEventData[]; sos: ATSEventData[]; }

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

// ── Mock data for initial load ─────────────────────────────────────────────
function generateMockData(dates: string[]): ATSRow[] {
  const skus = [
    { sku: "DENIM-BLU-32", description: "Blue Denim Jeans 32W", category: "Denim" },
    { sku: "DENIM-BLK-32", description: "Black Denim Jeans 32W", category: "Denim" },
    { sku: "DENIM-GRY-34", description: "Grey Denim Jeans 34W", category: "Denim" },
    { sku: "TEE-WHT-S",    description: "White Tee Small",       category: "Tops" },
    { sku: "TEE-WHT-M",    description: "White Tee Medium",      category: "Tops" },
    { sku: "TEE-BLK-M",    description: "Black Tee Medium",      category: "Tops" },
    { sku: "JKT-BLU-M",    description: "Blue Jacket Medium",    category: "Outerwear" },
    { sku: "JKT-BLK-L",    description: "Black Jacket Large",    category: "Outerwear" },
    { sku: "COAT-BRN-M",   description: "Brown Wool Coat Medium",category: "Outerwear" },
    { sku: "VEST-BLK-M",   description: "Black Vest Medium",     category: "Basics" },
    { sku: "SOCK-WHT-OS",  description: "White Socks One Size",  category: "Basics" },
    { sku: "BELT-BRN-M",   description: "Brown Belt Medium",     category: "Basics" },
  ];
  return skus.map(s => {
    let qty = Math.floor(Math.random() * 200) + 10;
    const onHand = qty;
    const onOrder = Math.floor(Math.random() * 100);
    const dateMap: Record<string, number> = {};
    dates.forEach((d, i) => {
      qty = Math.max(0, qty - Math.floor(Math.random() * 12));
      if (i % 7 === 3) qty += Math.floor(Math.random() * 40); // restock
      dateMap[d] = qty;
    });
    return { ...s, dates: dateMap, onHand, onOrder };
  });
}

// ── Compute ATS rows from compact Excel data ─────────────────────────────────
function computeRowsFromExcelData(data: ExcelData, dates: string[]): ATSRow[] {
  return data.skus.map(s => {
    const skuPos = data.pos.filter(p => p.sku === s.sku);
    const skuSos = data.sos.filter(o => o.sku === s.sku);
    let ats = s.onHand;
    const dateMap: Record<string, number> = {};
    for (const date of dates) {
      ats += skuPos.filter(p => p.date === date).reduce((sum, p) => sum + p.qty, 0);
      ats -= skuSos.filter(o => o.date === date).reduce((sum, o) => sum + o.qty, 0);
      if (ats < 0) ats = 0;
      dateMap[date] = ats;
    }
    return { sku: s.sku, description: s.description, category: s.category, onHand: s.onHand, onOrder: s.onOrder, dates: dateMap };
  });
}

// ── Export helpers ─────────────────────────────────────────────────────────
function exportToCSV(rows: ATSRow[], dates: string[]) {
  const header = ["SKU", "Description", "Category", "On Hand", "On Order", ...dates.map(fmtDateShort)];
  const lines = [header.join(",")];
  rows.forEach(r => {
    const cells = [
      r.sku, `"${r.description}"`, r.category ?? "",
      r.onHand, r.onOrder,
      ...dates.map(d => r.dates[d] ?? ""),
    ];
    lines.push(cells.join(","));
  });
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ATS_Report_${fmtDate(new Date())}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function ATSReport() {
  const today = new Date();
  const [startDate, setStartDate] = useState(fmtDate(today));
  const [numDays, setNumDays] = useState(14);
  const [search, setSearch] = useState("");
  const [filterCategory, setFilterCategory] = useState("All");
  const [filterStatus, setFilterStatus] = useState("All"); // All, Low, Out, InStock
  const [rows, setRows] = useState<ATSRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [mockMode, setMockMode] = useState(true);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ step: string; pct: number } | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState("");
  const [lastSync, setLastSync] = useState("");
  const [syncError, setSyncError] = useState<{ title: string; detail: string } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
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
  const cancelRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);

  // ── Compute date range ──────────────────────────────────────────────────
  const dates = Array.from({ length: numDays }, (_, i) =>
    fmtDate(addDays(new Date(startDate + "T00:00:00"), i))
  );

  // ── Load data ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (mockMode) {
      setRows(generateMockData(dates));
    } else if (excelData) {
      setRows(computeRowsFromExcelData(excelData, dates));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mockMode, startDate, numDays, excelData]);

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
            map[snap.sku] = { sku: snap.sku, description: snap.description, category: snap.category, dates: {}, onHand: snap.qty_on_hand, onOrder: snap.qty_on_order };
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

  async function handleFileUpload(inv: File, pur: File, ord: File) {
    setUploadingFile(true);
    setShowUpload(false);
    cancelRef.current = false;
    abortRef.current = new AbortController();
    try {
      setUploadProgress({ step: "Parsing files…", pct: 15 });
      const formData = new FormData();
      formData.append("inventory", inv);
      formData.append("purchases", pur);
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
      setUploadProgress({ step: `Saving ${data.skus.length.toLocaleString()} SKUs…`, pct: 70 });
      // Store compact data as single app_data record — always overwrites previous Excel upload
      const saveRes = await fetch(`${SB_URL}/rest/v1/app_data`, {
        method: "POST",
        headers: { ...SB_HEADERS, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ key: "ats_excel_data", value: JSON.stringify(data) }),
        signal: abortRef.current.signal,
      });
      if (!saveRes.ok) throw new Error("Failed to save data to database");
      if (cancelRef.current) return;
      setUploadProgress({ step: "Computing ATS…", pct: 92 });
      setExcelData(data);
      setRows(computeRowsFromExcelData(data, dates));
      setLastSync(data.syncedAt);
      setMockMode(false);
      setInvFile(null); setPurFile(null); setOrdFile(null);
      setUploadProgress(null);
      setUploadSuccess(`${data.skus.length.toLocaleString()} SKUs uploaded successfully`);
      setTimeout(() => setUploadSuccess(null), 6000);
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

  function cancelUpload() {
    cancelRef.current = true;
    abortRef.current?.abort();
    setUploadingFile(false);
    setUploadProgress(null);
  }

  // ── Filtering ──────────────────────────────────────────────────────────
  const categories = ["All", ...Array.from(new Set(rows.map(r => r.category ?? "Uncategorized"))).sort()];

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
    return matchSearch && matchCat && matchStatus;
  });

  // ── Summary stats ──────────────────────────────────────────────────────
  const todayKey = fmtDate(today);
  const outOfStock   = rows.filter(r => (r.dates[todayKey] ?? r.onHand) <= 0).length;
  const lowStock     = rows.filter(r => { const q = r.dates[todayKey] ?? r.onHand; return q > 0 && q <= 10; }).length;
  const totalOnOrder = rows.reduce((s, r) => s + r.onOrder, 0);
  const totalSKUs    = rows.length;

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div style={S.app}>
      {/* NAV */}
      <nav style={S.nav}>
        <div style={S.navLeft}>
          <div style={S.navLogo}>ATS</div>
          <span style={S.navTitle}>ATS Report</span>
          <span style={S.navSub}>Available to Sell</span>
        </div>
        <div style={S.navRight}>
          <button
            style={{ ...S.navBtn, color: mockMode ? "#F59E0B" : "#94A3B8", borderColor: mockMode ? "#F59E0B" : "#334155" }}
            onClick={() => { setMockMode(m => !m); if (mockMode) loadFromSupabase(); }}
          >
            {mockMode ? "Demo ON" : "Demo"}
          </button>
          <button style={S.navBtn} onClick={() => setShowUpload(true)} disabled={uploadingFile}>
            {uploadingFile ? "Uploading…" : "Upload Excel"}
            {!uploadingFile && (invFile || purFile || ordFile) && (
              <span style={{ marginLeft: 6, background: "#10B981", color: "#fff", borderRadius: 10, padding: "1px 6px", fontSize: 11, fontWeight: 700 }}>
                {[invFile, purFile, ordFile].filter(Boolean).length}/3
              </span>
            )}
          </button>
          <button style={S.navBtn} onClick={syncFromXoro} disabled={syncing}>
            {syncing ? (syncStatus || "Syncing…") : "Sync Xoro"}
          </button>
          <button
            style={S.navBtnPrimary}
            onClick={() => exportToCSV(filtered, dates)}
          >
            Export CSV
          </button>
          <a href="/" style={{ ...S.navBtn, textDecoration: "none" }}>← PLM Home</a>
        </div>
      </nav>

      {/* BANNER */}
      {mockMode && (
        <div style={S.demoBanner}>
          Demo mode — showing sample data. Upload an Excel file or sync from Xoro to load real inventory.
        </div>
      )}

      <div style={S.content}>
        {/* STAT CARDS */}
        <div style={S.statsRow}>
          <StatCard icon="▦" label="Total SKUs"    value={totalSKUs}    color="#3B82F6" />
          <StatCard icon="▽" label="Out of Stock"  value={outOfStock}   color="#EF4444" />
          <StatCard icon="△" label="Low Stock (≤10)" value={lowStock}   color="#F59E0B" />
          <StatCard icon="↑" label="Units on Order" value={totalOnOrder} color="#10B981" />
        </div>

        {/* TOOLBAR */}
        <div style={S.toolbar}>
          <input
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
            <label style={S.dateLabel}>Days</label>
            <select style={S.select} value={numDays} onChange={e => setNumDays(Number(e.target.value))}>
              {[7, 14, 21, 30, 60].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <div style={{ color: "#6B7280", fontSize: 12, whiteSpace: "nowrap" }}>
            {filtered.length} SKUs
            {lastSync && <span style={{ display: "block" }}>Synced {new Date(lastSync).toLocaleTimeString()}</span>}
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
                  <th style={{ ...S.th, ...S.stickyCol, left: 0, minWidth: 130, zIndex: 3 }}>SKU</th>
                  <th style={{ ...S.th, ...S.stickyCol, left: 130, minWidth: 200, zIndex: 3 }}>Description</th>
                  <th style={{ ...S.th, ...S.stickyCol, left: 330, minWidth: 80, zIndex: 3, textAlign: "center" }}>On Hand</th>
                  <th style={{ ...S.th, ...S.stickyCol, left: 410, minWidth: 80, zIndex: 3, textAlign: "center" }}>On Order</th>
                  {/* Date columns */}
                  {dates.map(d => (
                    <th key={d} style={{
                      ...S.th,
                      minWidth: 68,
                      textAlign: "center",
                      background: isToday(d) ? "#1a2a1e" : isWeekend(d) ? "#141e2e" : "#1E293B",
                      color: isToday(d) ? "#10B981" : isWeekend(d) ? "#475569" : "#6B7280",
                      borderBottom: isToday(d) ? "2px solid #10B981" : "1px solid #334155",
                      whiteSpace: "pre-line",
                      lineHeight: 1.3,
                      fontSize: 10,
                      padding: "8px 4px",
                    }}>
                      {fmtDateHeader(d)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((row, ri) => {
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
                      <td style={{ ...S.td, ...S.stickyCol, left: 330, background: isPinned ? "#1a2332" : ri % 2 === 0 ? "#0F172A" : "#111827", textAlign: "center" }}>
                        <span style={{ color: "#F1F5F9", fontWeight: 600, fontFamily: "monospace", fontSize: 13 }}>
                          {row.onHand.toLocaleString()}
                        </span>
                      </td>
                      {/* On Order */}
                      <td style={{ ...S.td, ...S.stickyCol, left: 410, background: isPinned ? "#1a2332" : ri % 2 === 0 ? "#0F172A" : "#111827", textAlign: "center" }}>
                        <span style={{ color: "#10B981", fontWeight: 600, fontFamily: "monospace", fontSize: 13 }}>
                          {row.onOrder > 0 ? `+${row.onOrder.toLocaleString()}` : "—"}
                        </span>
                      </td>
                      {/* Date cells */}
                      {dates.map(d => {
                        const qty = row.dates[d];
                        const isHov = hoveredCell?.sku === row.sku && hoveredCell?.date === d;
                        const isEmpty = qty === undefined || qty === null;
                        return (
                          <td
                            key={d}
                            style={{
                              ...S.td,
                              textAlign: "center",
                              padding: "4px",
                              background: isToday(d)
                                ? (isEmpty ? "#12201a" : getQtyBg(qty) + "cc")
                                : isWeekend(d)
                                ? (isEmpty ? "#111827" : "#111827")
                                : (isEmpty ? "#0F172A" : getQtyBg(qty)),
                              cursor: "default",
                              transition: "all 0.1s",
                              outline: isHov ? `1px solid ${isEmpty ? "#334155" : getQtyColor(qty)}` : "none",
                              outlineOffset: -1,
                              position: "relative",
                            }}
                            onMouseEnter={() => setHoveredCell({ sku: row.sku, date: d })}
                            onMouseLeave={() => setHoveredCell(null)}
                          >
                            {isEmpty ? (
                              <span style={{ color: "#334155", fontSize: 11 }}>—</span>
                            ) : (
                              <span style={{
                                color: getQtyColor(qty),
                                fontSize: 12,
                                fontFamily: "monospace",
                                fontWeight: qty <= 10 ? 700 : 500,
                              }}>
                                {qty === 0 ? "0" : qty.toLocaleString()}
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
      </div>

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
                  { label: "Purchased Items Report", sub: "Open purchase orders (incoming)", key: "pur", file: purFile, setFile: setPurFile, ref: purRef, color: "#3B82F6" },
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
                  opacity: (invFile && purFile && ordFile) ? 1 : 0.4,
                  cursor: (invFile && purFile && ordFile) ? "pointer" : "not-allowed",
                }}
                disabled={!(invFile && purFile && ordFile)}
                onClick={() => {
                  if (invFile && purFile && ordFile) {
                    setShowUpload(false);
                    handleFileUpload(invFile, purFile, ordFile);
                  }
                }}
              >
                {invFile && purFile && ordFile ? "Process All Files →" : `Select all 3 files (${[invFile, purFile, ordFile].filter(Boolean).length}/3 ready)`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  function StatCard({ icon, label, value, color }: { icon: string; label: string; value: number; color: string }) {
    return (
      <div style={{ ...S.statCard, borderTop: `2px solid ${color}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <span style={{ fontSize: 13, color: "#9CA3AF" }}>{label}</span>
          <span style={{ fontSize: 16, color, opacity: 0.7 }}>{icon}</span>
        </div>
        <div style={{ fontSize: 28, fontWeight: 700, color, fontFamily: "monospace", marginTop: 6 }}>
          {value.toLocaleString()}
        </div>
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

  tableWrap:   { overflowX: "auto", borderRadius: 10, border: "1px solid #334155", background: "#0F172A" },
  table:       { borderCollapse: "collapse" as const, width: "100%", fontSize: 13 },
  th:          { background: "#1E293B", color: "#6B7280", fontWeight: 600, fontSize: 11, textTransform: "uppercase" as const, letterSpacing: "0.05em", padding: "10px 12px", borderBottom: "1px solid #334155", borderRight: "1px solid #1a2030", whiteSpace: "nowrap" as const, position: "sticky" as const, top: 0 },
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
