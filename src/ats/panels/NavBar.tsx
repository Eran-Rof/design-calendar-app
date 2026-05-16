import React, { useEffect, useRef, useState } from "react";
import S from "../styles";
import type { ATSRow, ATSPoEvent, ATSSoEvent, ExcelData } from "../types";
import { computeGridTotals } from "../computeTotals";
import { XoroSyncOverlay, type XoroSyncProgress } from "./StatusOverlays";
import { normalizeXoroSos, type XoroSoRecord } from "../normalizeXoroSos";
import { ExportOptionsModal, type ExportOptions } from "./ExportOptionsModal";
import { ExportPreviewModal } from "./ExportPreviewModal";
import { fetchSalesAggregates, type SalesFetchResult } from "../exportSalesFetch";
import { buildExportPayload, triggerXlsxDownload, type ExportPayload } from "../exportExcel";
import { getItemMasterById } from "../itemMasterLookup";
import { SB_URL, SB_HEADERS } from "../../utils/supabase";

// Fetch ip_item_master rows for sku_ids the local cache doesn't
// already have. Used by the cross-grid synthetic-row flow when a
// customer's sales reference SKUs that haven't been cached (newly
// added, never carried inventory locally, etc.).
async function fetchMissingMasterRows(ids: string[]): Promise<Array<{ id: string; sku_code: string; style_code: string | null; color: string | null; description: string | null; attributes: any }>> {
  if (!SB_URL || ids.length === 0) return [];
  // PostgREST `in.(...)` URL — quote each id (uuids are safe but
  // be defensive). encodeURIComponent the whole comma-joined string
  // so commas become %2C and PostgREST sees a single in-clause.
  const inList = ids.map(id => `"${id}"`).join(",");
  const url = `${SB_URL}/rest/v1/ip_item_master?select=id,sku_code,style_code,color,description,attributes&id=in.(${encodeURIComponent(inList)})&limit=${ids.length}`;
  try {
    const r = await fetch(url, { headers: SB_HEADERS });
    if (!r.ok) {
      console.warn(`[ATS export] fetchMissingMasterRows failed: ${r.status}`);
      return [];
    }
    return await r.json();
  } catch (e) {
    console.warn("[ATS export] fetchMissingMasterRows error:", e);
    return [];
  }
}

// Sync architecture (rewritten 2026-05-06 after discovering Xoro's
// pagination overlaps — same SOs appear on multiple pages, and the
// reported `TotalPages` truncates the walk before all unique SOs have
// been seen). The Xoro Excel export said 2,449 unique Released SOs;
// the original page-bounded walk got only 1,600 unique (65%).
//
// New approach — saturation-based walk per status:
//   1. For each requested status, walk pages 1..N until either Xoro
//      returns an empty page OR we've seen N consecutive pages with
//      ZERO new unique OrderNumbers (= the dataset has been fully
//      sampled despite pagination shuffle).
//   2. Dedupe across all statuses by OrderNumber — a SO that flips
//      from Released → Partially Shipped mid-walk is counted once.
//   3. Failed pages within a status are retried in passes 2..5 like
//      before.
//
// Why "consecutive pages with zero new" instead of trusting empty
// pages alone: Xoro's pagination skips and repeats records (we saw
// 1,200 duplicates across 2,800 fetched headers). An empty page
// might just mean "this slice is all duplicates" rather than "end
// of dataset", but extending the saturation threshold to N=3 makes
// the heuristic robust enough.

const STATUSES_TO_SYNC = ["Released", "Open", "Partially Shipped"];
// Stop walking a status after this many consecutive pages added zero
// new unique SOs. Gives Xoro's overlapping pagination room to deliver
// late-arriving unique records before declaring the status saturated.
const SATURATION_THRESHOLD = 3;
// Hard ceiling on pages walked per status so a pathological dataset
// can't grind forever. ~2,500 SOs / ~100 per page × 2x duplication
// margin = ~50 pages typical; 100 leaves room for outliers.
const MAX_PAGES_PER_STATUS = 100;

