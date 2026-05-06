import React, { useRef, useState } from "react";
import S from "../styles";
import type { ATSRow, ATSSoEvent, ExcelData } from "../types";
import { XoroSyncOverlay, type XoroSyncProgress } from "./StatusOverlays";
import { normalizeXoroSos, type XoroSoRecord } from "../normalizeXoroSos";

// Page-by-page walk of /api/xoro/open-sos. Calls the endpoint with
// max_pages=1 once per page so the client can render true page-by-page
// progress instead of a single 50s spinner. Why one page at a time:
// Vercel's response is fully buffered, so a single 26-page server call
// would only update the UI once. Per-page calls trade a few seconds of
// HTTP overhead for granular progress that matches the rest of the app's
// sync UX (UploadProgressOverlay et al.).
//
// We drive the progress bar off pagesDone/totalPages (reliable) rather
// than records/expected (unreliable — Xoro caps actual page sizes
// below per_page so a totalPages × per_page estimate over-states by
// ~2x).

interface SyncResult {
  ok: boolean;
  downloaded: number;
  pages: number;
  message: string;
  // Raw Xoro records accumulated across the walk. Returned on every
  // exit path (clean success, partial sync, cancel) so the caller can
  // always normalize what it has.
  records: XoroSoRecord[];
  // Pages that failed after retries. Empty on a clean walk; populated
  // when skip-and-continue salvaged a sync past one or more bad pages.
  failedPages: number[];
}

async function runOpenSosSync(
  onProgress: (p: XoroSyncProgress) => void,
  cancelRef: React.MutableRefObject<boolean>,
): Promise<SyncResult> {
  let page = 1;
  let totalPages = 0;
  let downloaded = 0;
  const records: XoroSoRecord[] = [];
  const failedPages: number[] = [];

  // Probe page 1 to learn TotalPages. Page 1 is the only page where
  // failure is fatal — without TotalPages we don't know how many pages
  // to walk, so we don't skip-and-continue past a page-1 failure.
  onProgress({ step: "Probing Xoro for total pages…", pct: 0, downloaded: 0, pagesDone: 0, totalPages: 0 });
  let resp: Response;
  try {
    resp = await fetch(`/api/xoro/open-sos?page_start=1&max_pages=1`, { method: "GET" });
  } catch (e: any) {
    return { ok: false, downloaded: 0, pages: 0, message: `Network error: ${e?.message || String(e)}`, records: [], failedPages: [1] };
  }
  let body: any;
  try { body = await resp.json(); } catch { return { ok: false, downloaded: 0, pages: 0, message: "Xoro returned non-JSON", records: [], failedPages: [1] }; }
  if (!body?.ok) {
    const err = body?.first_error?.Message || body?.first_error?.error || "Xoro returned no data";
    return { ok: false, downloaded: 0, pages: 0, message: `Xoro error: ${err}`, records: [], failedPages: [1] };
  }
  const firstStatusBlock = (body.per_status ?? [])[0];
  totalPages = firstStatusBlock?.total_pages ?? 1;
  downloaded = body.total_records ?? 0;
  if (Array.isArray(firstStatusBlock?.records)) records.push(...firstStatusBlock.records);
  onProgress({ step: `Walking ${totalPages} pages…`, pct: Math.round((1 / totalPages) * 100), downloaded, pagesDone: 1, totalPages });

  // Walk remaining pages 2..totalPages with skip-and-continue.
  //
  // Why skip rather than abort: production data shows pages with huge
  // SOs (e.g. Macy's, which can have hundreds of line items) take well
  // past the 60s timeout. If we abort the entire 26-page walk on one
  // slow page, we lose 25 pages of valid data. Skip-and-continue
  // banks each successful page and reports failed pages back to the
  // user; re-syncing dedupes against raw_xoro_payloads so the retry is
  // cheap server-side.
  for (page = 2; page <= totalPages; page++) {
    if (cancelRef.current) {
      return { ok: false, downloaded, pages: page - 1, message: "Cancelled by user", records, failedPages };
    }
    // 250ms gap between pages — Xoro 500s under load and the server-
    // side retry chain handles transient blips, but pacing reduces
    // how often we trip them in the first place.
    await new Promise((r) => setTimeout(r, 250));

    let pageResp: Response | null = null;
    try {
      pageResp = await fetch(`/api/xoro/open-sos?page_start=${page}&max_pages=1`, { method: "GET" });
    } catch {
      failedPages.push(page);
      onProgress({ step: `Page ${page} failed, continuing…`, pct: Math.round((page / totalPages) * 100), downloaded, pagesDone: page, totalPages });
      continue;
    }
    let pageBody: any = null;
    try { pageBody = await pageResp.json(); } catch {
      failedPages.push(page);
      onProgress({ step: `Page ${page} failed, continuing…`, pct: Math.round((page / totalPages) * 100), downloaded, pagesDone: page, totalPages });
      continue;
    }
    if (!pageBody?.ok) {
      failedPages.push(page);
      onProgress({ step: `Page ${page} failed, continuing…`, pct: Math.round((page / totalPages) * 100), downloaded, pagesDone: page, totalPages });
      continue;
    }
    const pageStatusBlock = (pageBody.per_status ?? [])[0];
    if (Array.isArray(pageStatusBlock?.records)) records.push(...pageStatusBlock.records);
    downloaded += pageBody.total_records ?? 0;
    onProgress({ step: `Walking ${totalPages} pages…`, pct: Math.round((page / totalPages) * 100), downloaded, pagesDone: page, totalPages });
    // Empty page = end of dataset before declared TotalPages (rare but
    // possible if Xoro's pagination shifts mid-walk). Stop early.
    if ((pageBody.total_records ?? 0) === 0) break;
  }

  const ok = failedPages.length === 0;
  const message = ok
    ? `Synced ${downloaded.toLocaleString()} Released SOs from Xoro`
    : `Synced ${downloaded.toLocaleString()} SOs — page${failedPages.length > 1 ? "s" : ""} ${failedPages.join(", ")} timed out (re-sync to retry just those)`;
  return { ok, downloaded, pages: totalPages, message, records, failedPages };
}

