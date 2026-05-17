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
import { filterRows } from "../filter";
import { resolveCost, buildSiblingMap } from "../../shared/costResolution";
import { SB_URL, SB_HEADERS } from "../../utils/supabase";
import { canonSku, canonStyleColor } from "../../inventory-planning/utils/skuCanon";
import { AskAIPanel } from "../../ai/AskAIPanel";
import type { AIGridSetters, GridContextSnapshot } from "../../ai/tools";

// Fetch ip_item_master rows for sku_ids the local cache doesn't
// already have. Used by the cross-grid synthetic-row flow when a
// customer's sales reference SKUs that haven't been cached (newly
// added, never carried inventory locally, etc.).
type MissingMasterRow = { id: string; sku_code: string; style_code: string | null; color: string | null; size: string | null; description: string | null; unit_cost: number | null; pack_size: number | null; attributes: any };
async function fetchMissingMasterRows(ids: string[]): Promise<MissingMasterRow[]> {
  if (!SB_URL || ids.length === 0) return [];
  // Chunked + parallel for the same URL-length reason the other fetchers
  // chunk — at 200+ UUIDs the single in.(...) URL crosses PostgREST's
  // gateway limit.
  const batches = chunkArray(ids, SB_IN_CHUNK);
  const responses = await Promise.all(batches.map(async (batch) => {
    const inList = batch.map((id) => `"${id}"`).join(",");
    const url = `${SB_URL}/rest/v1/ip_item_master?select=id,sku_code,style_code,color,size,description,unit_cost,pack_size,attributes&id=in.(${encodeURIComponent(inList)})&limit=${batch.length}`;
    try {
      const r = await fetch(url, { headers: SB_HEADERS });
      if (!r.ok) {
        console.warn(`[ATS export] fetchMissingMasterRows batch failed: ${r.status}`);
        return [] as MissingMasterRow[];
      }
      return (await r.json()) as MissingMasterRow[];
    } catch (e) {
      console.warn("[ATS export] fetchMissingMasterRows batch error:", e);
      return [];
    }
  }));
  return responses.flat();
}

// Fetch open-PO unit costs grouped by canonical sku_code, given the
// canonical SKUs themselves (no caller-provided id map needed). Two-step:
// 1. Look up ip_item_master.id for each sku_code.
// 2. Fetch ip_open_purchase_orders by sku_id (positive unit_cost,
//    qty_open > 0 so closed lines don't skew the avg).
// Used by the regular-grid hydration path where rows have a display SKU
// but no master.id readily available.
async function fetchOpenPoCostsByCanonicalSku(skus: string[]): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (!SB_URL || skus.length === 0) return out;

  // Step 1: sku_code → id. Chunk + parallel for the same URL-length
  // reason fetchAvgCostBySkuCodes chunks.
  const idToSkuCode = new Map<string, string>();
  const skuBatches = chunkArray(skus, SB_IN_CHUNK);
  const masterResponses = await Promise.all(skuBatches.map(async (batch) => {
    const inSkus = batch.map((s) => `"${s.replace(/"/g, '\\"')}"`).join(",");
    const masterUrl = `${SB_URL}/rest/v1/ip_item_master?select=id,sku_code&sku_code=in.(${encodeURIComponent(inSkus)})&limit=${batch.length}`;
    try {
      const r = await fetch(masterUrl, { headers: SB_HEADERS });
      if (!r.ok) {
        console.warn(`[ATS export] fetchOpenPoCostsByCanonicalSku master batch failed: ${r.status}`);
        return [] as Array<{ id: string; sku_code: string }>;
      }
      return (await r.json()) as Array<{ id: string; sku_code: string }>;
    } catch (e) {
      console.warn("[ATS export] fetchOpenPoCostsByCanonicalSku master batch error:", e);
      return [];
    }
  }));
  for (const rows of masterResponses) {
    for (const row of rows) idToSkuCode.set(row.id, row.sku_code);
  }
  if (idToSkuCode.size === 0) return out;

  // Step 2: ids → open PO rows. Reuse the existing id-based fetcher
  // (which is itself chunked).
  return await fetchOpenPoCostsBySkuCode([...idToSkuCode.keys()], idToSkuCode);
}

