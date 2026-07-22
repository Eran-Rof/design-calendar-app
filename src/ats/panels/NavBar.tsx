import React, { useEffect, useMemo, useRef, useState } from "react";
import S from "../styles";
import { fmtDateDisplay, pickColorImage } from "../helpers";
import type { ATSRow, ATSPoEvent, ATSSoEvent, ExcelData } from "../types";
import { computeGridTotals } from "../computeTotals";
import { ExportOptionsModal, type ExportOptions } from "./ExportOptionsModal";
import { ExportPreviewModal } from "./ExportPreviewModal";
import { SalesCompsModal } from "./SalesCompsModal";
import { fetchSalesAggregates, type SalesFetchResult } from "../exportSalesFetch";
import { buildExportPayload, type ExportPayload, type AtsSizeMatrixResponse } from "../exportExcel";
import { fetchDataUrls, type ExportImage } from "../../shared/exportImages";
import type { ReportPayload } from "../reportPayload";
import type { IncompleteSkusResult } from "../exportIncompleteSkus";
import type { StockVsSoResult } from "../exportStockVsSo";
import { getItemMasterById } from "../itemMasterLookup";
import { periodAvail } from "../compute";
import { filterRows } from "../filter";
import { resolveCost, buildSiblingMap } from "../../shared/costResolution";
import { SB_URL, SB_HEADERS } from "../../utils/supabase";
import { canonSku, canonStyleColor } from "../../inventory-planning/utils/skuCanon";
import { AskAIPanel } from "../../ai/AskAIPanel";
import type { AIGridSetters, GridContextSnapshot } from "../../ai/tools";
import { onAskAIRequest } from "../../ai/askAIBridge";
import { ATS_REPORT_KEYS, type AtsReportKey, getAtsReportPermissionsFromSession } from "../../permissions";
import { usePersonalization } from "../../hooks/usePersonalization";
import FavoritesMenu from "../../components/FavoritesMenu";
import SearchableSelect from "../../tanda/components/SearchableSelect";

// Build "STYLE|COLOR" → base64 data URL for the export's Image column. Resolves
// each row's color-matched thumbnail (byColor[color] → style default) from the
// PIM (same source + match logic as the grid), fetches the bytes (deduped),
// and keys by the same STYLE|COLOR the export looks up. Failures are skipped —
// a missing thumbnail never blocks the export.
async function buildStyleImageMap(rows: ATSRow[]): Promise<Map<string, ExportImage>> {
  const codes = Array.from(new Set(rows.map((r) => (r.master_style ?? "").trim().toUpperCase()).filter(Boolean)));
  if (codes.length === 0) return new Map();
  let info: Record<string, { default: string | null; byColor: Record<string, string> }> = {};
  try {
    const res = await fetch("/api/internal/pim/style-thumbs-by-code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ style_codes: codes, variant: "web" }),
    });
    if (res.ok) info = await res.json();
  } catch { /* no images — column just stays blank */ }
  const keyToUrl = new Map<string, string>();
  const urls = new Set<string>();
  for (const r of rows) {
    const code = (r.master_style ?? "").trim().toUpperCase();
    const colorRaw = (r.master_color ?? "").trim();
    const ent = info[code];
    if (!ent) continue;
    const url = pickColorImage(ent.byColor, colorRaw, ent.default ?? null) ?? "";
    if (!url) continue;
    keyToUrl.set(`${code}|${colorRaw.toUpperCase()}`, url);
    urls.add(url);
  }
  if (urls.size === 0) return new Map();
  // Trim the white studio background so the garment fills the export cell
  // (PIM shots frame the product in a tall white canvas).
  const dataByUrl = await fetchDataUrls([...urls], { trimWhitespace: true });
  const out = new Map<string, ExportImage>();
  for (const [key, url] of keyToUrl) { const d = dataByUrl.get(url); if (d) out.set(key, d); }
  return out;
}

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
    hiddenColumns: string[],
    totals?: import("../computeTotals").GridTotals | null,
    options?: ExportOptions,
    eventIndex?: Record<string, Record<string, { pos: ATSPoEvent[]; sos: ATSSoEvent[] }>> | null,
    salesAggregates?: SalesFetchResult,
    explodePpk?: boolean,
    customerSoMap?: Map<string, { qty: number; soPrice: number }>,
    sizeMatrix?: AtsSizeMatrixResponse,
    bulkByStyleColor?: Map<string, { so: number; po: number }>,
    periodMatrices?: Array<{ name: string; matrix: AtsSizeMatrixResponse }>,
    styleImages?: Map<string, ExportImage>,
  ) => void;
  // Grid's current Explode PPK toggle — passed through so the export
  // mirrors the grain the operator is looking at on screen.
  explodePpk: boolean;
  // The CALC set — filtered rows MINUS the operator's excluded ("X") rows.
  // This is what every report/export consumes by default, so exclusions
  // flow through automatically. The "Include" choice in the exclusion
  // warning swaps in `fullFiltered`.
  filtered: ATSRow[];
  // The full filtered set INCLUDING excluded rows — used only when the
  // operator picks "Include" in the pre-report exclusion warning.
  fullFiltered: ATSRow[];
  // Rows the operator has excluded via the "X" column (for the warning
  // list shown before a report runs). Empty = no warning, reports run
  // straight through.
  excludedRows: ATSRow[];
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
    filterGender: string[];
    filterStatus: string;
    minATS: number | "";
    storeFilter: string[];
    today: Date;
  };
  // Full display periods carry the key+periodStart needed by
  // computeGridTotals. The exporter itself only needs endDate + label,
  // so we ship the wider shape and let each consumer pick.
  displayPeriods: Array<{ key: string; periodStart: string; endDate: string; label: string }>;
  hiddenColumns: string[];
  // When TOTALS toggle is on, the export drops the right-side Total
  // column + simple bottom Total row and emits a 5-row Cost/Sale/Mrgn
  // stack instead. Passed as a flag so the resolve chain only runs at
  // click time, not on every NavBar render.
  showTotalsRow: boolean;
  eventIndex: Record<string, Record<string, { pos: ATSPoEvent[]; sos: ATSSoEvent[] }>> | null;
  viewMode: "ats" | "so" | "po";
  generalMarginPct: number;
  // All four report handlers return a payload (or sentinel) that the
  // NavBar feeds into the shared preview modal. Download is deferred
  // to the modal's Download button so every ATS report gets a
  // view-before-download flow with app-themed preview colors. The
  // downloaded .xlsx keeps the Excel-native palette unchanged.
  // includeExcluded (from the pre-report exclusion warning) decides whether
  // the "X"-marked rows are counted in the report; default excludes them.
  onNegInven: (includeExcluded?: boolean) => ReportPayload | null;
  onAgedInven: (days: number, category: string, includeExcluded?: boolean) => "empty" | ReportPayload;
  onDownloadIncompleteSkus: (includeExcluded?: boolean) => IncompleteSkusResult;
  onDownloadStockVsSo: (includeExcluded?: boolean) => StockVsSoResult;
  categories: string[];
  // Full filter option lists from the broader dataset — used by Sales
  // Comps so the operator can broaden the report past the grid's
  // current filter (e.g. add another category that isn't on screen).
  subCategories: string[];
  styles: string[];
  STORES: string[];
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
  // Filtered-row count + last sync timestamp. Rendered as a small
  // metadata block in the navbar (right of "Available to Sell"), so
  // the operator can see "1,087 SKUs / Synced ..." without scrolling
  // past the totals row to find it on the toolbar.
  filteredCount: number;
  lastSync: string;
}