interface NavBarProps {
  mergeHistory: Array<{ fromSku: string; toSku: string }>;
  undoLastMerge: () => void;
  onNavigateHome: () => Promise<void>;
  setShowUpload: (v: boolean) => void;
  uploadingFile: boolean;
  invFile: File | null;
  purFile: File | null;
  ordFile: File | null;
  exportToExcel: (rows: ATSRow[], periods: Array<{ endDate: string; label: string }>, atShip: boolean) => void;
  filtered: ATSRow[];
  displayPeriods: Array<{ endDate: string; label: string }>;
  atShip: boolean;
  onNegInven: () => void;
  onAgedInven: (days: number, category: string) => "ok" | "empty";
  onDownloadIncompleteSkus: () => void;
  onDownloadStockVsSo: () => void;
  categories: string[];
  filterCategory: string;
  unreadNotifs: number;
  showingNotifications: boolean;
  onToggleNotifications: () => void;
  // For the Open-SOs Xoro sync. After a successful walk we replace
  // excelData.sos with the API-derived events, keeping skus/pos
  // intact (Excel is still the source for those until we have endpoints).
  excelData: ExcelData | null;
  setExcelData: (v: ExcelData | null | ((prev: ExcelData | null) => ExcelData | null)) => void;
}

export const NavBar: React.FC<NavBarProps> = ({
  mergeHistory, undoLastMerge, onNavigateHome, setShowUpload,
  uploadingFile, invFile, purFile, ordFile,
  exportToExcel, filtered, displayPeriods, atShip, onNegInven, onAgedInven, onDownloadIncompleteSkus, onDownloadStockVsSo,
  categories, filterCategory,
  unreadNotifs, showingNotifications, onToggleNotifications,
  excelData, setExcelData,
}) => {
  const [agedOpen, setAgedOpen] = useState(false);
  const [agedDays, setAgedDays] = useState("365");
  const [agedCategory, setAgedCategory] = useState(filterCategory);
  const [agedEmpty, setAgedEmpty] = useState(false);

  // Open-SOs sync state. The centered overlay is the primary UX while
  // the sync runs; the success/error toast appears briefly afterward.
  const [syncProgress, setSyncProgress] = useState<XoroSyncProgress | null>(null);
  const [syncSosToast, setSyncSosToast] = useState<{ ok: boolean; message: string } | null>(null);
  const cancelRef = useRef<boolean>(false);
  const syncing = syncProgress !== null;

  const handleSyncOpenSos = async () => {
    if (syncing) return;
    cancelRef.current = false;
    setSyncSosToast(null);
    setSyncProgress({ step: "Starting…", pct: 0, downloaded: 0, pagesDone: 0, totalPages: 0 });
    const result = await runOpenSosSync((p) => setSyncProgress(p), cancelRef);

    // Normalize whatever records made it back — even a partial walk
    // (e.g. failed at page 19 of 26) still gives us most of the data.
    // Per user direction: replace excelData.sos wholesale, keep
    // skus/pos from the Excel upload.
    if (result.records.length > 0) {
      const { events, skipped } = normalizeXoroSos(result.records);
      const skipNote = (skipped.noSku + skipped.noDate + skipped.zeroQty) > 0
        ? ` (skipped ${skipped.noSku} no-SKU, ${skipped.noDate} no-date, ${skipped.zeroQty} zero-qty)`
        : "";

      setExcelData((prev) => {
        const nowIso = new Date().toISOString();
        if (prev) return { ...prev, sos: events, syncedAt: nowIso };
        return null;
      });

      // Toast wording depends on whether the walk completed cleanly
      // or died partway through. Stay visible 8s so the user has time
      // to read the partial-failure context (vs 5s for a clean run).
      const baseMsg = excelData
        ? `${events.length.toLocaleString()} SOs now driving the grid${skipNote}`
        : `${events.length.toLocaleString()} SOs synced — upload Excel to seed inventory + POs`;
      const finalMsg = result.ok
        ? baseMsg
        : `Partial sync: ${baseMsg}. ${result.message}`;
      setSyncProgress(null);
      setSyncSosToast({ ok: result.ok, message: finalMsg });
      setTimeout(() => setSyncSosToast(null), result.ok ? 6000 : 12000);
      return;
    }

    // Total failure — no records made it back at all.
    setSyncProgress(null);
    setSyncSosToast({ ok: false, message: result.message });
    setTimeout(() => setSyncSosToast(null), 10000);
  };
  const handleCancelSync = () => { cancelRef.current = true; };

  return (
  <nav style={S.nav}>
    <div style={S.navLeft}>
      <div style={S.navLogo}>ATS</div>
      <span style={S.navTitle}>ATS Report</span>
      <span style={S.navSub}>Available to Sell</span>
    </div>
    <div style={S.navRight}>
      {mergeHistory?.length > 0 && (
        <button
          style={{ ...S.navBtn, background: "#7C3AED", border: "1px solid #5B21B6", color: "#fff", fontWeight: 600 }}
          title={`Undo merge: ${mergeHistory[mergeHistory.length - 1]?.fromSku} → ${mergeHistory[mergeHistory.length - 1]?.toSku}`}
          onClick={undoLastMerge}
        >
          ↩ Undo Merge ({mergeHistory.length})
        </button>
      )}
      <button style={S.navBtn} onClick={() => setShowUpload(true)} disabled={uploadingFile}>
        {uploadingFile ? "Uploading…" : "Upload Excel"}
        {!uploadingFile && (invFile || purFile || ordFile) && (
          <span style={{ marginLeft: 6, background: "#10B981", color: "#fff", borderRadius: 10, padding: "1px 6px", fontSize: 11, fontWeight: 700 }}>
            {[invFile, ordFile].filter(Boolean).length}/2{purFile ? "+PO" : ""}
          </span>
        )}
      </button>
      <button
        style={{
          ...S.navBtn,
          background: syncing ? "#1E293B" : "#0EA5E9",
          border: `1px solid ${syncing ? "#334155" : "#0284C7"}`,
          color: "#fff",
          fontWeight: 600,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          opacity: syncing ? 0.7 : 1,
        }}
        onClick={handleSyncOpenSos}
        disabled={syncing}
        title="Pull all Released sales orders from Xoro into raw_xoro_payloads. ~50s for the full set (~5,200 SOs)."
      >
        {syncing ? "⟳ Syncing…" : "↓ Sync Open SOs"}
      </button>
      <button
        style={{ ...S.navBtn, background: "#1D6F42", border: "1px solid #155734", color: "#fff", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 4, padding: "5px 7px" }}
        onClick={() => exportToExcel(filtered.filter(r => !r.__collapsed), displayPeriods.map(p => ({ endDate: p.endDate, label: p.label })), atShip)}
      >
        <svg width="13" height="13" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect width="20" height="20" rx="3" fill="#1D6F42" />
          <path d="M11 10l3-4.5h-2.1L10 8.3 8.1 5.5H6l3 4.5L6 14.5h2.1L10 11.7l1.9 2.8H14L11 10z" fill="white" />
        </svg>
        Export Excel
      </button>
      <button
        style={{ ...S.navBtn, background: "#1D6F42", border: "1px solid #155734", color: "#fff", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 4, padding: "5px 7px" }}
        onClick={onNegInven}
        title="Select Neg ATS filter and download Neg Inventory report"
      >
        <svg width="13" height="13" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect width="20" height="20" rx="3" fill="#1D6F42" />
          <path d="M11 10l3-4.5h-2.1L10 8.3 8.1 5.5H6l3 4.5L6 14.5h2.1L10 11.7l1.9 2.8H14L11 10z" fill="white" />
        </svg>
        Neg Inven
      </button>
      <button
        style={{ ...S.navBtn, background: "#1D6F42", border: "1px solid #155734", color: "#fff", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 4, padding: "5px 7px" }}
        onClick={() => { setAgedCategory(filterCategory); setAgedEmpty(false); setAgedOpen(true); }}
        title="Download Aged Inventory report"
      >
        <svg width="13" height="13" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect width="20" height="20" rx="3" fill="#1D6F42" />
          <path d="M11 10l3-4.5h-2.1L10 8.3 8.1 5.5H6l3 4.5L6 14.5h2.1L10 11.7l1.9 2.8H14L11 10z" fill="white" />
        </svg>
        Aged Inven
      </button>
      <button
        style={{ ...S.navBtn, background: "#1D6F42", border: "1px solid #155734", color: "#fff", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 4, padding: "5px 7px" }}
        onClick={onDownloadIncompleteSkus}
        title="Download styles with no open SOs, no avg cost, and no PO unit cost — these are the SKUs the red Mrgn:* asterisk in the totals row refers to"
      >
        <svg width="13" height="13" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect width="20" height="20" rx="3" fill="#1D6F42" />
          <path d="M11 10l3-4.5h-2.1L10 8.3 8.1 5.5H6l3 4.5L6 14.5h2.1L10 11.7l1.9 2.8H14L11 10z" fill="white" />
        </svg>
        NO Mrgn Data
      </button>
      <button
        style={{ ...S.navBtn, background: "#1D6F42", border: "1px solid #155734", color: "#fff", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 4, padding: "5px 7px" }}
        onClick={onDownloadStockVsSo}
        title="Per-SO breakdown: how much fills from current stock, how much from incoming POs (PO arrival ≤ ship date), how much needs a new PO"
      >
        <svg width="13" height="13" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect width="20" height="20" rx="3" fill="#1D6F42" />
          <path d="M11 10l3-4.5h-2.1L10 8.3 8.1 5.5H6l3 4.5L6 14.5h2.1L10 11.7l1.9 2.8H14L11 10z" fill="white" />
        </svg>
        Stock Vs SO
      </button>
      <button
        style={{
          ...S.navBtn,
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          ...(showingNotifications ? { background: "#3B82F620", border: "1px solid #3B82F6", color: "#60A5FA" } : null),
        }}
        onClick={onToggleNotifications}
        title="Notifications"
      >
        🔔 Notifications
        {unreadNotifs > 0 && (
          <span style={{
            minWidth: 18, height: 18, padding: "0 5px", borderRadius: 999,
            background: "#EF4444", color: "#fff", fontSize: 10, fontWeight: 700,
            display: "inline-flex", alignItems: "center", justifyContent: "center",
          }}>{unreadNotifs > 9 ? "9+" : unreadNotifs}</span>
        )}
      </button>
      <button style={{ ...S.navBtn, cursor: "pointer" }} onClick={onNavigateHome}>← PLM Home</button>
    </div>

    {/* Sync Open SOs centered progress modal — matches UploadProgressOverlay format */}
    <XoroSyncOverlay progress={syncProgress} onCancel={handleCancelSync} />

    {/* Sync Open SOs toast — auto-dismisses after 5s, click to dismiss sooner */}
    {syncSosToast && (
      <div
        onClick={() => setSyncSosToast(null)}
        style={{
          position: "fixed",
          top: 70,
          right: 24,
          zIndex: 400,
          minWidth: 280,
          maxWidth: 420,
          padding: "10px 16px",
          borderRadius: 8,
          background: syncSosToast.ok ? "rgba(16,185,129,0.95)" : "rgba(239,68,68,0.95)",
          color: "#fff",
          fontSize: 13,
          fontWeight: 600,
          boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
          cursor: "pointer",
          border: `1px solid ${syncSosToast.ok ? "#047857" : "#991B1B"}`,
        }}
      >
        {syncSosToast.ok ? "✓ " : "✕ "}{syncSosToast.message}
      </div>
    )}

    {/* Aged Inventory days modal */}
    {agedOpen && (
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center" }}
        onClick={() => setAgedOpen(false)}
      >
        <div style={{ background: "#1E293B", border: "1px solid #334155", borderRadius: 12, padding: 28, width: 320, boxShadow: "0 20px 60px rgba(0,0,0,0.5)" }}
          onClick={e => e.stopPropagation()}
        >
          <div style={{ fontSize: 16, fontWeight: 700, color: "#F1F5F9", marginBottom: 6 }}>Aged Inventory Report</div>
          <div style={{ fontSize: 12, color: "#94A3B8", marginBottom: 18 }}>
            Show on-hand inventory where the last received date is this many days ago or older.<br />
            <span style={{ color: "#64748B", fontSize: 11, marginTop: 4, display: "block" }}>Items with no last received date default to Sep 30, 2024.</span>
          </div>
          <label style={{ fontSize: 12, color: "#94A3B8", display: "block", marginBottom: 6 }}>Aged Days Threshold</label>
          <input
            type="number"
            min={1}
            value={agedDays}
            onChange={e => setAgedDays(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") { const d = parseInt(agedDays); if (d > 0) { const r = onAgedInven(d, agedCategory); if (r === "ok") setAgedOpen(false); else setAgedEmpty(true); } } }}
            autoFocus
            style={{ width: "100%", background: "#0F172A", border: "1px solid #334155", borderRadius: 8, color: "#F1F5F9", fontSize: 15, padding: "8px 12px", outline: "none", boxSizing: "border-box" as const, marginBottom: 16 }}
          />
          <label style={{ fontSize: 12, color: "#94A3B8", display: "block", marginBottom: 6 }}>Category</label>
          <select
            value={agedCategory}
            onChange={e => setAgedCategory(e.target.value)}
            style={{ width: "100%", background: "#0F172A", border: "1px solid #334155", borderRadius: 8, color: "#F1F5F9", fontSize: 14, padding: "8px 12px", outline: "none", boxSizing: "border-box" as const, marginBottom: 20, cursor: "pointer" }}
          >
            {categories.map(c => <option key={c} value={c}>{c === "All" ? "All Categories" : c}</option>)}
          </select>
          {agedEmpty && (
            <div style={{ color: "#F87171", fontSize: 12, marginBottom: 14, padding: "8px 12px", background: "rgba(248,113,113,0.08)", borderRadius: 6, border: "1px solid rgba(248,113,113,0.2)" }}>
              No aged inventory found for {agedCategory !== "All" ? `${agedCategory} – ` : ""}{agedDays}+ days.
            </div>
          )}
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <button onClick={() => setAgedOpen(false)}
              style={{ background: "none", border: "1px solid #334155", color: "#94A3B8", borderRadius: 6, padding: "7px 16px", fontSize: 13, cursor: "pointer" }}>
              Cancel
            </button>
            <button
              onClick={() => { const d = parseInt(agedDays); if (d > 0) { const r = onAgedInven(d, agedCategory); if (r === "ok") setAgedOpen(false); else setAgedEmpty(true); } }}
              style={{ background: "#1D6F42", border: "1px solid #155734", color: "#fff", borderRadius: 6, padding: "7px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
              Download Report
            </button>
          </div>
        </div>
      </div>
    )}
  </nav>
  );
};

interface SyncProgressBannerProps {
  syncProgress: { step: string; pct: number; log: string[] } | null;
}

export const SyncProgressBanner: React.FC<SyncProgressBannerProps> = ({ syncProgress }) => {
  if (!syncProgress) return null;
  return (
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
  );
};