interface SyncResult {
  ok: boolean;
  downloaded: number;             // unique SOs across all statuses
  pages: number;                  // total pages walked across all statuses
  message: string;
  records: XoroSoRecord[];
  failedPages: number[];          // (status:page) IDs that never succeeded
}

const MAX_PASSES = 5;
const PASS_DELAYS_MS = [0, 5_000, 15_000, 30_000, 60_000];

// Fetch a single page for a specific status. Returns the records on
// success, null on failure. Pass status through so the server-side
// handler hits Xoro with the right filter.
async function fetchOnePage(status: string, pageNum: number): Promise<XoroSoRecord[] | null> {
  let resp: Response;
  try {
    resp = await fetch(`/api/xoro/open-sos?status=${encodeURIComponent(status)}&page_start=${pageNum}&max_pages=1`, { method: "GET" });
  } catch {
    return null;
  }
  let body: any;
  try { body = await resp.json(); } catch { return null; }
  if (!body?.ok) return null;
  const block = (body.per_status ?? [])[0];
  return Array.isArray(block?.records) ? block.records : [];
}

// Walk one Xoro status until saturated. Returns the unique records
// collected for this status plus any pages that failed (tagged with
// the status so the retry pass can re-fetch them with the right filter).
async function walkStatusToSaturation(
  status: string,
  seenOrderNumbers: Set<string>,
  records: XoroSoRecord[],
  onProgress: (p: XoroSyncProgress) => void,
  cancelRef: React.MutableRefObject<boolean>,
  totalUniqueSoFar: () => number,
  totalPagesSoFar: () => number,
): Promise<{ failedPages: Array<{ status: string; page: number }>; pagesWalked: number; saturatedAt: number | null; }> {
  const failedPages: Array<{ status: string; page: number }> = [];
  let consecutiveZeroNew = 0;
  let pagesWalked = 0;
  let duplicates = 0;
  let saturatedAt: number | null = null;

  for (let page = 1; page <= MAX_PAGES_PER_STATUS; page++) {
    if (cancelRef.current) break;
    if (page > 1) await new Promise((r) => setTimeout(r, 250));

    onProgress({
      step: `Walking ${status} — page ${page}…`,
      pct: 0, // indeterminate until we know how many we'll walk
      downloaded: totalUniqueSoFar(),
      pagesDone: totalPagesSoFar() + page,
      totalPages: 0,
      pass: 1, maxPasses: MAX_PASSES,
      duplicatesSeen: duplicates,
    });

    const pageRecords = await fetchOnePage(status, page);
    pagesWalked++;
    if (pageRecords === null) {
      failedPages.push({ status, page });
      continue;
    }
    if (pageRecords.length === 0) {
      // Genuinely empty page = end of this status's dataset.
      saturatedAt = page;
      break;
    }

    // Count new unique OrderNumbers added by this page.
    let newOrders = 0;
    for (const rec of pageRecords) {
      const orderNum = rec?.SoEstimateHeader?.OrderNumber;
      if (orderNum && !seenOrderNumbers.has(orderNum)) {
        seenOrderNumbers.add(orderNum);
        records.push(rec);
        newOrders++;
      } else if (orderNum) {
        duplicates++;
      }
    }

    if (newOrders === 0) {
      consecutiveZeroNew++;
      if (consecutiveZeroNew >= SATURATION_THRESHOLD) {
        saturatedAt = page;
        break;
      }
    } else {
      consecutiveZeroNew = 0;
    }
  }

  return { failedPages, pagesWalked, saturatedAt };
}