export const NavBar: React.FC<NavBarProps> = ({
  mergeHistory, undoLastMerge, onNavigateHome, setShowUpload,
  uploadingFile, invFile, purFile, ordFile,
  exportToExcel, filtered, fullFiltered, excludedRows, displayPeriods, hiddenColumns, showTotalsRow, eventIndex, viewMode, generalMarginPct, onNegInven, onAgedInven, onDownloadIncompleteSkus, onDownloadStockVsSo,
  categories, subCategories, styles, STORES, filterCategory,
  customerFilter, exportFilterOpts, explodePpk,
  unreadNotifs, showingNotifications, onToggleNotifications,
  excelData, setExcelData,
  aiBuildContext, aiSetters,
  filteredCount, lastSync,
}) => {
  const [aiOpen, setAiOpen] = useState(false);
  // Cross-cutter T4-5 — personalization. Fire-and-forget menu-click
  // telemetry for the Reports popover entries. Each report's menu_key
  // is static (it's the same entry in the registry regardless of which
  // operator opens it), so we log here rather than in the report's own
  // handler.
  const { logClick: logReportClick } = usePersonalization();
  // PR 4/4: draft input pushed in from outside (e.g. right-click on a
  // grid row dispatching an "ask AI" event). Consumed by AskAIPanel
  // on next render then cleared by the onDraftInputConsumed callback.
  const [aiDraftInput, setAiDraftInput] = useState<string | null>(null);
  useEffect(() => {
    const off = onAskAIRequest(req => {
      setAiDraftInput(req.prompt);
      setAiOpen(true);
    });
    return off;
  }, []);
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
  // to flush the same payload to a file. Uses the wider ReportPayload
  // shape so every ATS export (main grid + the 4 special reports) can
  // route through the same modal.
  const [previewPayload, setPreviewPayload] = useState<ReportPayload | null>(null);
  // Body row count for the preview header (header row excluded).
  const [previewBodyCount, setPreviewBodyCount] = useState(0);
  // When set, the preview's Back button returns to the matching options
  // modal (currently only the main-grid export uses Back; the other 4
  // reports don't have an options modal and so the modal hides Back).
  const [previewBackTarget, setPreviewBackTarget] = useState<"exportOpts" | null>(null);

  // Push a payload into the preview modal. Centralized so all 5 reports
  // route through the same code path — opening the modal, computing the
  // body-row count, and remembering which (if any) options modal Back
  // should return to.
  const openPreview = (payload: ReportPayload | ExportPayload, backTarget: "exportOpts" | null = null) => {
    // ExportPayload doesn't require title; ReportPayload does. Fall
    // back to a sensible default when the payload came from a legacy
    // call site that hadn't set one yet.
    const normalized: ReportPayload = {
      title: payload.title ?? "Export",
      aoa: payload.aoa,
      wb: payload.wb,
      filename: payload.filename,
      // Preserve the non-main worksheet AOAs (By Size Matrix + per-period
      // tabs) — without this the preview's tab lookup finds nothing and the
      // matrix/period tabs render blank.
      extraSheets: payload.extraSheets,
    };
    setPreviewPayload(normalized);
    setPreviewBodyCount(Math.max(0, payload.aoa.length - 1));
    setPreviewBackTarget(backTarget);
  };
  const [agedOpen, setAgedOpen] = useState(false);
  const [agedDays, setAgedDays] = useState("365");
  const [agedCategory, setAgedCategory] = useState(filterCategory);
  const [agedEmpty, setAgedEmpty] = useState(false);
  const [salesCompsOpen, setSalesCompsOpen] = useState(false);
  // Reports dropdown — collapses the previous five always-visible green
  // export buttons (Export Excel / Neg Inven / Aged Inven / NO Mrgn Data /
  // Stock Vs SO) into one button + popover menu. Each menu entry fires the
  // same handler that the dedicated buttons used to fire; the Aged Inven
  // entry still opens the days/category modal before downloading.
  const [reportsOpen, setReportsOpen] = useState(false);
  // ── Pre-report exclusion warning ──────────────────────────────────────
  // When any report/export runs while rows are excluded ("X" column), we
  // first show a warning listing the excluded styles with Continue (run
  // excluding them) / Cancel / Include (count them this once). `excludeGate`
  // holds the pending runner (a fn of `includeExcluded`); `reportInclude`
  // carries the choice into the deferred modal-based reports (Export Excel,
  // Sales Comps) that read it at build time.
  const hasExclusions = (excludedRows?.length ?? 0) > 0;
  const [excludeGate, setExcludeGate] = useState<{ run: (include: boolean) => void } | null>(null);
  const [reportInclude, setReportInclude] = useState(false);
  // Run a report through the exclusion gate. No exclusions → run straight
  // through (excluding nothing). Otherwise stash the runner and open the
  // warning modal.
  const gateReport = (run: (include: boolean) => void) => {
    if (hasExclusions) { setReportsOpen(false); setExcludeGate({ run }); }
    else run(false);
  };
  const resolveGate = (include: boolean) => {
    const g = excludeGate;
    setExcludeGate(null);
    g?.run(include);
  };
  // Distinct excluded styles for the warning list (style # + description).
  const excludedStyleList = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ style: string; description: string }> = [];
    for (const r of excludedRows ?? []) {
      const style = r.master_style ?? r.sku;
      if (seen.has(style)) continue;
      seen.add(style);
      out.push({ style, description: r.master_description ?? r.description ?? "" });
    }
    return out.sort((a, b) => a.style.localeCompare(b.style));
  }, [excludedRows]);
  // Per-report permission gate (default-true semantics — see
  // getAtsReportPermissionsFromSession). Resolved once per render; the
  // session payload only changes on login/logout so there's no value in
  // subscribing to storage events here.
  const atsReportsPerm = getAtsReportPermissionsFromSession();
  const anyReportAllowed = ATS_REPORT_KEYS.some(k => atsReportsPerm[k]);
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


  // Shared pre-flight for both Export and View. Drops collapsed rows,
  // optionally builds GridTotals, and fetches sales aggregates from the
  // nightly DB when trailing3 / SP-LY is on. Returns null when the
  // sales pre-fetch failed catastrophically (the modal stays open so
  // the operator can retry or adjust).
  async function prepareExportArgs(opts: ExportOptions) {
    // Base set respects the exclusion choice: default = calc set (excluded
    // dropped); "Include" = full filtered set.
    const baseRows = reportInclude ? fullFiltered : filtered;
    let rowsForExport = baseRows.filter(r => !r.__collapsed);

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
          viewMode,
          eventIndex,
          generalMarginPct,
        })
      : null;

    let salesAggregates: SalesFetchResult | undefined;
    let finalRows = rowsForExport;
    // Sls Prc Mrgn % column needs T3-by-style (always) + customer-last-
    // price (only when a customer is selected). Both ride on the same
    // sales-history scan, so toggling Sls Prc @ extends the fetch trigger
    // even when neither T3 nor LY column is checked.
    const customerSelected = Array.isArray(opts.customer)
      ? opts.customer.length > 0
      : !!opts.customer && opts.customer.trim().length > 0;
    const needMrgnPctFetch = !!opts.slsPrcAtMrgn;
    if (opts.trailing3 || opts.spLY || needMrgnPctFetch) {
      // Reset the cancel flag at the start of each export attempt so a
      // prior cancel doesn't poison the next run.
      exportCancelledRef.current = false;
      setExportLoading(true);
      try {
        salesAggregates = await fetchSalesAggregates({
          rows: rowsForExport,
          needT3: opts.trailing3,
          needLY: opts.spLY,
          needT3ByStyle: needMrgnPctFetch,
          needLastCustomerPriceBySku: needMrgnPctFetch && customerSelected,
          customer: opts.customer,
          // Honour the grid's store filter so T3/LY revenue matches
          // the visible-row scope. Without this, ROF wholesale sales
          // would bleed into a ROF ECOM-only export's totals (see
          // migration 20260518030000 for context).
          storeFilter: exportFilterOpts.storeFilter,
          // Other on-screen filters — passed so the sales aggregation
          // can decouple from the grid's visible-SKU set and reconcile
          // cross-store math (see project_ats_export_grain_handoff_2026_05_18).
          filterCategory:    exportFilterOpts.filterCategory,
          filterSubCategory: exportFilterOpts.filterSubCategory,
          filterStyle:       exportFilterOpts.filterStyle,
          // Custom window for the T3 block (and LY = same window -12mo).
          // Modal only persists non-empty strings when the operator has
          // both enabled the toggle AND picked dates — empty strings
          // here fall through to the fetcher's default "last 3 months".
          customStart: opts.customSalesRangeEnabled && opts.customSalesRangeStart ? opts.customSalesRangeStart : undefined,
          customEnd:   opts.customSalesRangeEnabled && opts.customSalesRangeEnd   ? opts.customSalesRangeEnd   : undefined,
        });

        // Cross-grid: surface SKUs with channel-/customer-/cat-matching
        // sales that aren't visible in the current grid (shipped through,
        // no open commitments; or grid presence only via an excluded
        // store tag). The fetcher collected those as extraBySkuId keyed
        // by ip_item_master.id. Resolve each id via the cache first;
        // for any not in the local cache, hit Supabase once for the
        // batch so newly-added or never-carried styles also surface.
        //
        // Activation: previously customer-only. Now also triggers when a
        // specific store filter or cat/sub-cat/style filter is active,
        // because those filters' totals only reconcile when synthetic
        // cross-grid rows are included (see project_ats_export_grain_
        // handoff_2026_05_18). The fetcher already aligned its
        // shouldCollectExtras gate, so the size check here is sufficient.
        if (salesAggregates.extraBySkuId.size > 0) {
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
            t3Qty: number; t3Total: number; t3Margin: number;
            lyQty: number; lyTotal: number; lyMargin: number;
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
                t3Qty: 0, t3Total: 0, t3Margin: 0,
                lyQty: 0, lyTotal: 0, lyMargin: 0,
              };
              groups.set(key, g);
            }
            // Authoritative pack size from ip_item_master.pack_size.
            // 1 for non-prepacks; >1 for prepacks. Replaces the previous
            // regex on text fields.
            const mult = rec.pack_size ?? 1;
            if (mult > g.ppkMult) g.ppkMult = mult;
            g.t3Qty    += agg.t3Qty;
            g.t3Total  += agg.t3Total;
            g.t3Margin += agg.t3Margin;
            g.lyQty    += agg.lyQty;
            g.lyTotal  += agg.lyTotal;
            g.lyMargin += agg.lyMargin;
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
              if (existing) { existing.qty += g.t3Qty; existing.totalPrice += g.t3Total; existing.marginAmount += g.t3Margin; }
              else salesAggregates.t3.set(g.sku, { qty: g.t3Qty, totalPrice: g.t3Total, marginAmount: g.t3Margin });
            }
            if (g.lyQty > 0 || g.lyTotal > 0) {
              const existing = salesAggregates.ly.get(g.sku);
              if (existing) { existing.qty += g.lyQty; existing.totalPrice += g.lyTotal; existing.marginAmount += g.lyMargin; }
              else salesAggregates.ly.set(g.sku, { qty: g.lyQty, totalPrice: g.lyTotal, marginAmount: g.lyMargin });
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
              displayPeriods,
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

    // Customer-narrowed SO summary per (sku, store). Built only when a
    // customer is selected; passed to the export so the On Order column
    // shows ONLY this customer's SO qty and the inserted "SO Prc" column
    // shows the qty-weighted avg unit price from those SOs.
    //
    // GRAIN CONVERSION (critical):
    // Xoro stores SO qty + unitPrice in PACK grain for prepack SKUs
    // (so.qty=10 means 10 packs of a PPK60 → 600 units; so.unitPrice is
    // per-pack). compute.ts already multiplies r.onOrder by mult to land
    // at unit-grain, so our customerSoMap.qty must also be unit-grain or
    // the body's `qty / qtyDiv` display would silently render pack-grain
    // when explodePpk=true. Symmetric divide for unitPrice → per-unit
    // price. Then exportExcel applies costMul on display so pack mode
    // gets pack-grain price back.
    let customerSoMap: Map<string, { qty: number; soPrice: number }> | undefined;
    if (customerSelected && excelData?.sos?.length) {
      const wantedNames = Array.isArray(opts.customer)
        ? new Set(opts.customer.map((s) => s.trim()).filter(Boolean))
        : new Set([opts.customer.trim()].filter(Boolean));
      // (sku, store) → ppkMult lookup, sourced from the row set since
      // each row already has the resolved mult from compute.ts.
      const multByKey = new Map<string, number>();
      for (const r of finalRows) {
        const k = `${r.sku}::${r.store ?? "ROF"}`;
        const m = (typeof r.ppkMult === "number" && r.ppkMult > 0) ? r.ppkMult : 1;
        if (!multByKey.has(k)) multByKey.set(k, m);
      }
      const acc = new Map<string, { qty: number; rev: number }>();
      for (const so of excelData.sos) {
        if (!wantedNames.has(so.customerName)) continue;
        const key = `${so.sku}::${so.store ?? "ROF"}`;
        const mult = multByKey.get(key) ?? 1;
        const qtyRaw = so.qty ?? 0;
        if (qtyRaw <= 0) continue;
        const unitPackPrice = so.unitPrice ?? (so.totalPrice ?? 0) / qtyRaw;
        // PACK qty → UNIT qty (multiply); per-PACK price → per-UNIT price
        // (divide). For non-prepack rows (mult=1) both are no-ops.
        const qtyUnit = qtyRaw * mult;
        const perUnitPrice = mult > 0 ? unitPackPrice / mult : unitPackPrice;
        const cur = acc.get(key);
        if (cur) { cur.qty += qtyUnit; cur.rev += perUnitPrice * qtyUnit; }
        else acc.set(key, { qty: qtyUnit, rev: perUnitPrice * qtyUnit });
      }
      if (acc.size > 0) {
        customerSoMap = new Map();
        for (const [key, v] of acc) {
          customerSoMap.set(key, { qty: v.qty, soPrice: v.qty > 0 ? v.rev / v.qty : 0 });
        }
      }
    }

    // By Size Matrix worksheet(s). The size cells show TRUE size-grain
    // ATS-available straight from /api/internal/ats-size-matrix (on-hand −
    // reservations [+ incoming-by-period for the period tabs], per size) so the
    // matrix MATCHES Tangerine/Xoro per size (operator decision — supersedes
    // the earlier reprojection that split the main report's color total by an
    // on-hand shape). NOTE: because the size cells are true size-grain and the
    // main report's color total is netted vs the color-grain Xoro On Order, the
    // matrix per-color total can differ from the main color sheet by the
    // netting. SO/PO stay the main report's loose On Order / On PO (color-grain
    // — no size split); PPK packs come from the PPK style rows' ATS.
    let sizeMatrix: AtsSizeMatrixResponse | undefined;
    let bulkByStyleColor: Map<string, { so: number; po: number }> | undefined;
    let periodMatrices: Array<{ name: string; matrix: AtsSizeMatrixResponse }> | undefined;
    if (opts.bySizeMatrix) {
      const stemOf = (s: string) => s.replace(/-?PPK\d*$/i, "").toUpperCase();
      const isPpk = (s: string) => /PPK/i.test(s);
      const styleOf = (r: ATSRow) => (r.master_style && r.master_style.trim()) || String(r.sku || "").split(" - ")[0].trim();
      const colorOf = (r: ATSRow) => (r.master_color && r.master_color.trim()) || String(r.sku || "").split(" - ").slice(1).join(" - ").trim();
      const nPer = periods.length;

      type CAcc = { color: string; so: number; po: number; total: number; per: number[]; ppkSo: number; ppkPo: number; ppkUnitsTotal: number; ppkUnitsPer: number[] };
      const byStem = new Map<string, { packSize: number; colors: Map<string, CAcc> }>();
      const ensureStem = (stem: string) => { let s = byStem.get(stem); if (!s) { s = { packSize: 0, colors: new Map() }; byStem.set(stem, s); } return s; };
      const ensureColor = (st: { colors: Map<string, CAcc> }, color: string) => {
        const k = color.toUpperCase(); let c = st.colors.get(k);
        if (!c) { c = { color, so: 0, po: 0, total: 0, per: Array(nPer).fill(0), ppkSo: 0, ppkPo: 0, ppkUnitsTotal: 0, ppkUnitsPer: Array(nPer).fill(0) }; st.colors.set(k, c); }
        return c;
      };
      for (const r of finalRows) {
        if (r.__collapsed) continue; // aggregate rows would double-count
        const styleRaw = styleOf(r); if (!styleRaw) continue;
        const st = ensureStem(stemOf(styleRaw));
        const ca = ensureColor(st, colorOf(r));
        const perVals = periods.map((_, i) => periodAvail(r, periods, i));
        const tot = perVals.reduce((a, b) => a + b, 0);
        if (isPpk(styleRaw)) {
          const mult = (r.ppkMult && r.ppkMult > 1) ? r.ppkMult : 1;
          if (mult > 1) st.packSize = mult;
          ca.ppkSo += Number(r.onOrder) || 0;
          ca.ppkPo += Number(r.onPO) || 0;
          ca.ppkUnitsTotal += tot;
          perVals.forEach((v, i) => { ca.ppkUnitsPer[i] += v; });
        } else {
          ca.so += Number(r.onOrder) || 0;
          ca.po += Number(r.onPO) || 0;
          ca.total += tot;
          perVals.forEach((v, i) => { ca.per[i] += v; });
        }
      }

      // Bulk SO/PO for the matrix builder: loose On Order / On PO keyed by the
      // loose stem; when exploding, PPK rows become their own block keyed by
      // "<stem>PPK" so they pick up the PPK style's own On Order / On PO.
      bulkByStyleColor = new Map();
      for (const [stem, st] of byStem) for (const ca of st.colors.values()) {
        bulkByStyleColor.set(`${stem}|${ca.color.toUpperCase()}`, { so: ca.so, po: ca.po });
        bulkByStyleColor.set(`${stem}PPK|${ca.color.toUpperCase()}`, { so: ca.ppkSo, po: ca.ppkPo });
      }

      const styleCodes = [...byStem.keys()];
      if (styleCodes.length > 0) {
        const fetchShape = async (asOf?: string): Promise<AtsSizeMatrixResponse | null> => {
          try {
            const resp = await fetch("/api/internal/ats-size-matrix", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify(asOf ? { style_codes: styleCodes, as_of_date: asOf } : { style_codes: styleCodes }),
            });
            return resp.ok ? await resp.json() : null;
          } catch { return null; }
        };
        // stem(upper) → { sizes, style_name, packFromShape, shapeByColor: colorUpper → by_size }
        const indexShape = (resp: AtsSizeMatrixResponse | null) => {
          const m = new Map<string, { sizes: string[]; style_name: string; packFromShape: number; shapeByColor: Map<string, Record<string, number>> }>();
          for (const s of resp?.styles ?? []) {
            const shapeByColor = new Map<string, Record<string, number>>();
            for (const c of s.colors ?? []) shapeByColor.set(String(c.color).toUpperCase(), c.by_size || {});
            m.set(String(s.style_code).toUpperCase(), { sizes: s.sizes || [], style_name: s.style_name || s.style_code, packFromShape: s.pack_size || 0, shapeByColor });
          }
          return m;
        };
        // Reproject one display matrix from per-(stem,color) totals + a shape.
        const buildDisplay = (
          metaIdx: ReturnType<typeof indexShape>,
          shapeIdx: ReturnType<typeof indexShape>,
          pickPpkUnits: (ca: CAcc) => number,
        ): AtsSizeMatrixResponse => {
          const styles: AtsSizeMatrixResponse["styles"] = [];
          for (const [stem, st] of byStem) {
            const meta = metaIdx.get(stem) || { sizes: [], style_name: stem, packFromShape: 0, shapeByColor: new Map() };
            const packSize = st.packSize || meta.packFromShape || 0;
            const shapeStem = shapeIdx.get(stem);

            // Loose block — units by size. When Explode PPK is OFF the PPK pack
            // count rides as a column here; when ON, PPK becomes its own block
            // below so this column stays empty.
            const looseColors: AtsSizeMatrixResponse["styles"][number]["colors"] = [];
            for (const ca of st.colors.values()) {
              const ppkPacks = (!explodePpk && packSize > 1) ? Math.round(pickPpkUnits(ca) / packSize) : 0;
              // TRUE size-grain available straight from the ats-size-matrix
              // shape (on-hand − reservations [+ incoming for period tabs]).
              // total_eachs = Σ over the scale's sizes. No reprojection.
              const shape = shapeStem?.shapeByColor.get(ca.color.toUpperCase()) || {};
              const bySize: Record<string, number> = {};
              let sizeTot = 0;
              for (const sz of meta.sizes) {
                const q = Number(shape[sz]) || 0;
                if (q > 0) { bySize[sz] = q; sizeTot += q; }
              }
              if (sizeTot <= 0 && ppkPacks <= 0) continue;
              looseColors.push({ color: ca.color, by_size: bySize, total_eachs: sizeTot, ppk_packs: ppkPacks });
            }
            if (looseColors.length) styles.push({ style_code: stem, style_name: meta.style_name, sizes: meta.sizes, pack_size: packSize, colors: looseColors.sort((a, b) => a.color.localeCompare(b.color)) });

            // Explode ON → PPK style as its OWN block (main-report row format):
            // exploded units as a BULK number in the ATS/Total Eachs column
            // (size cells blank until prepack compositions are configured), with
            // the pack count alongside (PPK / Total PPK<n>). e.g. 10 PPK24 = 240.
            if (explodePpk && packSize > 1) {
              const ppkColors: AtsSizeMatrixResponse["styles"][number]["colors"] = [];
              for (const ca of st.colors.values()) {
                const units = pickPpkUnits(ca);
                if (units <= 0) continue;
                ppkColors.push({ color: ca.color, by_size: {}, total_eachs: units, ppk_packs: Math.round(units / packSize) });
              }
              if (ppkColors.length) styles.push({ style_code: `${stem}PPK`, style_name: `${meta.style_name} — Prepacks (exploded units)`, sizes: meta.sizes, pack_size: packSize, colors: ppkColors.sort((a, b) => a.color.localeCompare(b.color)) });
            }
          }
          return { as_of: null, styles };
        };

        const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
        const toIso = (d: string): string | null => {
          if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
          const dt = new Date(d); return isNaN(dt.getTime()) ? null : `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
        };
        const nameOf = (endDate: string, label: string) => { const dt = new Date(endDate); return isNaN(dt.getTime()) ? label : `${MONTHS[dt.getMonth()]} ${dt.getFullYear()}`; };

        // Snapshot shape (on-hand by size) → metadata + the snapshot tab's shape.
        const metaIdx = indexShape(await fetchShape());

        // Per-period shapes (as_of), in parallel, capped.
        const periodsToFetch = displayPeriods.slice(0, 24);
        const shapeResps = await Promise.all(periodsToFetch.map(async (p, i) => ({ p, i, shape: indexShape(toIso(p.endDate) ? await fetchShape(toIso(p.endDate)!) : null) })));

        // Snapshot tab = TRUE current size-grain available (on-hand − reservations).
        sizeMatrix = buildDisplay(metaIdx, metaIdx, (ca) => ca.ppkUnitsTotal);
        // One tab per period = TRUE size-grain available as of that period (adds
        // incoming size-grain PO due by then), straight from that period's shape.
        periodMatrices = [];
        for (const { p, i, shape } of shapeResps) {
          const display = buildDisplay(metaIdx, shape, (ca) => ca.ppkUnitsPer[i]);
          if (display.styles.length) periodMatrices.push({ name: nameOf(p.endDate, p.label), matrix: display });
        }
      }
    }

    // Style thumbnails for the optional Image column — fetched here (async)
    // so buildExportPayload stays synchronous. Off → undefined → no column.
    const styleImages = opts.images ? await buildStyleImageMap(finalRows) : undefined;
    return { rowsForExport: finalRows, periods, totals, salesAggregates, customerSoMap, sizeMatrix, bulkByStyleColor, periodMatrices, styleImages };
  }

  return (
  <nav style={S.nav}>
    <div style={S.navLeft}>
      <div style={S.navLogo}>ATS</div>
      <span style={S.navTitle}>ATS Report</span>
      <span style={S.navSub}>Available to Sell</span>
      {/* Filtered-row count + last sync. Moved here from the toolbar
          (2026-05-20) so the operator sees the totals without having
          to scroll past the totals row. lastSync is a UTC ISO from
          the server; we display the LOCAL date+time so they always
          agree (toLocaleTimeString flipping past midnight UTC was
          producing date/time mismatches when the operator was
          UTC- and the sync ran late local-time). */}
      <span style={{
        ...S.navSub,
        marginLeft: 8, paddingLeft: 12,
        borderLeft: "1px solid #334155",
        display: "inline-flex", flexDirection: "column", lineHeight: 1.25,
      }}>
        <span>{filteredCount.toLocaleString()} SKUs</span>
        {lastSync && (() => {
          const d = new Date(lastSync);
          const localIso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
          return <span style={{ fontSize: 11, color: "#475569" }}>Synced {fmtDateDisplay(localIso)} {d.toLocaleTimeString()}</span>;
        })()}
      </span>
    </div>
    <div style={S.navRight}>
      {/* Favorites — first action icon (consistent across all apps). */}
      <FavoritesMenu />
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
                menuKey: "ats/reports/export-excel",
                label: "Export Excel…",
                sub: "Pick subtotals / cost / trailing options, then view + download",
                onClick: () => gateReport((include) => { setReportInclude(include); setExportOptsOpen(true); }),
              },
              {
                key: "negInven",
                menuKey: "ats/reports/neg-inven",
                label: "Neg Inven",
                sub: "Preview the negative-inventory report, then download",
                onClick: () => gateReport((include) => {
                  const payload = onNegInven(include);
                  if (!payload) {
                    alert("No negative-ATS rows in the current grid filter.");
                    return;
                  }
                  openPreview(payload);
                }),
              },
              {
                key: "agedInven",
                menuKey: "ats/reports/aged-inven",
                label: "Aged Inven…",
                sub: "Pick a days threshold + category, then view + download",
                onClick: () => { setAgedCategory(filterCategory); setAgedEmpty(false); setAgedOpen(true); },
              },
              {
                key: "noMrgnData",
                menuKey: "ats/reports/no-mrgn",
                label: "NO Mrgn Data",
                sub: "Styles with no open SO, no avg cost, no PO cost (the red Mrgn:* asterisks)",
                onClick: () => gateReport((include) => {
                  const { payload } = onDownloadIncompleteSkus(include);
                  openPreview(payload);
                }),
              },
              {
                key: "stockVsSo",
                menuKey: "ats/reports/stock-vs-so",
                label: "Stock Vs SO",
                sub: "Per-SO breakdown: stock-fill vs incoming PO vs needs-new-PO",
                onClick: () => gateReport((include) => {
                  const result = onDownloadStockVsSo(include);
                  if (result.kind === "no-events") {
                    alert("No event data loaded — open the ATS report and let the data finish loading first.");
                    return;
                  }
                  if (result.kind === "no-orders") {
                    alert("No open SOs in the filtered set to report on.");
                    return;
                  }
                  openPreview(result.payload);
                }),
              },
              {
                key: "salesComps",
                menuKey: "ats/reports/sales-comps",
                label: "Sales Comps…",
                sub: "TY vs same-period-LY for the date range + filters you pick",
                onClick: () => gateReport((include) => { setReportInclude(include); setSalesCompsOpen(true); }),
              },
            ] as const)
              // Per-report permission gate. atsReportsPerm[key] is true unless
              // the admin explicitly opted this user out (false). Hidden
              // entries don't render at all — the operator shouldn't see a
              // disabled row teasing a report they can't run.
              .filter(item => atsReportsPerm[item.key as AtsReportKey])
              .map((item) => (
              <button
                key={item.key}
                onClick={() => { logReportClick(item.menuKey); item.onClick(); setReportsOpen(false); }}
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
            {!anyReportAllowed && (
              <div style={{ padding: "10px 14px", fontSize: 12, color: "#94A3B8", fontStyle: "italic" }}>
                No reports available — ask an admin to enable a report under User Management.
              </div>
            )}
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
          Ask AI
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
        Notifications
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
        appId="ats"
        draftInput={aiDraftInput}
        onDraftInputConsumed={() => setAiDraftInput(null)}
      />
    )}

    {/* Aged Inventory days modal */}
    {agedOpen && (
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center" }}
        onClick={() => setAgedOpen(false)}
      >
        <div style={{ background: "#1E293B", border: "1px solid #334155", borderRadius: 12, padding: 28, width: "min(320px, 95vw)", maxHeight: "90vh", overflowY: "auto", boxSizing: "border-box", boxShadow: "0 20px 60px rgba(0,0,0,0.5)" }}
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
            onKeyDown={e => { if (e.key === "Enter") { const d = parseInt(agedDays); if (d > 0) gateReport((include) => { const r = onAgedInven(d, agedCategory, include); if (r === "empty") setAgedEmpty(true); else { setAgedOpen(false); openPreview(r); } }); } }}
            autoFocus
            style={{ width: "100%", background: "#0F172A", border: "1px solid #334155", borderRadius: 8, color: "#F1F5F9", fontSize: 15, padding: "8px 12px", outline: "none", boxSizing: "border-box" as const, marginBottom: 16 }}
          />
          <label style={{ fontSize: 12, color: "#94A3B8", display: "block", marginBottom: 6 }}>Category</label>
          <SearchableSelect
            value={agedCategory || null}
            onChange={v => setAgedCategory(v)}
            options={categories.map(c => ({ value: c, label: c === "All" ? "All Categories" : c }))}
            inputStyle={{ width: "100%", background: "#0F172A", border: "1px solid #334155", borderRadius: 8, color: "#F1F5F9", fontSize: 14, padding: "8px 12px", outline: "none", boxSizing: "border-box" as const, marginBottom: 20, cursor: "pointer" }}
          />
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
              onClick={() => { const d = parseInt(agedDays); if (d > 0) gateReport((include) => { const r = onAgedInven(d, agedCategory, include); if (r === "empty") setAgedEmpty(true); else { setAgedOpen(false); openPreview(r); } }); }}
              style={{ background: "#1D6F42", border: "1px solid #155734", color: "#fff", borderRadius: 6, padding: "7px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
              View Report
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
          hiddenColumns,
          prep.totals,
          opts,
          eventIndex,
          prep.salesAggregates,
          explodePpk,
          prep.customerSoMap,
          prep.sizeMatrix,
          prep.bulkByStyleColor,
          prep.periodMatrices,
          prep.styleImages,
        );
        setExportOptsOpen(false);
      }}
      onView={async (opts) => {
        const prep = await prepareExportArgs(opts);
        if (!prep) return;
        const payload = buildExportPayload(
          prep.rowsForExport,
          prep.periods,
          hiddenColumns,
          prep.totals,
          opts,
          eventIndex,
          prep.salesAggregates,
          explodePpk,
          prep.customerSoMap,
          prep.sizeMatrix,
          prep.bulkByStyleColor,
          prep.periodMatrices,
          prep.styleImages,
        );
        if (!payload) return;
        // Main-grid export remembers the options modal so the preview's
        // Back button can return to it. The 4 simpler reports leave
        // backTarget null — their modal hides the Back button.
        openPreview(payload, "exportOpts");
        // Leave the options modal mounted but hidden behind the
        // preview — clicking Back returns to it without re-fetching.
        setExportOptsOpen(false);
      }}
    />
    <ExportPreviewModal
      open={previewPayload !== null}
      payload={previewPayload}
      rowCount={previewBodyCount}
      showBack={previewBackTarget === "exportOpts"}
      onClose={() => {
        // Back: dismiss the preview and re-open the options modal it
        // came from (currently only the main-grid export uses this).
        if (previewBackTarget === "exportOpts") {
          setPreviewPayload(null);
          setExportOptsOpen(true);
        } else {
          setPreviewPayload(null);
        }
      }}
      onCloseAll={() => { setPreviewPayload(null); }}
    />

    {salesCompsOpen && (
      <SalesCompsModal
        onClose={() => setSalesCompsOpen(false)}
        defaultCustomer={customerFilter}
        defaultCategories={exportFilterOpts.filterCategory}
        defaultSubCategories={exportFilterOpts.filterSubCategory}
        defaultStyles={exportFilterOpts.filterStyle}
        defaultStoreFilter={exportFilterOpts.storeFilter}
        defaultGenders={exportFilterOpts.filterGender}
        allCategories={categories}
        allSubCategories={subCategories}
        allStyles={styles}
        allStores={STORES}
        rows={reportInclude ? fullFiltered : filtered}
        excelData={excelData}
        explodePpk={explodePpk}
      />
    )}

    {/* Pre-report exclusion warning — lists the excluded ("X") styles and
        lets the operator Continue (run excluding them), Cancel, or Include
        them for this one run. Shown before ANY report/export when rows are
        excluded. */}
    {excludeGate && (
      <div
        style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 1200, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}
        onClick={() => setExcludeGate(null)}
      >
        <div
          onClick={e => e.stopPropagation()}
          style={{ background: "#0F172A", border: "1px solid #334155", borderRadius: 12, width: "min(560px, 95vw)", maxHeight: "90vh", display: "flex", flexDirection: "column", boxShadow: "0 16px 48px rgba(0,0,0,0.5)" }}
        >
          <div style={{ padding: "16px 20px", borderBottom: "1px solid #334155", display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ color: "#F1F5F9", fontSize: 15, fontWeight: 700 }}>This report excludes {excludedStyleList.length} style{excludedStyleList.length === 1 ? "" : "s"}</span>
          </div>
          <div style={{ padding: "14px 20px", overflowY: "auto", flex: 1 }}>
            <div style={{ color: "#94A3B8", fontSize: 13, marginBottom: 10 }}>
              The following styles are marked excluded (the “X” column) and will be left out of this report and all totals. Continue to run without them, Include to count them this once, or Cancel.
            </div>
            <div style={{ border: "1px solid #334155", borderRadius: 8, overflow: "hidden" }}>
              {excludedStyleList.map((s, i) => (
                <div
                  key={s.style}
                  style={{ display: "flex", gap: 10, padding: "7px 12px", fontSize: 12, background: i % 2 ? "#1E293B" : "#162032", borderBottom: i < excludedStyleList.length - 1 ? "1px solid #243048" : "none" }}
                >
                  <span style={{ fontFamily: "monospace", color: "#60A5FA", fontWeight: 700, minWidth: 96 }}>{s.style}</span>
                  <span style={{ color: "#CBD5E1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.description || "—"}</span>
                </div>
              ))}
            </div>
          </div>
          <div style={{ padding: "14px 20px", borderTop: "1px solid #334155", display: "flex", justifyContent: "flex-end", gap: 10 }}>
            <button
              onClick={() => setExcludeGate(null)}
              style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #334155", background: "transparent", color: "#CBD5E1", cursor: "pointer", fontSize: 13, fontWeight: 600 }}
            >Cancel</button>
            <button
              onClick={() => resolveGate(true)}
              title="Run this report counting the excluded styles, just this once (they stay excluded everywhere else)"
              style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #B45309", background: "rgba(245,158,11,0.15)", color: "#FCD34D", cursor: "pointer", fontSize: 13, fontWeight: 600 }}
            >Include them</button>
            <button
              onClick={() => resolveGate(false)}
              title="Run this report without the excluded styles"
              style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #047857", background: "rgba(16,185,129,0.15)", color: "#6EE7B7", cursor: "pointer", fontSize: 13, fontWeight: 700 }}
            >Continue</button>
          </div>
        </div>
      </div>
    )}
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