// Fetch open-PO unit costs grouped by sku_code. Third step in the
// cost-cascade — used when neither ip_item_avg_cost nor a sibling SKU has
// a value. ip_open_purchase_orders keys by sku_id (uuid), so the caller
// passes an id-to-sku_code translation map; we return only rows with a
// positive unit_cost AND positive qty_open (so closed-out PO lines that
// happen to still be in the table don't skew the average).
async function fetchOpenPoCostsBySkuCode(
  ids: string[],
  idToSkuCode: Map<string, string>,
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  if (!SB_URL || ids.length === 0) return out;
  // PostgREST `?sku_id=in.("uuid1","uuid2",...)` URLs grow ~40 chars per
  // UUID; at ~200+ ids the URL crosses the 8KB gateway limit and the
  // request 414s (and on a full-grid export with thousands of SKUs that
  // surfaces as a 3+ minute freeze). Chunk + parallel.
  const batches = chunkArray(ids, SB_IN_CHUNK);
  const responses = await Promise.all(batches.map(async (batch) => {
    const inList = batch.map((id) => `"${id}"`).join(",");
    const url = `${SB_URL}/rest/v1/ip_open_purchase_orders?select=sku_id,unit_cost,qty_open&sku_id=in.(${encodeURIComponent(inList)})&unit_cost=not.is.null&qty_open=gt.0&limit=${batch.length * 8}`;
    try {
      const r = await fetch(url, { headers: SB_HEADERS });
      if (!r.ok) {
        console.warn(`[ATS export] fetchOpenPoCostsBySkuCode batch failed: ${r.status}`);
        return [] as Array<{ sku_id: string; unit_cost: number | null; qty_open: number | null }>;
      }
      return (await r.json()) as Array<{ sku_id: string; unit_cost: number | null; qty_open: number | null }>;
    } catch (e) {
      console.warn("[ATS export] fetchOpenPoCostsBySkuCode batch error:", e);
      return [];
    }
  }));
  for (const rows of responses) {
    for (const row of rows) {
      const sku = idToSkuCode.get(row.sku_id);
      if (!sku) continue;
      if (typeof row.unit_cost !== "number" || row.unit_cost <= 0) continue;
      const list = out.get(sku) ?? [];
      list.push(row.unit_cost);
      out.set(sku, list);
    }
  }
  return out;
}

// Batch size for `?col=in.(...)` PostgREST URLs. PostgREST + the Vercel
// proxy in front of it reject URLs over ~8KB (414 URI Too Long); on the
// happy path the request still works at 100-200 entries even with long
// SKU strings. 150 leaves headroom for the SUPABASE_URL + headers and
// keeps each batch under ~6KB. With Promise.all, doubling the batch
// count costs almost nothing latency-wise (round trips parallelise).
const SB_IN_CHUNK = 150;