async function runOpenSosSync(
  onProgress: (p: XoroSyncProgress) => void,
  cancelRef: React.MutableRefObject<boolean>,
): Promise<SyncResult> {
  // Single source of truth: a Set of OrderNumbers we've already seen,
  // and the deduped records array. Both updated by walkStatusToSaturation
  // as it processes each page. Cross-status dedup falls out for free —
  // a SO whose status flips during the walk is counted once.
  const seenOrderNumbers = new Set<string>();
  const records: XoroSoRecord[] = [];
  const allFailedPages: Array<{ status: string; page: number }> = [];
  let totalPagesWalked = 0;

  onProgress({
    step: "Starting…", pct: 0, downloaded: 0,
    pagesDone: 0, totalPages: 0, pass: 1, maxPasses: MAX_PASSES,
  });

  // ── Pass 1: walk each status to saturation ──────────────────────────
  for (const status of STATUSES_TO_SYNC) {
    if (cancelRef.current) {
      return {
        ok: false, downloaded: seenOrderNumbers.size, pages: totalPagesWalked,
        message: "Cancelled by user", records,
        failedPages: allFailedPages.map((f) => f.page),
      };
    }
    const result = await walkStatusToSaturation(
      status, seenOrderNumbers, records,
      onProgress, cancelRef,
      () => seenOrderNumbers.size,
      () => totalPagesWalked,
    );
    totalPagesWalked += result.pagesWalked;
    allFailedPages.push(...result.failedPages);
  }

  // ── Pass 2..MAX_PASSES: retry pages that failed in pass 1 ───────────
  // Per-page, per-status: each failed page is retried with the same
  // status filter. Successful retries go through the same dedup path
  // so we don't double-count.
  for (let pass = 2; pass <= MAX_PASSES; pass++) {
    if (allFailedPages.length === 0) break;
    if (cancelRef.current) break;

    const delay = PASS_DELAYS_MS[pass - 1] ?? 60_000;
    if (delay > 0) {
      onProgress({
        step: `Pausing ${Math.round(delay / 1000)}s before retry pass…`,
        pct: 100, downloaded: seenOrderNumbers.size, pagesDone: totalPagesWalked, totalPages: 0,
        pass, maxPasses: MAX_PASSES, retryingCount: allFailedPages.length,
      });
      await new Promise((r) => setTimeout(r, delay));
    }

    const stillFailing: Array<{ status: string; page: number }> = [];
    for (let i = 0; i < allFailedPages.length; i++) {
      const fp = allFailedPages[i];
      if (cancelRef.current) {
        stillFailing.push(...allFailedPages.slice(i));
        break;
      }
      onProgress({
        step: `Retrying ${fp.status} page ${fp.page}…`,
        pct: Math.round((i / allFailedPages.length) * 100),
        downloaded: seenOrderNumbers.size, pagesDone: totalPagesWalked, totalPages: 0,
        pass, maxPasses: MAX_PASSES, retryingCount: allFailedPages.length - i,
      });
      await new Promise((r) => setTimeout(r, 250));
      const recs = await fetchOnePage(fp.status, fp.page);
      if (recs === null) {
        stillFailing.push(fp);
        continue;
      }
      for (const rec of recs) {
        const orderNum = rec?.SoEstimateHeader?.OrderNumber;
        if (orderNum && !seenOrderNumbers.has(orderNum)) {
          seenOrderNumbers.add(orderNum);
          records.push(rec);
        }
      }
    }
    allFailedPages.length = 0;
    allFailedPages.push(...stillFailing);
  }

  const downloaded = seenOrderNumbers.size;
  const ok = allFailedPages.length === 0;
  const failedPageNumbers = allFailedPages.map((f) => `${f.status}:${f.page}`);
  const message = ok
    ? `Synced ${downloaded.toLocaleString()} unique SOs across ${STATUSES_TO_SYNC.join(" + ")}`
    : `Synced ${downloaded.toLocaleString()} SOs — ${allFailedPages.length} page${allFailedPages.length > 1 ? "s" : ""} (${failedPageNumbers.join(", ")}) failed all ${MAX_PASSES} passes`;
  return {
    ok, downloaded, pages: totalPagesWalked, message, records,
    failedPages: allFailedPages.map((f) => f.page),
  };
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
  exportToExcel: (
    rows: ATSRow[],
    periods: Array<{ endDate: string; label: string }>,
    atShip: boolean,
    hiddenColumns: string[],
    totals?: import("../computeTotals").GridTotals | null,
    options?: ExportOptions,
    eventIndex?: Record<string, Record<string, { pos: ATSPoEvent[]; sos: ATSSoEvent[] }>> | null,
    salesAggregates?: SalesFetchResult,
  ) => void;
  filtered: ATSRow[];
  // Auto-default for the export-options modal's customer dropdown.
  // Picks up whatever the grid toolbar currently has selected.
  customerFilter: string;
  // Full display periods carry the key+periodStart needed by
  // computeGridTotals. The exporter itself only needs endDate + label,
  // so we ship the wider shape and let each consumer pick.
  displayPeriods: Array<{ key: string; periodStart: string; endDate: string; label: string }>;
  atShip: boolean;
  hiddenColumns: string[];
  // When TOTALS toggle is on, the export drops the right-side Total
  // column + simple bottom Total row and emits a 5-row Cost/Sale/Mrgn
  // stack instead. Passed as a flag so the resolve chain only runs at
  // click time, not on every NavBar render.
  showTotalsRow: boolean;
  eventIndex: Record<string, Record<string, { pos: ATSPoEvent[]; sos: ATSSoEvent[] }>> | null;
  viewMode: "ats" | "so" | "po";
  generalMarginPct: number;
  onNegInven: () => void;
  onAgedInven: (days: number, category: string) => "ok" | "empty";
  onDownloadIncompleteSkus: () => void;
  onDownloadStockVsSo: () => void;
  categories: string[];
  // Single-string copy of the active Category filter, fed in only for
  // the Aged Inven modal's category dropdown — that flow is still
  // single-select per-report. Pass the first selected category if the
  // top-level filter has one, else "All". Callers should not rely on
  // this for general filter state — that's now an array in atsTypes.
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
  exportToExcel, filtered, displayPeriods, atShip, hiddenColumns, showTotalsRow, eventIndex, viewMode, generalMarginPct, onNegInven, onAgedInven, onDownloadIncompleteSkus, onDownloadStockVsSo,
  categories, filterCategory,
  customerFilter,
  unreadNotifs, showingNotifications, onToggleNotifications,
  excelData, setExcelData,
}) => {
  // Export-options modal — opens when the user picks "Export Excel"
  // from the Reports menu. Confirm callback fires exportToExcel with
  // the chosen options.
  const [exportOptsOpen, setExportOptsOpen] = useState(false);
  // While the modal's Export button is awaiting a sales pre-fetch we
  // render a small blocking "Loading sales history…" overlay so the
  // operator knows something is happening (fetch can take several
  // seconds for a 15-month window over thousands of SKUs).
  const [exportLoading, setExportLoading] = useState(false);
  // Built workbook payload for the preview modal. null when preview
  // isn't open. Operator can click Download from inside the preview
  // to flush the same payload to a file.
  const [previewPayload, setPreviewPayload] = useState<ExportPayload | null>(null);
  // Body row count for the preview header (header row excluded).
  const [previewBodyCount, setPreviewBodyCount] = useState(0);
  const [agedOpen, setAgedOpen] = useState(false);
  const [agedDays, setAgedDays] = useState("365");
  const [agedCategory, setAgedCategory] = useState(filterCategory);
  const [agedEmpty, setAgedEmpty] = useState(false);
  // Reports dropdown — collapses the previous five always-visible green
  // export buttons (Export Excel / Neg Inven / Aged Inven / NO Mrgn Data /
  // Stock Vs SO) into one button + popover menu. Each menu entry fires the
  // same handler that the dedicated buttons used to fire; the Aged Inven
  // entry still opens the days/category modal before downloading.
  const [reportsOpen, setReportsOpen] = useState(false);
  const reportsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!reportsOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (reportsRef.current && !reportsRef.current.contains(e.target as Node)) {
        setReportsOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [reportsOpen]);

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
    setSyncProgress({ step: "Starting…", pct: 0, downloaded: 0, pagesDone: 0, totalPages: 0, pass: 1, maxPasses: MAX_PASSES });
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

  // Shared pre-flight for both Export and View. Drops collapsed rows,
  // optionally builds GridTotals, and fetches sales aggregates from the
  // nightly DB when trailing3 / SP-LY is on. Returns null when the
  // sales pre-fetch failed catastrophically (the modal stays open so
  // the operator can retry or adjust).
  async function prepareExportArgs(opts: ExportOptions) {
    const rowsForExport = filtered.filter(r => !r.__collapsed);
    const periods = displayPeriods.map(p => ({ endDate: p.endDate, label: p.label }));
    const totals = showTotalsRow
      ? computeGridTotals({
          filtered: rowsForExport,
          displayPeriods,
          atShip,
          viewMode,
          eventIndex,
          generalMarginPct,
        })
      : null;

    let salesAggregates: SalesFetchResult | undefined;
    let finalRows = rowsForExport;
    if (opts.trailing3 || opts.spLY) {
      setExportLoading(true);
      try {
        salesAggregates = await fetchSalesAggregates({
          rows: rowsForExport,
          needT3: opts.trailing3,
          needLY: opts.spLY,
          customer: opts.customer,
        });

        // Cross-grid: when a customer is selected, also surface SKUs
        // the customer historically bought that aren't visible in
        // the current grid (shipped through, no open commitments).
        // The fetcher collected those as extraBySkuId keyed by
        // ip_item_master.id. Resolve each id via the cache first;
        // for any not in the local cache, hit Supabase once for the
        // batch so newly-added or never-carried styles also surface.
        if (opts.customerEnabled && salesAggregates.extraBySkuId.size > 0) {
          const allIds = [...salesAggregates.extraBySkuId.keys()];
          const cached = new Map<string, ReturnType<typeof getItemMasterById>>();
          const missingIds: string[] = [];
          for (const id of allIds) {
            const rec = getItemMasterById(id);
            if (rec) cached.set(id, rec);
            else missingIds.push(id);
          }
          if (missingIds.length > 0) {
            const fetched = await fetchMissingMasterRows(missingIds);
            console.info(`[ATS export] cross-grid: fetched ${fetched.length}/${missingIds.length} missing master rows from Supabase`);
            for (const r of fetched) {
              cached.set(r.id, {
                id: r.id, sku_code: r.sku_code, style_code: r.style_code,
                color: r.color, description: r.description,
                attributes: r.attributes ?? {}, size: null,
              });
            }
          }

          // Group extra sku_ids by (style, color) so the report
          // surfaces ONE row per color block instead of one per
          // size — matches the grid's style+color grain.
          interface CrossGroup {
            sku: string;
            style: string | null;
            color: string | null;
            description: string | null;
            category: string | null;
            subCategory: string | null;
            t3Qty: number; t3Total: number;
            lyQty: number; lyTotal: number;
          }
          const groups = new Map<string, CrossGroup>();
          let unresolved = 0;
          for (const [id, agg] of salesAggregates.extraBySkuId) {
            const rec = cached.get(id);
            if (!rec || !rec.sku_code) { unresolved++; continue; }
            const styleU = (rec.style_code ?? "").toUpperCase();
            const colorU = (rec.color ?? "").trim().toUpperCase();
            const key = styleU && colorU ? `${styleU}|${colorU}` : `id|${id}`;
            const groupSku = (rec.style_code && rec.color)
              ? `${rec.style_code} - ${rec.color}`
              : rec.sku_code;
            let g = groups.get(key);
            if (!g) {
              g = {
                sku: groupSku,
                style: rec.style_code ?? null,
                color: rec.color ?? null,
                description: rec.description ?? null,
                category: rec.attributes?.group_name ?? null,
                subCategory: rec.attributes?.category_name ?? null,
                t3Qty: 0, t3Total: 0, lyQty: 0, lyTotal: 0,
              };
              groups.set(key, g);
            }
            g.t3Qty   += agg.t3Qty;
            g.t3Total += agg.t3Total;
            g.lyQty   += agg.lyQty;
            g.lyTotal += agg.lyTotal;
          }

          const synthetic: ATSRow[] = [];
          for (const g of groups.values()) {
            synthetic.push({
              sku: g.sku,
              description: g.description ?? "",
              dates: {},
              freeMap: {},
              onHand: 0,
              onOrder: 0,
              onPO: 0,
              ppkMult: 1,
              avgCost: 0,
              master_category:     g.category,
              master_sub_category: g.subCategory,
              master_style:        g.style,
              master_color:        g.color,
              master_description:  g.description,
              master_match_source: "sku",
            });
            if (g.t3Qty > 0 || g.t3Total > 0) salesAggregates.t3.set(g.sku, { qty: g.t3Qty, totalPrice: g.t3Total });
            if (g.lyQty > 0 || g.lyTotal > 0) salesAggregates.ly.set(g.sku, { qty: g.lyQty, totalPrice: g.lyTotal });
          }
          if (synthetic.length > 0) {
            finalRows = [...rowsForExport, ...synthetic];
            console.info(`[ATS export] cross-grid: added ${synthetic.length} synthetic rows by (style, color) from ${salesAggregates.extraBySkuId.size} unmapped sku_ids (${unresolved} unresolved)`);
          } else {
            console.warn(`[ATS export] cross-grid: extraBySkuId had ${salesAggregates.extraBySkuId.size} entries but none could be resolved to a master record — verify ip_item_master coverage`);
          }
        }
      } catch (e) {
        console.error("[ATS export] sales fetch failed:", e);
        // Fall through with undefined — T3/LY columns render blank
        // rather than blocking the rest of the export.
      } finally {
        setExportLoading(false);
      }
    }

    return { rowsForExport: finalRows, periods, totals, salesAggregates };
  }

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
          background: "#1E293B",
          border: "1px solid #334155",
          color: "#64748B",
          fontWeight: 600,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          opacity: 0.55,
          cursor: "not-allowed",
        }}
        disabled={true}
        title="Disabled — Xoro's salesorder API caps at ~65% coverage of Released SOs. Use the daily Excel upload (All Orders Report) for 100% data. Re-enable when Xoro support provides a bulk endpoint."
      >
        ↓ Sync Open SOs (disabled)
      </button>
      <div ref={reportsRef} style={{ position: "relative" }}>
        <button
          style={{
            ...S.navBtn,
            background: "#1D6F42",
            border: "1px solid #155734",
            color: "#fff",
            fontWeight: 600,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "5px 10px",
            cursor: "pointer",
          }}
          onClick={() => setReportsOpen(o => !o)}
          title="Excel exports + special reports"
        >
          <svg width="13" height="13" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect width="20" height="20" rx="3" fill="#1D6F42" />
            <path d="M11 10l3-4.5h-2.1L10 8.3 8.1 5.5H6l3 4.5L6 14.5h2.1L10 11.7l1.9 2.8H14L11 10z" fill="white" />
          </svg>
          Reports
          <span style={{ fontSize: 9, marginLeft: 2 }}>▼</span>
        </button>
        {reportsOpen && (
          <div
            style={{
              position: "absolute",
              top: "calc(100% + 4px)",
              right: 0,
              minWidth: 260,
              background: "#1E293B",
              border: "1px solid #334155",
              borderRadius: 8,
              zIndex: 200,
              boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
              padding: "4px 0",
            }}
          >
            {([
              {
                key: "exportExcel",
                label: "Export Excel…",
                sub: "Pick subtotals / cost / trailing options, then download",
                onClick: () => { setExportOptsOpen(true); setReportsOpen(false); },
              },
              {
                key: "negInven",
                label: "Neg Inven",
                sub: "Select Neg ATS filter + download the negative-inventory report",
                onClick: onNegInven,
              },
              {
                key: "agedInven",
                label: "Aged Inven…",
                sub: "Pick a days threshold + category, then download",
                onClick: () => { setAgedCategory(filterCategory); setAgedEmpty(false); setAgedOpen(true); },
              },
              {
                key: "noMrgnData",
                label: "NO Mrgn Data",
                sub: "Styles with no open SO, no avg cost, no PO cost (the red Mrgn:* asterisks)",
                onClick: onDownloadIncompleteSkus,
              },
              {
                key: "stockVsSo",
                label: "Stock Vs SO",
                sub: "Per-SO breakdown: stock-fill vs incoming PO vs needs-new-PO",
                onClick: onDownloadStockVsSo,
              },
            ] as const).map((item) => (
              <button
                key={item.key}
                onClick={() => { item.onClick(); setReportsOpen(false); }}
                title={item.sub}
                style={{
                  width: "100%",
                  textAlign: "left",
                  padding: "8px 14px",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  color: "#F1F5F9",
                  fontSize: 13,
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                  fontFamily: "inherit",
                }}
                onMouseEnter={e => (e.currentTarget.style.background = "rgba(16,185,129,0.12)")}
                onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
              >
                <span style={{ fontWeight: 600, color: "#6EE7B7" }}>{item.label}</span>
                <span style={{ fontSize: 11, color: "#94A3B8", whiteSpace: "normal", lineHeight: 1.3 }}>{item.sub}</span>
              </button>
            ))}
          </div>
        )}
      </div>
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

    <ExportOptionsModal
      open={exportOptsOpen}
      onClose={() => setExportOptsOpen(false)}
      excelData={excelData}
      defaultCustomer={customerFilter}
      onConfirm={async (opts) => {
        const prep = await prepareExportArgs(opts);
        if (!prep) return;
        exportToExcel(
          prep.rowsForExport,
          prep.periods,
          atShip,
          hiddenColumns,
          prep.totals,
          opts,
          eventIndex,
          prep.salesAggregates,
        );
        setExportOptsOpen(false);
      }}
      onView={async (opts) => {
        const prep = await prepareExportArgs(opts);
        if (!prep) return;
        const payload = buildExportPayload(
          prep.rowsForExport,
          prep.periods,
          atShip,
          hiddenColumns,
          prep.totals,
          opts,
          eventIndex,
          prep.salesAggregates,
        );
        if (!payload) return;
        setPreviewPayload(payload);
        setPreviewBodyCount(Math.max(0, payload.aoa.length - 1));
        // Leave the options modal mounted but hidden behind the
        // preview — clicking Back returns to it without re-fetching.
        setExportOptsOpen(false);
      }}
    />
    <ExportPreviewModal
      open={previewPayload !== null}
      aoa={previewPayload?.aoa ?? null}
      filename={previewPayload?.filename ?? ""}
      rowCount={previewBodyCount}
      onDownload={() => {
        if (!previewPayload) return;
        triggerXlsxDownload(previewPayload.wb, previewPayload.filename);
        setPreviewPayload(null);
      }}
      onClose={() => { setPreviewPayload(null); setExportOptsOpen(true); }}
      onCloseAll={() => { setPreviewPayload(null); }}
    />
    {exportLoading && (
      <div style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 1100,
        display: "flex", alignItems: "center", justifyContent: "center", color: "#F1F5F9",
        fontFamily: "inherit", fontSize: 14, fontWeight: 600,
      }}>
        <div style={{ background: "#1E293B", padding: "18px 26px", borderRadius: 10, border: "1px solid #334155", boxShadow: "0 16px 48px rgba(0,0,0,0.6)" }}>
          Loading sales history…
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