function chunkArray<T>(arr: T[], size: number): T[][] {
  if (arr.length <= size) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Fetch ip_item_avg_cost rows for a batch of sku_codes. This is the
// Xoro-authoritative avg unit cost (populated nightly by the Item Costing
// Report via /api/xoro/sync-item-costing). Used in the cross-grid synthetic
// rows in preference to ip_item_master.unit_cost — the latter is poisoned
// for some prepack SKUs (carries StandardUnitCost × MasterCaseQty from
// legacy Excel uploads, e.g. RYB059430 reads as $160.80 instead of $6.70).
//
// Chunks the SKU list into SB_IN_CHUNK-sized batches and fires them in
// parallel — a full-grid export can have 1500+ SKUs missing cost, and a
// single `in.(...)` URL would blow past PostgREST's URL-length limit.
async function fetchAvgCostBySkuCodes(skus: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!SB_URL || skus.length === 0) return out;
  const batches = chunkArray(skus, SB_IN_CHUNK);
  const responses = await Promise.all(batches.map(async (batch) => {
    const inList = batch.map((s) => `"${s.replace(/"/g, '\\"')}"`).join(",");
    const url = `${SB_URL}/rest/v1/ip_item_avg_cost?select=sku_code,avg_cost&sku_code=in.(${encodeURIComponent(inList)})&limit=${batch.length}`;
    try {
      const r = await fetch(url, { headers: SB_HEADERS });
      if (!r.ok) {
        console.warn(`[ATS export] fetchAvgCostBySkuCodes batch failed: ${r.status}`);
        return [] as Array<{ sku_code: string; avg_cost: number | null }>;
      }
      return (await r.json()) as Array<{ sku_code: string; avg_cost: number | null }>;
    } catch (e) {
      console.warn("[ATS export] fetchAvgCostBySkuCodes batch error:", e);
      return [];
    }
  }));
  for (const rows of responses) {
    for (const row of rows) {
      if (row.sku_code && typeof row.avg_cost === "number" && row.avg_cost > 0) {
        out.set(row.sku_code, row.avg_cost);
      }
    }
  }
  return out;
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
    explodePpk?: boolean,
  ) => void;
  // Grid's current Explode PPK toggle — passed through so the export
  // mirrors the grain the operator is looking at on screen.
  explodePpk: boolean;
  filtered: ATSRow[];
  // Auto-default for the export-options modal's customer dropdown.
  // Picks up whatever the grid toolbar currently has selected.
  customerFilter: string;
  // Grid-level filter state — applied to cross-grid synthetic rows so
  // the customer-history rows respect the same Category / Sub Cat /
  // Style / Gender / Status / search filters the operator has on
  // the grid. customerSkuSet is omitted because synthetic rows are
  // by definition NOT in the upload's open-order set (that's the
  // whole point of cross-grid) — the customer narrowing is already
  // enforced at the sales-history-fetch layer via customer_id.
  exportFilterOpts: {
    search: string;
    filterCategory: string[];
    filterSubCategory: string[];
    filterStyle: string[];
    filterGender: string;
    filterStatus: string;
    minATS: number | "";
    storeFilter: string[];
    today: Date;
  };
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
  // Ask AI panel — closure captures live grid state so the AI gets a
  // fresh snapshot per question. Setters are forwarded so the AI can
  // mutate filters/sort directly. Both optional — when omitted, the
  // Ask AI button stays hidden (useful for read-only embeds).
  aiBuildContext?: () => GridContextSnapshot;
  aiSetters?: AIGridSetters;
}

export const NavBar: React.FC<NavBarProps> = ({
  mergeHistory, undoLastMerge, onNavigateHome, setShowUpload,
  uploadingFile, invFile, purFile, ordFile,
  exportToExcel, filtered, displayPeriods, atShip, hiddenColumns, showTotalsRow, eventIndex, viewMode, generalMarginPct, onNegInven, onAgedInven, onDownloadIncompleteSkus, onDownloadStockVsSo,
  categories, filterCategory,
  customerFilter, exportFilterOpts, explodePpk,
  unreadNotifs, showingNotifications, onToggleNotifications,
  excelData, setExcelData,
  aiBuildContext, aiSetters,
}) => {
  const [aiOpen, setAiOpen] = useState(false);
  // Export-options modal — opens when the user picks "Export Excel"
  // from the Reports menu. Confirm callback fires exportToExcel with
  // the chosen options.
  const [exportOptsOpen, setExportOptsOpen] = useState(false);
  // While the modal's Export button is awaiting a sales pre-fetch we
  // render a small blocking "Loading sales history…" overlay so the
  // operator knows something is happening (fetch can take several
  // seconds for a 15-month window over thousands of SKUs).
  const [exportLoading, setExportLoading] = useState(false);
  // Cancel flag for the "Loading sales history…" overlay. useRef instead
  // of useState so the awaited code path can read it synchronously without
  // a render cycle. The in-flight fetch itself isn't aborted (the
  // background promise keeps populating the module-level sales cache so
  // the next attempt is free) — the cancel just frees the UI and skips
  // the rest of the export pipeline (no preview, no download).
  const exportCancelledRef = useRef(false);
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
    let rowsForExport = filtered.filter(r => !r.__collapsed);

    // Hydrate avgCost for rows the ATS snapshot left blank — typically
    // SKUs that are currently out-of-stock but have incoming POs (the
    // inventory snapshot only carries an Avg Cost column for on-hand
    // items). Without this, the export's Avg Cost / Total Cost /
    // Sls Prc @ N% columns render blank for those rows even when their
    // cost is perfectly computable elsewhere.
    //
    // Cascade (per the planner's rule, 2026-05-16):
    //   1. direct  — ip_item_avg_cost (Xoro Item Costing Report)
    //   2. sibling — another child SKU in the same base style
    //   3. po      — avg unit_cost across the SKU's open POs
    //   4. margin  — generalMarginPct against a sale price (not
    //                applied here; no per-row sale price in this flow)
    const needsHydrate = rowsForExport.filter((r) => !(typeof r.avgCost === "number" && r.avgCost > 0));
    if (needsHydrate.length > 0 && SB_URL) {
      const canonByRow = new Map<typeof rowsForExport[number], string>();
      for (const r of needsHydrate) {
        const c = canonStyleColor(r.sku);
        if (c) canonByRow.set(r, c);
      }
      const wanted = Array.from(new Set([...canonByRow.values()]));
      // Parallel-fetch the two backing maps. avgCostMap covers steps 1 + 2
      // (direct + sibling, since siblings are looked up via the same map).
      // openPoCostsBySku covers step 3.
      const [hydrateAvgCostMap, openPoCostsBySku] = await Promise.all([
        fetchAvgCostBySkuCodes(wanted),
        fetchOpenPoCostsByCanonicalSku(wanted),
      ]);
      // Sibling map across ALL rowsForExport canonical style codes so a
      // missing row can borrow cost from its in-stock variants too.
      const siblingRecords = rowsForExport.map((r) => {
        const canonical = canonStyleColor(r.sku);
        const style = canonical ? canonical.split("-")[0] : null;
        return { sku: canonical, basePart: style };
      }).filter((x) => x.sku);
      // Also include the in-stock rows' avgCost in the avg-cost map
      // — they're not in ip_item_avg_cost but are equally valid for
      // sibling-step lookups.
      const inStockAvgCost = new Map<string, number>();
      for (const r of rowsForExport) {
        const c = canonSku(r.sku);
        if (c && typeof r.avgCost === "number" && r.avgCost > 0) {
          inStockAvgCost.set(c, r.avgCost);
        }
      }
      const mergedAvgCostMap = new Map<string, number>(hydrateAvgCostMap);
      for (const [k, v] of inStockAvgCost) {
        if (!mergedAvgCostMap.has(k)) mergedAvgCostMap.set(k, v);
      }
      const siblingsBySku = buildSiblingMap(
        siblingRecords.map((x) => ({ sku: x.sku, basePart: x.basePart })),
      );

      let hydrated = 0;
      const sourceCounts = { direct: 0, sibling: 0, po: 0, margin: 0, unknown: 0 };
      rowsForExport = rowsForExport.map((r) => {
        if (typeof r.avgCost === "number" && r.avgCost > 0) return r;
        const canonical = canonByRow.get(r);
        if (!canonical) return r;
        const resolved = resolveCost(canonical, {
          avgCostMap: mergedAvgCostMap,
          siblingsBySku,
          openPoCostsBySku,
          generalMarginPct,
        });
        sourceCounts[resolved.source]++;
        if (resolved.cost && resolved.cost > 0) {
          hydrated++;
          // ip_item_avg_cost stores PACK-grain cost for prepack styles
          // (Xoro's Item Costing Report inherits its grain from how the
          // master treats the item — packs are billed/costed as packs).
          // The export expects r.avgCost to be per-UNIT and adjusts back
          // up via costMul when explodePpk is off; mirror compute.ts's
          // convention by dividing here. Non-prepack rows (ppkMult=1
          // or absent) are a no-op.
          const mult = typeof r.ppkMult === "number" && r.ppkMult > 1 ? r.ppkMult : 1;
          const unitGrainCost = resolved.cost / mult;
          return { ...r, avgCost: unitGrainCost };
        }
        return r;
      });
      console.info(
        `[ATS export] hydrate avgCost: ${hydrated}/${needsHydrate.length} resolved (direct=${sourceCounts.direct} sibling=${sourceCounts.sibling} po=${sourceCounts.po} margin=${sourceCounts.margin} unknown=${sourceCounts.unknown})`,
      );
    }

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
      // Reset the cancel flag at the start of each export attempt so a
      // prior cancel doesn't poison the next run.
      exportCancelledRef.current = false;
      setExportLoading(true);
      try {
        salesAggregates = await fetchSalesAggregates({
          rows: rowsForExport,
          needT3: opts.trailing3,
          needLY: opts.spLY,
          customer: opts.customer,
          // Custom window for the T3 block (and LY = same window -12mo).
          // Modal only persists non-empty strings when the operator has
          // both enabled the toggle AND picked dates — empty strings
          // here fall through to the fetcher's default "last 3 months".
          customStart: opts.customSalesRangeEnabled && opts.customSalesRangeStart ? opts.customSalesRangeStart : undefined,
          customEnd:   opts.customSalesRangeEnabled && opts.customSalesRangeEnd   ? opts.customSalesRangeEnd   : undefined,
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
                color: r.color, size: r.size, description: r.description,
                unit_cost: r.unit_cost,
                attributes: r.attributes ?? {},
              });
            }
          }

          // Hydrate the Xoro-authoritative avg unit cost for every SKU
          // in the cached set BEFORE building groups. ip_item_avg_cost
          // is the source of truth (populated nightly by the Item
          // Costing Report); preferring it over ip_item_master.unit_cost
          // dodges the legacy-poison bug where some prepack rows carry
          // StandardUnitCost × MasterCaseQty (e.g. RYB059430 reads
          // $160.80 instead of the real $6.70 per-unit). The resolver
          // also handles sibling + open-PO + margin fallbacks for SKUs
          // not yet covered by the Xoro report.
          const skuCodes = [...cached.values()]
            .map((r) => r?.sku_code)
            .filter((s): s is string => typeof s === "string" && s.length > 0);
          // ip_open_purchase_orders keys by sku_id (uuid). Pass an
          // id→sku_code translation so the cost map comes back in the
          // grain resolveCost expects.
          const idToSkuCode = new Map<string, string>();
          for (const [id, rec] of cached) {
            if (rec?.sku_code) idToSkuCode.set(id, rec.sku_code);
          }
          const cachedIds = [...idToSkuCode.keys()];
          const [avgCostMap, openPoCostsBySku] = await Promise.all([
            fetchAvgCostBySkuCodes(skuCodes),
            fetchOpenPoCostsBySkuCode(cachedIds, idToSkuCode),
          ]);
          const siblingsBySku = buildSiblingMap(
            [...cached.values()].map((r) => ({
              sku: r?.sku_code ?? "",
              basePart: r?.style_code ?? null,
            })),
          );

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
            // Resolved per-unit cost from the cost-cascade helper (direct
            // → sibling → open PO → margin). Tracked per group so the
            // first variant's resolution wins and we don't average across
            // different fallback sources for the same family.
            resolvedCost: number | null;
            costSource: string;
            // Largest ppkMult seen across the group's variants. Size variants
            // of a prepack family share the same multiplier in practice; we
            // take the max so a missing/unparseable size on one variant
            // doesn't downgrade the group to mult=1.
            ppkMult: number;
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
              // Cascade resolve cost for this (style, color) family. The
              // sale-price proxy for the margin fallback is the average T3
              // price across the family if available, else LY; null when
              // neither sales window has data (cascade falls through to
              // 'unknown' rather than guessing).
              const t3Agg = agg.t3Qty > 0 ? agg.t3Total / agg.t3Qty : null;
              const lyAgg = agg.lyQty > 0 ? agg.lyTotal / agg.lyQty : null;
              const salePrice = t3Agg ?? lyAgg ?? null;
              const resolved = resolveCost(rec.sku_code, {
                avgCostMap,
                siblingsBySku,
                openPoCostsBySku,
                generalMarginPct,
                salePrice,
              });
              g = {
                sku: groupSku,
                style: rec.style_code ?? null,
                color: rec.color ?? null,
                description: rec.description ?? null,
                category: rec.attributes?.group_name ?? null,
                subCategory: rec.attributes?.category_name ?? null,
                resolvedCost: resolved.cost,
                costSource: resolved.source,
                ppkMult: 1,
                t3Qty: 0, t3Total: 0, lyQty: 0, lyTotal: 0,
              };
              groups.set(key, g);
            }
            // Authoritative pack size from ip_item_master.pack_size.
            // 1 for non-prepacks; >1 for prepacks. Replaces the previous
            // regex on text fields.
            const mult = rec.pack_size ?? 1;
            if (mult > g.ppkMult) g.ppkMult = mult;
            g.t3Qty   += agg.t3Qty;
            g.t3Total += agg.t3Total;
            g.lyQty   += agg.lyQty;
            g.lyTotal += agg.lyTotal;
          }

          const synthetic: ATSRow[] = [];
          let perSourceCounts = { direct: 0, sibling: 0, po: 0, margin: 0, unknown: 0 };
          for (const g of groups.values()) {
            // The Xoro Item Costing Report stores cost at PACK grain
            // for prepack styles (RYB0412PPK avg cost is per-pack, not
            // per-unit). The cascade returns that raw value, but the
            // export's contract is "row.avgCost is always per-unit"
            // (export multiplies back to pack-grain via costMul when
            // explodePpk is off). Divide by ppkMult here so the row
            // matches the contract. Non-prepack rows (g.ppkMult=1) are
            // a no-op.
            const rawResolvedCost = g.resolvedCost ?? 0;
            const synthAvgCost = g.ppkMult > 1 ? rawResolvedCost / g.ppkMult : rawResolvedCost;
            const sourceKey = (g.costSource as keyof typeof perSourceCounts) || "unknown";
            perSourceCounts[sourceKey] = (perSourceCounts[sourceKey] ?? 0) + 1;
            synthetic.push({
              sku: g.sku,
              description: g.description ?? "",
              dates: {},
              freeMap: {},
              onHand: 0,
              onOrder: 0,
              onPO: 0,
              ppkMult: g.ppkMult,
              // Cascade-resolved cost; see resolveCost() — direct from
              // ip_item_avg_cost first, then sibling/PO/margin. Replaces
              // the legacy pack-grain ip_item_master.unit_cost path.
              avgCost: synthAvgCost,
              master_category:     g.category,
              master_sub_category: g.subCategory,
              master_style:        g.style,
              master_color:        g.color,
              master_description:  g.description,
              master_match_source: "sku",
            });
            // Merge the cross-grid (style, color) group's sales into
            // the existing salesAggregates entry rather than `.set`-
            // replacing. The regular path keyed `t3` / `ly` by the
            // ATS row's sku (e.g. "RCB1510NPT - Black"). The extras
            // path resolves OTHER size variants of the same style+
            // color that didn't map to any grid row — those are
            // ADDITIONAL sales, not a replacement. `.set` would have
            // wiped the regular contribution, causing the cell to
            // show only the extras and under-report the true total.
            if (g.t3Qty > 0 || g.t3Total > 0) {
              const existing = salesAggregates.t3.get(g.sku);
              if (existing) { existing.qty += g.t3Qty; existing.totalPrice += g.t3Total; }
              else salesAggregates.t3.set(g.sku, { qty: g.t3Qty, totalPrice: g.t3Total });
            }
            if (g.lyQty > 0 || g.lyTotal > 0) {
              const existing = salesAggregates.ly.get(g.sku);
              if (existing) { existing.qty += g.lyQty; existing.totalPrice += g.lyTotal; }
              else salesAggregates.ly.set(g.sku, { qty: g.lyQty, totalPrice: g.lyTotal });
            }
          }
          if (synthetic.length > 0) {
            // Apply the grid's filter state to the synthetic rows so
            // category / sub-cat / style / gender / status / search
            // narrowing applies uniformly. customerSkuSet is null
            // here — synthetic rows are by definition outside the
            // upload's open-order set (their inclusion is justified
            // by sales history, not current commitments). The
            // customer narrowing is already enforced upstream by the
            // sales-history fetch's customer_id filter.
            //
            // Drop any synthetic row whose sku is already in
            // rowsForExport. Without this dedupe, the same sku
            // appears twice in finalRows (once as the grid row, once
            // as the synthetic) and the bottom Total double-counts
            // its T3/LY sales via `for (const r of rows) t3Tot +=
            // t3Of(r.sku).totalPrice` summing the same lookup twice.
            // The merged aggregate above already accounts for the
            // extras' sales contribution; the synthetic row body is
            // only needed when no grid row carries the same sku.
            const existingSkus = new Set(rowsForExport.map(r => r.sku));
            const dedupedSynthetic = synthetic.filter(s => !existingSkus.has(s.sku));
            const filteredSynthetic = filterRows(dedupedSynthetic, {
              ...exportFilterOpts,
              customerSkuSet: null,
            });
            finalRows = [...rowsForExport, ...filteredSynthetic];
            console.info(`[ATS export] cross-grid: added ${filteredSynthetic.length} synthetic rows (of ${synthetic.length} candidates) by (style, color) from ${salesAggregates.extraBySkuId.size} unmapped sku_ids (${unresolved} unresolved, ${synthetic.length - filteredSynthetic.length} dropped by grid filters)`);
            console.info(
              `[ATS export] cross-grid cost cascade: direct=${perSourceCounts.direct} sibling=${perSourceCounts.sibling} po=${perSourceCounts.po} margin=${perSourceCounts.margin} unknown=${perSourceCounts.unknown}`,
            );
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
      // Operator clicked Cancel on the loading overlay — bail out before
      // building the preview / triggering the download. The background
      // sales preload keeps running so the next attempt benefits.
      if (exportCancelledRef.current) {
        console.info("[ATS export] cancelled by operator after sales fetch");
        return null;
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
      {aiBuildContext && aiSetters && (
        <button
          style={{
            ...S.navBtn,
            background: "#7C3AED",
            border: "1px solid #5B21B6",
            color: "#fff",
            fontWeight: 600,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            cursor: "pointer",
          }}
          onClick={() => setAiOpen(true)}
          title="Ask Claude about the grid — filter, sort, or get a quick answer"
        >
          ✨ Ask AI
        </button>
      )}
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

    {/* Ask AI slide-in panel — only mounted when caller wired the closure +
        setters. Closure is captured fresh on every send so the AI gets
        live filter/sort state. */}
    {aiBuildContext && aiSetters && (
      <AskAIPanel
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        buildContext={aiBuildContext}
        setters={aiSetters}
      />
    )}

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
          explodePpk,
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
          explodePpk,
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
        <div style={{ background: "#1E293B", padding: "18px 26px", borderRadius: 10, border: "1px solid #334155", boxShadow: "0 16px 48px rgba(0,0,0,0.6)", display: "flex", flexDirection: "column", alignItems: "center", gap: 14, minWidth: 260 }}>
          <div>Loading sales history…</div>
          <div style={{ fontSize: 11, fontWeight: 400, color: "#94A3B8", textAlign: "center", maxWidth: 320 }}>
            First export of the session fetches the 15-month window. Once it finishes, subsequent exports use the cache instantly.
          </div>
          <button
            onClick={() => {
              exportCancelledRef.current = true;
              setExportLoading(false);
            }}
            style={{
              background: "#334155", color: "#F1F5F9", border: "1px solid #475569",
              padding: "6px 16px", borderRadius: 6, fontSize: 12, fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
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
