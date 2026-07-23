// Parent page for Phase 1. Mounts at /planning/wholesale via main.tsx.
//
// Responsibilities:
//   • load runs + masters + open requests
//   • orchestrate grid view + requests panel via tab switch
//   • hand a selected row to the ForecastDetailDrawer
//   • refresh on mutations (override saved, request created, run built)
//
// Keeps state flat (plain React). Grid dataset is small enough in Phase 1
// that a rebuild on each change is acceptable.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IpCategory, IpCustomer, IpItem } from "../types/entities";
import type {
  IpForecastMethodPreference,
  IpFutureDemandRequest,
  IpOverrideReasonCode,
  IpPlannerOverride,
  IpPlanningGridRow,
  IpPlanningRun,
  IpWholesaleForecast,
} from "../types/wholesale";
import { FORECAST_METHOD_LABELS } from "../types/wholesale";
import { wholesaleRepo } from "../services/wholesalePlanningRepository";
import { promoteStyleColor } from "../services/promoteStyleColorService";
import { confirmDialog } from "../../shared/ui/warn";
import { applyOverride, buildGridRows } from "../services/wholesaleForecastService";
import { collectUnitCostBucketTargets, collectStyleColorPropagationTargets } from "../utils/bucketUnitCost";
import { planBuyerShiftBackForCustomers } from "./wholesale-planning/shiftBuyerBackOneMonth";
import { ingestXoroSales, syncAtsSupply, syncMissingItems, syncTandaPos } from "../services/xoroSalesIngestService";
import { ingestSalesExcel, ingestItemMasterExcel, type ExcelIngestResult } from "../services/excelIngestService";
import { AppDatePicker } from "../../shared/components/AppDatePicker";
import { S, PAL, formatPeriodCode } from "../components/styles";
import { TabButton } from "../components/TabButton";
import { SB_HEADERS, SB_URL } from "../../utils/supabase";
import PlanningRunControls from "./PlanningRunControls";
import WholesalePlanningGrid from "./WholesalePlanningGrid";
import FutureDemandRequestsPanel from "./FutureDemandRequestsPanel";
import ForecastDetailDrawer from "../components/ForecastDetailDrawer";
import Toast, { type ToastMessage } from "../components/Toast";
import LastUploadStamp from "../../shared/ui/LastUploadStamp";
import SystemHealthBanner from "../shared/components/SystemHealthBanner";
import {
  MonthlyTotalsCards,
  OperationStatusBar,
  BootstrapStatusBar,
  CollapseChevron,
} from "./wholesale-planning/WorkbenchComponents";
import type { TabKey } from "./wholesale-planning/types";
import {
  STORAGE_KEYS,
  loadCollapsedFlag,
  saveCollapsedFlag,
  loadSystemSuggestionsOn,
  saveSystemSuggestionsOn,
  loadLastUpload,
  rememberUpload,
} from "./wholesale-planning/workbenchPersistence";

async function fetchForecast(id: string): Promise<IpWholesaleForecast | null> {
  if (!SB_URL) return null;
  const r = await fetch(`${SB_URL}/rest/v1/ip_wholesale_forecast?id=eq.${id}&select=*`, { headers: SB_HEADERS });
  if (!r.ok) return null;
  const rows = (await r.json()) as IpWholesaleForecast[];
  return rows[0] ?? null;
}

// TabKey + the small components below have moved to
// ./wholesale-planning/{types,WorkbenchComponents}.tsx.

export default function WholesalePlanningWorkbench() {
  const [runs, setRuns] = useState<IpPlanningRun[]>([]);
  // Persisted selection — keeps the planner on the same run across
  // logout/login. Without this, login auto-selects the "active" run,
  // which strands edits made on a non-active run (e.g. a NEW style
  // saved on a draft run looks "lost" because the grid rebuilds
  // against a different run on relogin).
  const [selectedRunId, setSelectedRunId] = useState<string | null>(() => {
    try { return localStorage.getItem("ws_planning_selected_run_id"); } catch { return null; }
  });
  useEffect(() => {
    try {
      if (selectedRunId) localStorage.setItem("ws_planning_selected_run_id", selectedRunId);
      else localStorage.removeItem("ws_planning_selected_run_id");
    } catch { /* ignore */ }
  }, [selectedRunId]);
  const [customers, setCustomers] = useState<IpCustomer[]>([]);
  const [categories, setCategories] = useState<IpCategory[]>([]);
  const [items, setItems] = useState<IpItem[]>([]);
  // Distinct color values from the active item master (lower-cased).
  // Used by the TBD color picker to decide whether a typed color is
  // truly "new". Sourced from items master, not from rows in scope —
  // colors that only appear on master entries with no demand pair
  // would otherwise be flagged as new on the second time the planner
  // typed them, then "not-new" once they were saved (and thus
  // appeared in rows).
  const [masterColorsLower, setMasterColorsLower] = useState<Set<string>>(new Set());
  // Per-style set of master colors. Drives the two-tier "new" badge:
  //   - color exists for this style    → no badge
  //   - color exists for other styles  → green "NEW for style"
  //   - color not in master anywhere   → orange "NEW COLOR"
  const [masterColorsByStyleLower, setMasterColorsByStyleLower] = useState<Map<string, Set<string>>>(new Map());
  // Distinct (style_code, group_name, sub_category_name, gender) tuples
  // from the master. Drives the TBD style picker's category-wide list and
  // the grid's pre-build filter domains.
  const [masterStyles, setMasterStyles] = useState<Array<{ style_code: string; group_name: string | null; sub_category_name: string | null; gender: string | null }>>([]);
  // Units-per-pack for PPK styles from Tangerine's Prepack Matrix, keyed by
  // lowercased style_code. Supplements the SKU/size "PPKn" token so a
  // digit-less prepack style (e.g. RYB0412PPK) still converts eaches ⇄ packs
  // when Explode PPK is off. Styles absent here + with no token get a warning.
  const [ppkUnitsByStyle, setPpkUnitsByStyle] = useState<Map<string, number>>(new Map());
  const [requests, setRequests] = useState<IpFutureDemandRequest[]>([]);
  const [rows, setRows] = useState<IpPlanningGridRow[]>([]);
  const [overrides, setOverrides] = useState<IpPlannerOverride[]>([]);
  const [tab, setTab] = useState<TabKey>("grid");
  const [loading, setLoading] = useState(true);
  const [ingesting, setIngesting] = useState(false);
  const defaultFrom = new Date(Date.now() - 395 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const [ingestFrom, setIngestFrom] = useState(defaultFrom);
  const [ingestTo, setIngestTo] = useState(new Date().toISOString().slice(0, 10));
  const [selectedRow, setSelectedRow] = useState<IpPlanningGridRow | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  // "Show them" target for the add-row toast — filters the grid to the
  // batch just added. nonce bumps per request so the grid re-applies
  // even when the same batch is requested twice.
  const [focusBatch, setFocusBatch] = useState<{
    style_code: string;
    color: string;
    customer_ids: string[];
    period_codes: string[];
    nonce: number;
  } | null>(null);
  // Per-section collapse toggles. Each card on the workbench (sales
  // history bar, monthly totals cards) can be hidden via a small ▾
  // chevron at the card's top-right edge so the planner can free up
  // vertical space. Persisted to localStorage so the choice survives
  // reloads.
  // loadCollapsedFlag / saveCollapsedFlag moved to
  // ./wholesale-planning/workbenchPersistence.
  const [salesHistCollapsed, setSalesHistCollapsed] = useState<boolean>(() => loadCollapsedFlag(STORAGE_KEYS.collapseSales));
  const [monthlyTotalsCollapsed, setMonthlyTotalsCollapsed] = useState<boolean>(() => loadCollapsedFlag(STORAGE_KEYS.collapseTotals));
  // Bucket-level buy qty map for the active run. key = bucket_key,
  // value = stored qty. Refreshed when the run changes or the planner
  // saves a new bucket buy.
  const [bucketBuys, setBucketBuys] = useState<Map<string, number>>(new Map());
  // Mirror of the grid's active filter set, lifted to workbench scope
  // so PlanningRunControls' Build button can scope itself to the
  // currently visible subset. The grid's onFiltersChange callback
  // populates this; PlanningRunControls reads it as buildFilter.
  const [buildFilter, setBuildFilter] = useState<{
    customer_id: string | null;
    customer_ids: string[] | null;
    style_code: string | null;
    style_codes: string[] | null;
    group_name: string | null;
    group_names: string[] | null;
    sub_category_name: string | null;
    sub_category_names: string[] | null;
    gender: string | null;
    genders: string[] | null;
    period_code: string | null;
    period_codes: string[] | null;
    recommended_action: string | null;
    confidence_level: string | null;
    forecast_method: string | null;
  } | null>(null);

  // Lifted from the grid so MonthlyTotalsCards and the grid use the
  // same toggle. Without this lift, the top FINAL FORECAST card showed
  // raw final_forecast_qty while the grid's Σ Final reflected the
  // muted value — creating a visible discrepancy.
  const [systemSuggestionsOn, setSystemSuggestionsOn] = useState<boolean>(loadSystemSuggestionsOn);
  function setSystemSuggestionsOnPersistent(v: boolean) {
    saveSystemSuggestionsOn(v);
    setSystemSuggestionsOn(v);
  }

  // Filtered+muted row set, mirrored up from the grid via onScopeChange
  // so MonthlyTotalsCards (top FINAL FORECAST card) uses the same
  // subset the grid does.
  const [scopedRows, setScopedRows] = useState<IpPlanningGridRow[]>([]);

  // Centered modal status for sync / upload operations. Replaces the
  // bottom toast for in-flight operations — completion + error
  // messages still go on this bar (briefly) before it closes.
  const [opStatus, setOpStatus] = useState<{
    label: string;
    message?: string;
    canCancel?: boolean;
    onCancel?: () => void;
  } | null>(null);

  // Upload summary — required-dismiss modal shown after every Excel
  // upload completes (success OR failure). Replaces the previous
  // auto-fading status bar so the planner has time to read the
  // counts (parsed / inserted / skipped / errors) and decide
  // whether to retry. Stays open until the planner clicks Close.
  type UploadSummary = {
    kind: "sales" | "master";
    fileName: string;
    parsed: number;
    inserted: number;
    skipped_no_sku: number;
    skipped_no_date: number;
    skipped_zero_qty: number;
    skipped_bad_cost: number;
    skipped_duplicate: number;
    inserted_variants: number;
    skipped_variant_duplicate: number;
    no_size_skus: string[];
    duplicate_variant_groups: Array<{
      variant_key: string;
      rows: Array<Record<string, unknown>>;
    }>;
    errors: string[];
    warnings: string[];
    failedMessage?: string;  // when the whole upload threw
  };
  const [uploadSummary, setUploadSummary] = useState<UploadSummary | null>(null);

  // Faded "last uploaded …" stamp shown next to each upload button.
  // Persisted in localStorage so it survives reloads. Updated on
  // every successful Excel ingest (skipped on outright failure so
  // the planner doesn't see a stale "succeeded" timestamp).
  // Last-upload timestamps + key registry moved to
  // ./wholesale-planning/workbenchPersistence. Local React state
  // mirrors the persisted value so the "last uploaded …" stamp
  // re-renders without a reload.
  const [lastUploadSales, setLastUploadSales] = useState<string | null>(() => loadLastUpload("sales"));
  const [lastUploadMaster, setLastUploadMaster] = useState<string | null>(() => loadLastUpload("master"));
  function rememberUploadLocal(kind: "sales" | "master") {
    const iso = rememberUpload(kind);
    if (kind === "sales") setLastUploadSales(iso);
    else setLastUploadMaster(iso);
  }
  // When the user clicks Hide / Cancel, mark dismissed so the operation's
  // tail-end progress and completion messages don't briefly re-open the
  // modal after the user thought it was gone.
  const opDismissedRef = useRef(false);
  const reportOp = (message: string) => {
    if (opDismissedRef.current) return;
    setOpStatus((prev) => (prev ? { ...prev, message } : null));
  };

  // Visible bootstrap status — drives the status bar at the top of the
  // workbench. Phases:
  //   "masters"   → fetching customers / categories / items / runs
  //   "run-data"  → building the grid for the selected run (heavy step)
  //   "ready"     → app is up; bar disappears
  type BootstrapPhase = "masters" | "run-data" | "ready";
  const [bootstrapPhase, setBootstrapPhase] = useState<BootstrapPhase>("masters");

  const selectedRun = useMemo(() => runs.find((r) => r.id === selectedRunId) ?? null, [runs, selectedRunId]);

  const loadMasters = useCallback(async () => {
    const [cs, cats, its, reqs, rs, mcl, mst, mcs, ppk] = await Promise.all([
      wholesaleRepo.listCustomers(),
      wholesaleRepo.listCategories(),
      wholesaleRepo.listItems(),
      // listAllRequests instead of listOpenRequests so the panel can
      // filter to "applied" / "archived" client-side. The build pass
      // still uses listOpenRequests directly for its own pull.
      wholesaleRepo.listAllRequests(),
      wholesaleRepo.listPlanningRuns("wholesale"),
      wholesaleRepo.listMasterColorsLower(),
      wholesaleRepo.listMasterStyles(),
      wholesaleRepo.listMasterColorsByStyleLower(),
      wholesaleRepo.listPrepackUnitsPerPack(),
    ]);
    setCustomers(cs);
    setCategories(cats);
    setItems(its);
    setRequests(reqs);
    setMasterColorsLower(mcl);
    setMasterStyles(mst);
    setMasterColorsByStyleLower(mcs);
    setPpkUnitsByStyle(ppk);
    setRuns(rs);
    // If the persisted run no longer exists in the fetched list,
    // drop the stale id so the fallback runs and the planner doesn't
    // get stuck pointing at a missing run.
    const stillExists = selectedRunId ? rs.some((r) => r.id === selectedRunId) : false;
    if (!selectedRunId || !stillExists) {
      const active = rs.find((r) => r.status === "active") ?? rs[0] ?? null;
      if (active) setSelectedRunId(active.id);
    }
    // Report whether a run will be selectable. When there are NO runs (e.g.
    // the planner deleted them all), no run is ever selected, so the
    // [selectedRun] effect never flips bootstrap run-data→ready and the
    // "Loading forecast and inventory" bar hangs forever. The mount effect
    // uses this to jump straight to "ready" in that case.
    return rs.length > 0;
  }, [selectedRunId]);

  const loadRunData = useCallback(async () => {
    if (!selectedRun) { setRows([]); setOverrides([]); setBucketBuys(new Map()); return; }
    const [grid, ovs, bbs] = await Promise.all([
      buildGridRows(selectedRun),
      wholesaleRepo.listOverrides(selectedRun.id),
      wholesaleRepo.listBucketBuys(selectedRun.id),
    ]);
    setRows(grid);
    setOverrides(ovs);
    setBucketBuys(new Map(bbs.map((b) => [b.bucket_key, Number(b.qty)])));
  }, [selectedRun]);

  const refreshAll = useCallback(async () => {
    setLoading(true);
    try {
      await loadMasters();
      await loadRunData();
    } catch (e) {
      setToast({ text: "Load failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally {
      setLoading(false);
    }
  }, [loadMasters, loadRunData]);

  // Initial mount: load masters ONLY. Don't call refreshAll — its trailing
  // loadRunData() races the [selectedRun] effect's loadRunData() once
  // loadMasters' setSelectedRunId(activeRun.id) propagates. That double-
  // fire of buildGridRows (11 parallel reads + paginated listForecast)
  // was the 20s "load cycle" visible on first paint.
  useEffect(() => {
    setLoading(true);
    setBootstrapPhase("masters");
    loadMasters()
      .then((hasRun) => {
        // With a run, advance to run-data (the [selectedRun] effect loads it
        // and flips to ready). With NO runs, finish bootstrap immediately so
        // the loader dismisses to the empty state instead of hanging.
        setBootstrapPhase((prev) => (prev === "masters" ? (hasRun ? "run-data" : "ready") : prev));
      })
      .catch((e) => {
        setToast({ text: "Load failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
        setBootstrapPhase("ready");
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Clear the add-undo stack — its batches belong to the previous run.
    setAddUndoStack([]);
    if (!selectedRun) {
      // No run to load — bootstrap is done as soon as masters were.
      setBootstrapPhase((prev) => (prev === "run-data" ? "ready" : prev));
      return;
    }
    setLoading(true);
    loadRunData()
      .catch((e) => setToast({ text: "Load failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" }))
      .finally(() => {
        setLoading(false);
        setBootstrapPhase("ready");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRun]);

  // Monotonic counter for inline-edit rebuilds. Each save bumps this and
  // captures its value; the resulting setRows only fires when the captured
  // value still matches — older fetches landing after newer ones get
  // discarded so they can't overwrite the newer optimistic state.
  const rebuildSeq = useRef(0);

  const overridesForRow = useMemo(() => {
    if (!selectedRow) return [];
    return overrides.filter(
      (o) => o.customer_id === selectedRow.customer_id &&
             o.sku_id === selectedRow.sku_id &&
             o.period_start === selectedRow.period_start,
    );
  }, [overrides, selectedRow]);

  // "Add new items" — Xoro item catalog → ip_item_master (insert-only).
  // Existing master rows protected by on_conflict do_nothing on server side.
  async function runMissingItemsSync() {
    setIngesting(true); setRunningKind("missing-items");
    opDismissedRef.current = false;
    setOpStatus({ label: "Add new items", message: "Looking up new items…" });
    try {
      const r = await syncMissingItems({ pageLimit: 100 });
      if (r.error) {
        reportOp(`Couldn't finish — ${r.error}${r.hint ? ` (${r.hint})` : ""}`);
        console.error("[xoro-items-missing-sync] failed", r);
        await new Promise<void>((res) => setTimeout(res, 2200));
      } else {
        const errSummary = r.errors.length > 0 ? ` · ${r.errors.length} had problems` : "";
        if (r.errors.length > 0) console.error("[xoro-items-missing-sync] errors:", r.errors);
        reportOp(`Done — checked ${r.xoro_items_fetched.toLocaleString()} items, ${r.already_in_master.toLocaleString()} already known, added ${r.inserted.toLocaleString()} new${errSummary}`);
        await new Promise<void>((res) => setTimeout(res, 1500));
        if (r.inserted > 0) await loadMasters();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      reportOp(`Couldn't finish — ${msg}`);
      await new Promise<void>((res) => setTimeout(res, 2200));
    } finally {
      setIngesting(false); setRunningKind(null);
      setOpStatus(null);
    }
  }

  async function runSupplySync(kind: "ats" | "tanda") {
    setIngesting(true); setRunningKind(kind === "ats" ? "ats" : "tanda");
    opDismissedRef.current = false;
    setOpStatus({
      label: kind === "ats" ? "Updating on-hand inventory" : "Updating open purchase orders",
      message: "Starting…",
    });
    try {
      if (kind === "tanda") {
        const r = await syncTandaPos();
        const err = (r as { error?: string }).error;
        if (err) {
          reportOp(`Couldn't finish — ${err}`);
          await new Promise<void>((res) => setTimeout(res, 2200));
        } else {
          const inserted = (r as { inserted?: number }).inserted ?? 0;
          const newSkus = (r as { auto_created_skus?: number }).auto_created_skus ?? 0;
          reportOp(`Done — ${inserted} updated${newSkus ? `, ${newSkus} new items` : ""}`);
          await new Promise<void>((res) => setTimeout(res, 1500));
          if (inserted > 0) await loadRunData();
        }
        return;
      }
      // ATS — chunked: keep clicking through nextStart until done.
      let start = 0;
      let totalInserted = 0;
      let totalNew = 0;
      let totalSkipped = 0;
      let totalAts = 0;
      let chunks = 0;
      while (true) {
        const r = (await syncAtsSupply({ start, limit: 2000 })) as {
          error?: string;
          inserted?: number;
          auto_created_skus?: number;
          ats_skus_total?: number;
          ats_skus_in_batch?: number;
          skipped_zero_state?: number;
          skipped_no_sku?: number;
          next_start?: number | null;
          done?: boolean;
        };
        console.log("[ats-supply-sync] chunk response", { start, response: r });
        if (r.error) {
          reportOp(`Couldn't finish — ${r.error}`);
          await new Promise<void>((res) => setTimeout(res, 2200));
          break;
        }
        chunks++;
        totalInserted += r.inserted ?? 0;
        totalNew += r.auto_created_skus ?? 0;
        totalSkipped += (r.skipped_zero_state ?? 0) + (r.skipped_no_sku ?? 0);
        totalAts = r.ats_skus_total ?? totalAts;
        const processed = Math.min(start + (r.ats_skus_in_batch ?? 0), totalAts);
        reportOp(`Step ${chunks} — ${processed.toLocaleString()} of ${totalAts.toLocaleString()} items checked, ${totalInserted} updated, ${totalNew} new`);
        if (r.done || r.next_start == null) {
          reportOp(`Done — ${totalInserted.toLocaleString()} updated, ${totalNew} new items, ${totalSkipped.toLocaleString()} skipped (no inventory) · ${totalAts.toLocaleString()} items in total`);
          await new Promise<void>((res) => setTimeout(res, 1500));
          if (totalInserted > 0) await loadRunData();
          break;
        }
        start = r.next_start;
      }
    } catch (e) {
      reportOp(`Couldn't finish — ${e instanceof Error ? e.message : String(e)}`);
      await new Promise<void>((res) => setTimeout(res, 2200));
    } finally {
      setIngesting(false); setRunningKind(null);
      setOpStatus(null);
    }
  }

  async function ingestExcel(kind: "sales" | "master", file: File) {
    setIngesting(true); setRunningKind(`excel-${kind}`);
    const label = kind === "sales" ? "Sales upload" : "Item list upload";
    opDismissedRef.current = false;
    setOpStatus({ label, message: "Reading file…" });
    try {
      const onProgress = (msg: string) => reportOp(msg);
      const r: ExcelIngestResult =
        kind === "sales" ? await ingestSalesExcel(file, onProgress)
                         : await ingestItemMasterExcel(file, onProgress);
      if (r.errors.length > 0) console.error(`[excel-${kind}] errors:`, r.errors);
      if (r.warnings && r.warnings.length > 0) console.warn(`[excel-${kind}] warnings:`, r.warnings);
      // Refresh grids before showing the summary so the planner
      // dismisses the modal onto fresh data.
      if (r.inserted > 0 && kind === "sales") await loadRunData();
      if (r.inserted > 0 && kind === "master" && selectedRun) {
        const refreshed = await buildGridRows(selectedRun);
        setRows(refreshed);
      }
      // Stamp the last-upload timestamp (only on completion — a
      // thrown ingest skips this branch and leaves the prior stamp).
      rememberUploadLocal(kind);
      // Open the required-dismiss summary dialog. Closes the
      // status bar immediately — no auto-fade tail.
      setUploadSummary({
        kind,
        fileName: file.name,
        parsed: r.parsed,
        inserted: r.inserted,
        skipped_no_sku: r.skipped_no_sku ?? 0,
        skipped_no_date: r.skipped_no_date ?? 0,
        skipped_zero_qty: r.skipped_zero_qty ?? 0,
        skipped_bad_cost: r.skipped_bad_cost ?? 0,
        skipped_duplicate: r.skipped_duplicate ?? 0,
        inserted_variants: r.inserted_variants ?? 0,
        skipped_variant_duplicate: r.skipped_variant_duplicate ?? 0,
        no_size_skus: r.no_size_skus ?? [],
        duplicate_variant_groups: r.duplicate_variant_groups ?? [],
        errors: r.errors ?? [],
        warnings: r.warnings ?? [],
      });
    } catch (e) {
      console.error(`[excel-${kind}] failed`, e);
      const msg = e instanceof Error ? e.message : String(e);
      setUploadSummary({
        kind,
        fileName: file.name,
        parsed: 0, inserted: 0,
        skipped_no_sku: 0, skipped_no_date: 0, skipped_zero_qty: 0, skipped_bad_cost: 0,
        skipped_duplicate: 0, inserted_variants: 0,
        skipped_variant_duplicate: 0, no_size_skus: [],
        duplicate_variant_groups: [],
        errors: [], warnings: [],
        failedMessage: msg,
      });
    } finally {
      setIngesting(false); setRunningKind(null);
      setOpStatus(null);
    }
  }

  // Page tracker for sales ingest — successive clicks advance through
  // pages 1, 2, 3 … within the same date window. Resets when the user
  // changes either date picker.
  const [salesPageStart, setSalesPageStart] = useState(1);
  const [autoWalking, setAutoWalking] = useState(false);
  const autoWalkAbort = useRef(false);
  // Per-button running state — only the actively-running button shows
  // "Working…" so the planner can see which sync is in flight.
  // ingesting (boolean) still gates concurrent kicks of the same group.
  const [runningKind, setRunningKind] = useState<string | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setSalesPageStart(1); }, [ingestFrom, ingestTo]);

  // Auto-walk: loops the ingest call until past_window fires, so the
  // planner doesn't need to click 100+ times to backfill a window
  // (Xoro returns oldest-first; reaching last year's August requires
  // walking through every page since the first invoice ever).
  // Daily/weekly delta sync — fetches only the last 10 Xoro pages
  // (~1000 newest invoices). Idempotent on source_line_key so anything
  // already in the DB is a no-op. Use this after the Excel bootstrap
  // instead of "Fetch all" for routine updates.
  async function syncNewestSales() {
    setIngesting(true); setRunningKind("newest");
    opDismissedRef.current = false;
    setOpStatus({ label: "Update recent sales", message: "Reading latest sales…" });
    try {
      const r = await ingestXoroSales({
        dateFrom: "1900-01-01",
        dateTo: "2100-12-31",
        fromEnd: 3,
        pageLimit: 3,
      });
      if (r.error) {
        reportOp(`Couldn't finish — ${r.error}`);
        await new Promise<void>((res) => setTimeout(res, 2200));
        return;
      }
      const span = r.oldest_invoice_in_batch && r.newest_invoice_in_batch
        ? ` · ${r.oldest_invoice_in_batch} to ${r.newest_invoice_in_batch}`
        : "";
      reportOp(`Done — read ${r.xoro_lines_fetched} sales lines, saved ${r.inserted}${r.auto_created_skus ? `, ${r.auto_created_skus} new items` : ""}${r.auto_created_customers ? `, ${r.auto_created_customers} new customers` : ""}${span}`);
      await new Promise<void>((res) => setTimeout(res, 1800));
      if (r.inserted > 0) await loadRunData();
    } catch (e) {
      reportOp(`Couldn't finish — ${e instanceof Error ? e.message : String(e)}`);
      await new Promise<void>((res) => setTimeout(res, 2200));
    } finally {
      setIngesting(false); setRunningKind(null);
      setOpStatus(null);
    }
  }

  async function autoWalkSales() {
    setAutoWalking(true); setRunningKind("autowalk");
    autoWalkAbort.current = false;
    opDismissedRef.current = false;
    setOpStatus({
      label: "Fetch all Xoro sales",
      message: "Reading sales pages…",
      canCancel: true,
      onCancel: () => { autoWalkAbort.current = true; },
    });
    // Always start from page 1 so "Fetch all" actually fetches all.
    // (We previously persisted a resume page in localStorage but that
    // turned the button into a footgun — a partial walk + re-click
    // would silently skip the older pages and the planner had no way
    // to know data was missing for the un-walked range.)
    const resumeKey = "ip_xoro_sales_resume_page";
    localStorage.removeItem(resumeKey);
    let page = 1;
    let totalInserted = 0;
    let totalAutoSku = 0;
    let totalAutoCust = 0;
    let pagesWalked = 0;
    let earliestDate: string | null = null;
    let latestDate: string | null = null;
    try {
      // Auto-walk fetches the entire Xoro invoice catalog — date params
      // on the endpoint don't actually filter results, so we ingest
      // everything and let the forecast layer (which always trims to
      // snapshot - 12 months) decide what's in scope for planning.
      let consecutiveEmpty = 0;
      let consecutiveErrors = 0;
      while (!autoWalkAbort.current) {
        // 2 Xoro pages per call (~200 invoices). Bigger batches blew
        // the 60s gateway when Xoro responded slowly + heavy upserts
        // ran. With auto-resume + retry on 504, walking more calls is
        // safer than packing more into each.
        let r;
        try {
          r = await ingestXoroSales({
            dateFrom: "1900-01-01",
            dateTo: "2100-12-31",
            pageStart: page,
            pageLimit: 2,
          });
          consecutiveErrors = 0;
        } catch (err) {
          consecutiveErrors++;
          const msg = err instanceof Error ? err.message : String(err);
          reportOp(`Network hiccup on step ${page} — retrying ${consecutiveErrors} of 3 (${msg})`);
          if (consecutiveErrors >= 3) {
            reportOp(`Stopped at step ${page} after 3 tries — ${msg}`);
            await new Promise<void>((res) => setTimeout(res, 2200));
            break;
          }
          // Brief backoff before retrying the same page.
          await new Promise((res) => setTimeout(res, 5000));
          continue;
        }
        pagesWalked += 2;
        if (r.error) {
          reportOp(`Stopped at step ${page} — ${r.error}`);
          await new Promise<void>((res) => setTimeout(res, 2200));
          break;
        }
        totalInserted += r.inserted;
        totalAutoSku += r.auto_created_skus ?? 0;
        totalAutoCust += r.auto_created_customers ?? 0;
        // Track overall date span covered.
        if (r.oldest_invoice_in_batch && (!earliestDate || r.oldest_invoice_in_batch < earliestDate)) earliestDate = r.oldest_invoice_in_batch;
        if (r.newest_invoice_in_batch && (!latestDate || r.newest_invoice_in_batch > latestDate)) latestDate = r.newest_invoice_in_batch;
        // (Resume marker removed — always start from page 1; no partial state.)
        // Live progress so the planner sees something is happening.
        const emptyHint = consecutiveEmpty > 0 ? ` · ${consecutiveEmpty} empty in a row` : "";
        reportOp(`Step ${page} — ${r.oldest_invoice_in_batch ?? "?"} to ${r.newest_invoice_in_batch ?? "?"} · ${totalInserted} saved · ${totalAutoSku} new items${emptyHint}`);
        // Tolerate empty batches mid-catalog — Xoro returns plenty of
        // sparse pages (permission filtering, internal partitioning)
        // and the previous "3 empty in a row = stop" bail was killing
        // walks before they reached older invoices the planner needed.
        // Only stop after 25 consecutive empty calls (50 Xoro pages
        // with no data) — at that point we genuinely are at end of
        // catalog or hit a permission ceiling.
        if (r.xoro_lines_fetched === 0) {
          consecutiveEmpty++;
          if (consecutiveEmpty >= 25) {
            setSalesPageStart(1);
            break;
          }
        } else {
          consecutiveEmpty = 0;
        }
        // Hard ceiling — 2000 pages × 100 invoices = 200k cap.
        if (pagesWalked >= 2000) {
          setSalesPageStart(page);
          break;
        }
        page += 2;
      }
      setSalesPageStart(1);
      const aborted = autoWalkAbort.current;
      const ceilingHit = pagesWalked >= 2000;
      reportOp(`Done — ${pagesWalked} steps · ${earliestDate ?? "?"} to ${latestDate ?? "?"} · ${totalInserted.toLocaleString()} saved · ${totalAutoSku} new items · ${totalAutoCust} new customers${aborted ? " · stopped" : ceilingHit ? " · limit reached, click again to keep going" : ""}`);
      await new Promise<void>((res) => setTimeout(res, 1800));
      if (totalInserted > 0) await loadRunData();
    } finally {
      setAutoWalking(false); setRunningKind(null);
      autoWalkAbort.current = false;
      setOpStatus(null);
    }
  }

  async function ingestSales() {
    setIngesting(true); setRunningKind("sales");
    try {
      const r = await ingestXoroSales({ dateFrom: ingestFrom, dateTo: ingestTo, pageStart: salesPageStart });
      if (r.error) {
        // Surface the actual Xoro response so the user can see whether it's
        // a path mismatch, auth failure, or empty data window.
        console.error("[xoro-sales-sync] ingest failed", { error: r.error, path: r.path, debug: r.debug });
        const xoroMsg = (r.debug as { Message?: string; error?: string } | null | undefined)?.Message
          ?? (r.debug as { error?: string } | null | undefined)?.error
          ?? "see DevTools console for full Xoro response";
        setToast({ text: `Ingest error (path=${r.path}): ${xoroMsg}`, kind: "error" });
      } else {
        const skipParts = [];
        if (r.skipped_outside_window) skipParts.push(`${r.skipped_outside_window} outside window`);
        if (r.skipped_ecom_store) skipParts.push(`${r.skipped_ecom_store} ecom`);
        if (r.skipped_no_sku) skipParts.push(`${r.skipped_no_sku} no SKU`);
        // Xoro paginates oldest-first. Three states:
        //   before_window: still walking the early years → keep clicking
        //   in_window:     some hits expected → keep clicking
        //   past_window:   walked past the date_to → stop
        const span = r.oldest_invoice_in_batch && r.newest_invoice_in_batch
          ? ` · batch ${r.oldest_invoice_in_batch}…${r.newest_invoice_in_batch}`
          : "";
        const stateNote =
          r.past_window   ? " · ✓ past window — stopping" :
          r.before_window ? " · ↻ before window — keep clicking" :
          "";
        setToast({
          text: `Xoro sales (page ${salesPageStart}): ${r.xoro_lines_fetched} fetched · ${r.inserted} upserted${r.auto_created_skus ? ` · ${r.auto_created_skus} new SKUs` : ""}${skipParts.length ? ` · ${skipParts.join(", ")}` : ""}${span}${stateNote}`,
          kind: r.inserted > 0 ? "success" : "info",
        });
        if (r.past_window) setSalesPageStart(1);
        else if (r.xoro_lines_fetched >= 100) setSalesPageStart((p) => p + 1);
        else setSalesPageStart(1);
        if (r.inserted > 0) await loadRunData();
      }
    } catch (e) {
      setToast({ text: "Ingest failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally {
      setIngesting(false); setRunningKind(null);
    }
  }

  async function handleMethodChange(pref: IpForecastMethodPreference) {
    if (!selectedRun) {
      setToast({ text: "Pick a planning run first", kind: "error" });
      return;
    }
    if (selectedRun.forecast_method_preference === pref) {
      setToast({ text: `Already set to "${FORECAST_METHOD_LABELS[pref]}"`, kind: "info" });
      return;
    }
    try {
      await wholesaleRepo.updatePlanningRun(selectedRun.id, { forecast_method_preference: pref });
      setRuns((prev) => prev.map((r) => r.id === selectedRun.id ? { ...r, forecast_method_preference: pref } : r));
      setToast({ text: `Method set to "${FORECAST_METHOD_LABELS[pref]}" — rebuild forecast to apply`, kind: "info" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setToast({ text: `Method change failed — ${msg}`, kind: "error" });
    }
  }

  // Optimistic local update so Buy $, Short, and Excess on the typed
  // row all snap immediately. Downstream periods of the same SKU still
  // wait for the background grid rebuild to pick up rolling supply,
  // but the cell the planner is looking at updates without lag.
  // Marker for the row the planner just added — used by the grid to
  // pin that row to the top of displayRows for the rest of the
  // session (or until they add another / hard-refresh). Null when no
  // recent add. Identified by the (style, color, customer, period)
  // tuple since the synthetic forecast_id round-trips through a
  // rebuild.
  // Undo stack for "+ Add row" — the last up-to-4 add batches, newest last.
  // Each entry captures the batch's grain set so Undo removes the WHOLE batch
  // (every customer × period × color it created), and pressing Undo repeatedly
  // walks back up to 4 adds.
  const ADD_UNDO_DEPTH = 4;
  const [addUndoStack, setAddUndoStack] = useState<Array<{
    style_code: string;
    color: string;
    customer_ids: string[];
    period_codes: string[];
  }>>([]);

  // Customers tagged as planner-added — surfaces the orange NEW
  // badge on the customer cell. Seeded from the master each load
  // (any customer whose external_refs.planning_added === "1" stays
  // NEW across sessions until something else populates real
  // upstream identifiers — same lifecycle as the style/color NEW
  // flags, which clear once the master "catches up").
  const [newCustomerIds, setNewCustomerIds] = useState<Set<string>>(() => new Set());
  // style|color keys promoted into the company masters this session — drives
  // the per-row "✓ in DB" state so the planner doesn't re-promote.
  const [promotedTbdKeys, setPromotedTbdKeys] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    setNewCustomerIds((prev) => {
      const next = new Set(prev);
      for (const c of customers) {
        if (c.external_refs?.planning_added === "1") next.add(c.id);
      }
      return next;
    });
  }, [customers]);

  // App-themed confirm modal. Used by saveTbdColor / saveTbdDescription
  // / saveTbdCustomer when a change on a master-unknown style row
  // would propagate to sibling-period rows — the planner gets a
  // styled "this will change across all N periods, proceed?" prompt
  // instead of a bare window.confirm so the warning sits in the
  // workbench's panel chrome.
  const [pendingConfirm, setPendingConfirm] = useState<{
    title: string;
    body: string;
    confirmLabel: string;
    onConfirm: () => void;
    onCancel: () => void;
  } | null>(null);
  const askConfirm = (title: string, body: string, confirmLabel = "Proceed"): Promise<boolean> => {
    return new Promise((resolve) => {
      setPendingConfirm({
        title, body, confirmLabel,
        onConfirm: () => { setPendingConfirm(null); resolve(true); },
        onCancel: () => { setPendingConfirm(null); resolve(false); },
      });
    });
  };

  // Args shape for the "+ Add row" handler. Kept as a named type
  // so the inline form's onAddTbdRow callback can reuse it.
  type AddTbdRowArgs = {
    style_code: string;
    color: string;
    is_new_color: boolean;
    // One row per (customer × period) combination. Empty customer
    // list is rejected up front; empty period list falls back to
    // every period in the run (the previous "always all periods"
    // behavior, now opt-in via clearing the form's period selection).
    customer_ids: string[];
    group_name: string | null;
    sub_category_name: string | null;
    period_codes: string[];
    notes?: string | null;
  };

  // Add a fresh (Supply Only) TBD stock-buy row from the inline +Add
  // form. Style + color default to "TBD"; the planner picks
  // category, sub-cat, customer, and period in the form. The new row
  // is upserted directly to ip_wholesale_forecast_tbd; on success we
  // rebuild the grid so the row appears.
  // Duplicate guard for TBD rows. Same (style, color, customer,
  // period) on the same planning run is not allowed regardless of
  // is_user_added — the planner asked us to block instead of letting
  // two lines coexist for the same grain. `excludeForecastId` skips
  // the row being edited (so renaming a row's color to its current
  // value doesn't false-fire). Returns a description of the
  // conflict, or null if clear.
  function findTbdDuplicate(
    style: string,
    color: string,
    customerId: string,
    periodCode: string,
    excludeForecastId?: string,
  ): IpPlanningGridRow | null {
    for (const r of rows) {
      if (!r.is_tbd) continue;
      // Auto-synthesized catch-all rows (is_user_added=false) are
      // standing infrastructure — every "TBD/TBD/(Supply Only)" slot
      // exists by default, so a planner doing "+ Add row" with the
      // default style/color/customer would otherwise always get a
      // false-positive conflict against the auto catch-all. Only
      // count user-added rows as real duplicates.
      if (!r.is_user_added) continue;
      if (excludeForecastId && r.forecast_id === excludeForecastId) continue;
      // Trim + case-insensitive so "Espresso" vs "espresso" (or stray
      // whitespace) still counts as the same grain — otherwise a re-add slips
      // past the guard and piles up duplicate rows.
      const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
      if (norm(r.sku_style) !== norm(style)) continue;
      if (norm(r.sku_color) !== norm(color)) continue;
      if (r.customer_id !== customerId) continue;
      if (r.period_code !== periodCode) continue;
      return r;
    }
    return null;
  }

  async function addTbdRow(argsRaw: AddTbdRowArgs) {
    if (!selectedRun) return;
    // Dedup the selection up front so a single add can never emit the same
    // (customer, period) grain twice (which the grid would then collapse into
    // an aggregate).
    const args: AddTbdRowArgs = {
      ...argsRaw,
      customer_ids: Array.from(new Set(argsRaw.customer_ids)),
      period_codes: Array.from(new Set(argsRaw.period_codes)),
    };
    if (args.customer_ids.length === 0) {
      setToast({ text: "Pick at least one customer.", kind: "error" });
      return;
    }
    // Resolve which periods to create rows in. Empty list → fall back
    // to every period in the run.
    const allRunPeriods = Array.from(new Set(rows.map((r) => r.period_code)));
    const targetPeriods = args.period_codes.length > 0 ? args.period_codes : allRunPeriods;
    if (targetPeriods.length === 0) {
      setToast({ text: "No periods available in the run.", kind: "error" });
      return;
    }
    // Map each period to its period_start / period_end via a sample
    // row already loaded for that period.
    const periodSamples = targetPeriods
      .map((pc) => {
        const sample = rows.find((r) => r.period_code === pc);
        if (!sample) return null;
        return { period_code: pc, period_start: sample.period_start, period_end: sample.period_end };
      })
      .filter((x): x is { period_code: string; period_start: IpIsoDate; period_end: IpIsoDate } => x !== null);
    if (periodSamples.length === 0) {
      setToast({ text: "Couldn't resolve any of the chosen periods.", kind: "error" });
      return;
    }
    // Per-(customer, period) dup check (skip when the planner is using
    // the placeholder TBD/TBD grain). Instead of aborting the whole add on the
    // first collision, collect EVERY combo that already exists (same style /
    // color / customer / period), show a detailed warning listing them, and let
    // the planner decide whether to create the duplicates anyway or cancel.
    const isPlaceholderAdd = args.style_code === "TBD" && args.color === "TBD";
    if (!isPlaceholderAdd) {
      const dupes: Array<{ customer_name: string; period_code: string }> = [];
      for (const customer_id of args.customer_ids) {
        const custName = customers.find((c) => c.id === customer_id)?.name ?? "(unknown customer)";
        for (const p of periodSamples) {
          if (findTbdDuplicate(args.style_code, args.color, customer_id, p.period_code)) {
            dupes.push({ customer_name: custName, period_code: p.period_code });
          }
        }
      }
      if (dupes.length > 0) {
        const total = args.customer_ids.length * periodSamples.length;
        const MAX_LIST = 15;
        const lines = dupes.slice(0, MAX_LIST)
          .map((d) => `• ${args.style_code} / ${args.color} — ${d.customer_name} — ${formatPeriodCode(d.period_code)}`)
          .join("\n");
        const more = dupes.length > MAX_LIST ? `\n…and ${dupes.length - MAX_LIST} more` : "";
        const ok = await askConfirm(
          "Some rows already exist",
          `${dupes.length} of the ${total} row${total === 1 ? "" : "s"} you're adding already exist (same style / color / customer / period):\n\n${lines}${more}\n\nCreating them makes duplicate rows that the grid merges into one line. Create the duplicates anyway?`,
          "Create duplicates anyway",
        );
        if (!ok) {
          setToast({ text: "Add cancelled — no rows created.", kind: "info" });
          return;
        }
      }
    }
    try {
      // One row per (customer × period). No automatic sibling-period
      // cloning anymore — the planner explicitly picks which customers
      // and periods via the form's multi-selects.
      const localId = `addrow:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
      type Combo = { customer_id: string; customer_name: string; period: { period_code: string; period_start: IpIsoDate; period_end: IpIsoDate } };
      const combos: Combo[] = [];
      for (const customer_id of args.customer_ids) {
        const cust = customers.find((c) => c.id === customer_id);
        const customer_name = cust?.name ?? "(unknown customer)";
        for (const p of periodSamples) {
          combos.push({ customer_id, customer_name, period: p });
        }
      }
      // Build optimistic rows so the grid shows every chosen combo
      // instantly. Synthetic forecast_id keyed by localId + customer +
      // period — the network insert resolver below stamps the real
      // tbd_id once each INSERT settles.
      const synthFidFor = (cid: string, pc: string) => `tbd:optimistic:${localId}:${cid}:${pc}`;
      const optimisticRows: IpPlanningGridRow[] = combos.map((c) => ({
        forecast_id: synthFidFor(c.customer_id, c.period.period_code),
        planning_run_id: selectedRun.id,
        customer_id: c.customer_id,
        customer_name: c.customer_name,
        category_id: null,
        category_name: null,
        group_name: args.group_name,
        sub_category_name: args.sub_category_name,
        gender: null,
        sku_id: `tbd:${args.style_code}`,
        sku_code: `${args.style_code}-TBD`,
        sku_description: args.notes ?? null,
        is_new_description: !!(args.notes && args.notes.trim()),
        sku_style: args.style_code,
        sku_color: args.color,
        sku_color_inferred: false,
        is_tbd: true,
        is_new_color: args.is_new_color,
        is_user_added: true,
        tbd_id: undefined,
        sku_size: null,
        period_code: c.period.period_code,
        period_start: c.period.period_start,
        period_end: c.period.period_end,
        historical_trailing_qty: 0,
        system_forecast_qty: 0,
        system_forecast_qty_original: 0,
        system_forecast_qty_overridden_at: null,
        system_forecast_qty_overridden_by: null,
        buyer_request_qty: 0,
        override_qty: 0,
        final_forecast_qty: 0,
        confidence_level: "estimate",
        forecast_method: "zero_floor",
        ly_reference_qty: null,
        historical_margin_pct: null,
        item_cost: null,
        ats_avg_cost: null,
        avg_cost: null,
        unit_cost_override: null,
        unit_cost: null,
        planned_buy_qty: null,
        on_hand_qty: 0,
        on_so_qty: 0,
        on_po_qty: 0,
        receipts_due_qty: 0,
        historical_receipts_qty: 0,
        available_supply_qty: 0,
        projected_shortage_qty: 0,
        projected_excess_qty: 0,
        recommended_action: "monitor",
        recommended_qty: null,
        action_reason: null,
        notes: null,
      }));
      setRows((prev) => [...prev, ...optimisticRows]);
      // Push this batch onto the add-undo stack (newest last, cap at
      // ADD_UNDO_DEPTH). Undo removes the WHOLE batch — every customer × period
      // it created — and repeated Undo walks back up to 4 adds.
      setAddUndoStack((prev) => [
        ...prev.slice(-(ADD_UNDO_DEPTH - 1)),
        {
          style_code: args.style_code,
          color: args.color,
          customer_ids: args.customer_ids,
          period_codes: periodSamples.map((p) => p.period_code),
        },
      ]);
      // Fire all inserts in parallel; stamp tbd_id + reconcile drift
      // (planner edits during flight) when each settles. Collect the promises
      // so the rebuild below can wait for EVERY insert to commit before it
      // re-reads the DB — otherwise buildGridRows races the in-flight inserts,
      // reads a partial set, and setRows clobbers the optimistic rows (e.g.
      // "9 created, only 4 shown" when the rebuild fired after 4 committed).
      const insertPromises: Array<Promise<void>> = [];
      for (const c of combos) {
        const synthFid = synthFidFor(c.customer_id, c.period.period_code);
        insertPromises.push(wholesaleRepo.insertTbdRow(selectedRun.id, {
          style_code: args.style_code,
          color: args.color,
          is_new_color: args.is_new_color,
          customer_id: c.customer_id,
          group_name: args.group_name,
          sub_category_name: args.sub_category_name,
          period_start: c.period.period_start,
          period_end: c.period.period_end,
          period_code: c.period.period_code,
          notes: args.notes ?? null,
        })
          .then((r) => {
            let drifted: IpPlanningGridRow | null = null;
            setRows((prev) => prev.map((row) => {
              if (row.forecast_id !== synthFid) return row;
              drifted = row;
              return { ...row, forecast_id: `tbd:${r.id}`, tbd_id: r.id };
            }));
            if (!drifted) return;
            const drifty: IpPlanningGridRow = drifted;
            const patch: Record<string, unknown> = {};
            if ((drifty.sku_color ?? "TBD") !== args.color) {
              patch.color = drifty.sku_color ?? "TBD";
              patch.is_new_color = !!drifty.is_new_color;
            }
            if (drifty.customer_id !== c.customer_id) {
              patch.customer_id = drifty.customer_id;
            }
            const drifyDesc = drifty.sku_description?.trim() || null;
            const initDesc = (args.notes ?? null) && (args.notes ?? "").trim() ? args.notes!.trim() : null;
            if (drifyDesc !== initDesc) {
              patch.notes = drifyDesc;
            }
            if (Object.keys(patch).length > 0) {
              void wholesaleRepo.patchTbdRow(r.id, patch)
                .catch((e) => console.warn(`[planning] add-row reconcile ${c.period.period_code} failed`, e));
            }
          })
          .catch((e) => {
            console.warn(`[planning] add-row insert ${c.customer_name}/${c.period.period_code} failed`, e);
            // Drop the optimistic row so the planner sees the failure
            // (instead of a phantom row that will never persist).
            setRows((prev) => prev.filter((row) => row.forecast_id !== synthFid));
          }));
      }
      // Confirm the add with a sticky toast that names the batch and
      // carries a "Show them" action. The grid no longer pins the row to
      // the top; instead "Show them" filters the grid to exactly this
      // batch (style + color + customers + periods) — the reliable way
      // to surface a multi-period / multi-customer add even when the
      // planner's current filters or sort would otherwise scatter it.
      const rowCount = combos.length;
      const rowLabel = `${rowCount} row${rowCount === 1 ? "" : "s"}`;
      const batchPeriodCodes = periodSamples.map((p) => p.period_code).sort();
      const periodRange = batchPeriodCodes.length === 1
        ? formatPeriodCode(batchPeriodCodes[0])
        : `${formatPeriodCode(batchPeriodCodes[0])}–${formatPeriodCode(batchPeriodCodes[batchPeriodCodes.length - 1])}`;
      const custLabel = args.customer_ids.length === 1
        ? (customers.find((c) => c.id === args.customer_ids[0])?.name ?? "1 customer")
        : `${args.customer_ids.length} customers`;
      const colorLabel = args.color === "TBD" ? "" : `${args.color} · `;
      setToast({
        text: `Added ${rowLabel}: ${colorLabel}${custLabel} · ${periodRange}`,
        kind: "success",
        sticky: true,
        action: {
          label: "Show them",
          onClick: () => setFocusBatch({
            style_code: args.style_code,
            color: args.color,
            customer_ids: args.customer_ids,
            period_codes: batchPeriodCodes,
            nonce: Date.now(),
          }),
        },
      });
      // Fire-and-forget the grid rebuild so the Save button releases
      // as soon as the upsert returns. Without this the form sat on
      // "Saving…" for as long as the rebuild took (10+ parallel
      // fetches; multi-second on a large run). The new row appears
      // when the rebuild lands a moment later — guarded by
      // rebuildSeq so a slow rebuild can't overwrite a faster one.
      const seq = ++rebuildSeq.current;
      void (async () => {
        try {
          // Wait for EVERY insert to commit before re-reading, or buildGridRows
          // reads a partial set and setRows drops the just-added rows that
          // haven't landed yet. allSettled: a single failed insert already
          // dropped its own optimistic row above and shouldn't block the rest.
          await Promise.allSettled(insertPromises);
          if (seq !== rebuildSeq.current) return;
          const refreshed = await buildGridRows(selectedRun);
          if (seq !== rebuildSeq.current) return;
          setRows(refreshed);
        } catch (e) { console.warn("[ip rebuild]", e); }
      })();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setToast({ text: `Add row failed — ${msg}`, kind: "error" });
      throw e;
    }
  }

  // Undo the most recent + Add row batch (Undo can be pressed up to 4 times to
  // walk back the last 4 adds). Pops the newest batch off the stack and deletes
  // EVERY user-added TBD row it created — all customer × period combos for that
  // (style, color) — including any duplicates that share the same grain. Uses
  // the same delete path as the per-row ✕.
  async function undoLastAddedTbd() {
    if (!selectedRun || addUndoStack.length === 0) return;
    const batch = addUndoStack[addUndoStack.length - 1];
    setAddUndoStack((prev) => prev.slice(0, -1));
    const custSet = new Set(batch.customer_ids);
    const periodSet = new Set(batch.period_codes);
    const targets = rows.filter((r) =>
      r.is_tbd
      && r.is_user_added
      && (r.sku_style ?? "") === batch.style_code
      && (r.sku_color ?? "") === batch.color
      && custSet.has(r.customer_id)
      && periodSet.has(r.period_code),
    );
    if (targets.length === 0) {
      setToast({ text: "Nothing left to undo for that add.", kind: "info" });
      return;
    }
    const fids = new Set(targets.map((r) => r.forecast_id));
    setRows((prev) => prev.filter((r) => !fids.has(r.forecast_id)));
    try {
      // Delete the persisted rows (skip synthetic ones that never got a tbd_id).
      await Promise.all(targets.filter((t) => t.tbd_id).map((t) => wholesaleRepo.deleteTbdRow(t.tbd_id!)));
      setToast({ text: `Undid add — removed ${targets.length} row${targets.length === 1 ? "" : "s"} (${batch.style_code} / ${batch.color}).`, kind: "success" });
    } catch (e) {
      setToast({ text: `Undo failed — ${e instanceof Error ? e.message : String(e)}`, kind: "error" });
    } finally {
      const seq = ++rebuildSeq.current;
      void (async () => {
        try {
          const refreshed = await buildGridRows(selectedRun);
          if (seq === rebuildSeq.current) setRows(refreshed);
        } catch (e) { console.warn("[ip rebuild]", e); }
      })();
    }
  }

  // Delete a planner-added TBD stock-buy row. Auto-synthesized rows
  // (per-style and per-period catch-all) aren't deletable — they're
  // the standing infrastructure aggregate edits land on. Only rows
  // tagged is_user_added survive a delete request.
  async function deleteTbdRow(row: IpPlanningGridRow) {
    if (!selectedRun) return;
    if (!row.is_user_added) {
      setToast({ text: "Only rows you added with + Add row can be deleted.", kind: "error" });
      return;
    }
    if (!row.tbd_id) {
      // Synthetic — nothing to delete in the DB. Just refresh.
      setToast({ text: "Row not yet saved — discarded.", kind: "success" });
      const seq = ++rebuildSeq.current;
      const refreshed = await buildGridRows(selectedRun);
      if (seq !== rebuildSeq.current) return;
      setRows(refreshed);
      return;
    }
    // Optimistic remove from the local state so the row disappears
    // immediately; a failed delete refreshes from server below.
    const fid = row.forecast_id;
    setRows((prev) => prev.filter((r) => r.forecast_id !== fid));
    try {
      await wholesaleRepo.deleteTbdRow(row.tbd_id);
      setToast({ text: "Row deleted.", kind: "success" });
      const seq = ++rebuildSeq.current;
      void (async () => {
        try {
          const refreshed = await buildGridRows(selectedRun);
          if (seq !== rebuildSeq.current) return;
          setRows(refreshed);
        } catch (e) {
          // Surface the rebuild failure so the planner doesn't see an
          // empty grid and assume the delete wiped everything. The
          // optimistic local state already has every row except the
          // deleted one — the rebuild would have reconciled it, but if
          // it failed (typically Supabase 57014 timeouts on listItems),
          // the local state is still authoritative.
          const msg = e instanceof Error ? e.message : String(e);
          setToast({ text: `Row deleted, but couldn't refresh grid — ${msg}. Reload to reconcile.`, kind: "error" });
        }
      })();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setToast({ text: `Delete failed — ${msg}`, kind: "error" });
      const seq = ++rebuildSeq.current;
      const refreshed = await buildGridRows(selectedRun);
      if (seq !== rebuildSeq.current) return;
      setRows(refreshed);
    }
  }

  // Rename the style on a TBD stock-buy row. Used by the Phase 5
  // catch-all routing so a planner can promote a (style="TBD")
  // catch-all row into a specific style — or revert any style-
  // specific TBD row back to "TBD" to send its qty into the catch-
  // all slot. The unique grain (run, style_code, color, customer,
  // period_start) means a TBD row already exists for the target
  // style would conflict; on conflict we surface a toast asking the
  // planner to drill into the target row directly.
  async function saveTbdStyle(row: IpPlanningGridRow, styleCode: string) {
    if (!selectedRun) return;
    // Trace log so we can see exactly which row the planner is
    // editing — was the click landing on the user-added row, or on
    // the auto catch-all (which would silently rewrite the wrong
    // row's style).
    // eslint-disable-next-line no-console
    console.log("[ip-saveTbdStyle]", {
      newStyle: styleCode,
      row: {
        forecast_id: row.forecast_id,
        tbd_id: row.tbd_id,
        sku_style: row.sku_style,
        sku_color: row.sku_color,
        customer_name: row.customer_name,
        period_code: row.period_code,
        is_user_added: row.is_user_added,
        is_aggregate: row.is_aggregate,
      },
    });
    const dup = findTbdDuplicate(styleCode, row.sku_color ?? "", row.customer_id, row.period_code, row.forecast_id);
    if (dup) {
      setToast({
        text: `Already have a ${styleCode} / ${row.sku_color ?? "TBD"} row for ${dup.customer_name} in ${row.period_code}. Pick a different style or merge into the existing row.`,
        kind: "error",
      });
      return;
    }
    // Optimistic update so the picker dismiss feels instant — even
    // before the network patch lands. The ~10s hang the user reported
    // was the buildGridRows rebuild being awaited inline; switched
    // to fire-and-forget like every other TBD save handler.
    const fid = row.forecast_id;
    setRows((prev) => prev.map((r) => r.forecast_id === fid ? { ...r, sku_style: styleCode } : r));
    // Move the just-added pin marker forward so the row keeps its
    // top-of-bucket pin after the style is renamed. Without this
    // the marker still references the OLD style_code, the pin
    // identity check (style+color+customer+period) misses, the row
    // de-pins, and a planner who picked a brand-new style sees
    // "saved" with no visible row in their viewport.
    // Editing a TBD row's dimensions invalidates the add-undo history.
    setAddUndoStack([]);
    const fireRebuild = () => {
      const seq = ++rebuildSeq.current;
      void (async () => {
        try {
          const refreshed = await buildGridRows(selectedRun);
          if (seq !== rebuildSeq.current) return;
          setRows(refreshed);
        } catch (e) { console.warn("[ip rebuild]", e); }
      })();
    };
    if (!row.tbd_id) {
      try {
        await wholesaleRepo.upsertTbdRow(selectedRun.id, {
          style_code: styleCode,
          color: row.sku_color ?? "TBD",
          is_new_color: row.is_new_color ?? false,
          // Preserve the row's user-added flag so a planner-added
          // TBD row that's been style-renamed doesn't get re-tagged
          // as auto. Without this the routing logic would conflate
          // it with the auto catch-all.
          is_user_added: row.is_user_added ?? false,
          customer_id: row.customer_id,
          group_name: row.group_name ?? null,
          sub_category_name: row.sub_category_name ?? null,
          period_start: row.period_start,
          period_end: row.period_end,
          period_code: row.period_code,
          buyer_request_qty: row.buyer_request_qty,
          override_qty: row.override_qty,
          final_forecast_qty: row.final_forecast_qty,
          planned_buy_qty: row.planned_buy_qty,
          unit_cost: row.unit_cost,
          notes: row.notes ?? null,
        });
        setToast({ text: `Style set to ${styleCode}`, kind: "success" });
        fireRebuild();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setToast({ text: `Style save failed — ${msg}`, kind: "error" });
        fireRebuild();
      }
      return;
    }
    try {
      // Look for any existing planner-added row already on this
      // NEW style — it's "row one" that established this NEW style
      // first. Cloned sibling-period rows + the row being renamed
      // (when it has placeholder values) inherit color, customer,
      // and description from row one so the planner doesn't have
      // to re-enter them per period.
      const existingNewStyleRow = (() => {
        const masterStyleSet0 = new Set(masterStyles.map((m) => m.style_code.toLowerCase()));
        if (masterStyleSet0.has(styleCode.toLowerCase())) return null;
        return rows.find((r) =>
          r.is_tbd && r.is_user_added && r.tbd_id && r.tbd_id !== row.tbd_id
          && (r.sku_style ?? "").toLowerCase() === styleCode.toLowerCase()
          && (r.sku_description?.trim() || r.sku_color !== "TBD"),
        ) ?? null;
      })();
      // Source values for cloned siblings + main-row inheritance.
      // Color is INTENTIONALLY not inherited from existingNewStyleRow:
      // a second row added on the same NEW style is treated as a
      // new-color variant intent (planner's typical workflow — they
      // re-add to add a different colorway). Customer + description
      // still inherit since those usually do match across variants.
      const sourceColor = row.sku_color ?? "TBD";
      const sourceIsNewColor = !!row.is_new_color;
      const sourceCustomerId = (existingNewStyleRow && existingNewStyleRow.customer_name !== "(Supply Only)")
        ? existingNewStyleRow.customer_id
        : row.customer_id;
      const sourceCustomerName = (existingNewStyleRow && existingNewStyleRow.customer_name !== "(Supply Only)")
        ? existingNewStyleRow.customer_name
        : row.customer_name;
      const sourceDescription = existingNewStyleRow?.sku_description?.trim()
        || row.sku_description?.trim()
        || null;
      // Patch the main row with the new style + any inherited
      // values for fields the planner left as placeholder. Color
      // is excluded — see comment above.
      const rowCustomerEmpty = row.customer_name === "(Supply Only)";
      const rowDescriptionEmpty = !row.sku_description?.trim();
      const stylePatch: Record<string, unknown> = { style_code: styleCode };
      if (existingNewStyleRow) {
        if (rowCustomerEmpty && existingNewStyleRow.customer_name !== "(Supply Only)") {
          stylePatch.customer_id = existingNewStyleRow.customer_id;
        }
        if (rowDescriptionEmpty && existingNewStyleRow.sku_description?.trim()) {
          stylePatch.notes = existingNewStyleRow.sku_description.trim();
        }
      }
      await wholesaleRepo.patchTbdRow(row.tbd_id, stylePatch);
      // Reflect inherited values on the row being saved so the grid
      // shows them before the rebuild lands.
      const fid2 = row.forecast_id;
      setRows((prev) => prev.map((r) => {
        if (r.forecast_id !== fid2) return r;
        const next = { ...r };
        if (existingNewStyleRow) {
          if (rowCustomerEmpty && existingNewStyleRow.customer_name !== "(Supply Only)") {
            next.customer_id = existingNewStyleRow.customer_id;
            next.customer_name = existingNewStyleRow.customer_name;
          }
          if (rowDescriptionEmpty && existingNewStyleRow.sku_description?.trim()) {
            next.sku_description = existingNewStyleRow.sku_description.trim();
            next.is_new_description = true;
          }
        }
        return next;
      }));
      // Sibling-period propagation for brand-new styles: if the
      // planner just renamed a row to a style not in the master,
      // also create matching TBD rows for every OTHER period that
      // sibling styles in the same (group_name, sub_category_name)
      // are being planned for. The new style starts off appearing
      // alongside its siblings instead of stranded in one period.
      // Only triggers on master-unknown styles — renaming to an
      // existing master style doesn't clone (those styles already
      // have their own forecast rows in other periods).
      const masterStyleSet = new Set(masterStyles.map((m) => m.style_code.toLowerCase()));
      const isNewMasterStyle = !!styleCode
        && styleCode.toLowerCase() !== "tbd"
        && !masterStyleSet.has(styleCode.toLowerCase());
      if (isNewMasterStyle) {
        // Every period the run covers — see the matching comment in
        // addTbdRow. Restricting to periods with non-TBD forecast rows
        // in the same cat/sub-cat skipped months that had zero
        // historical demand for the combo, leaving holes the planner
        // had to fill manually.
        const siblingPeriods = new Map<string, { period_code: string; period_start: IpIsoDate; period_end: IpIsoDate }>();
        for (const r of rows) {
          if (r.period_code === row.period_code) continue;
          if (!siblingPeriods.has(r.period_code)) {
            siblingPeriods.set(r.period_code, {
              period_code: r.period_code,
              period_start: r.period_start,
              period_end: r.period_end,
            });
          }
        }
        // Skip periods where a TBD row at this exact (style, color,
        // customer) grain already exists. A different-color variant
        // of the same NEW style is allowed to coexist in the same
        // period — that's the second-add new-colorway workflow.
        const alreadyHave = new Set<string>();
        for (const r of rows) {
          if (!r.is_tbd) continue;
          if ((r.sku_style ?? "") !== styleCode) continue;
          if ((r.sku_color ?? "") !== sourceColor) continue;
          if (r.customer_id !== sourceCustomerId) continue;
          alreadyHave.add(r.period_code);
        }
        const toClone = Array.from(siblingPeriods.values()).filter((p) => !alreadyHave.has(p.period_code));
        if (toClone.length > 0) {
          // Optimistic insertion — synthesize sibling rows in local
          // state so they appear on the grid INSTANTLY instead of
          // waiting ~20s for the buildGridRows network rebuild
          // (Supabase pos/items endpoints frequently 57014 and
          // retry, compounding the delay). The synthetic rows clone
          // the source row's shape with the period swapped + qtys
          // zeroed; the rebuild later replaces them with persisted
          // counterparts.
          const optimisticRows = toClone.map((p) => ({
            ...row,
            forecast_id: `tbd:optimistic:${row.tbd_id}:${p.period_code}`,
            tbd_id: undefined as string | undefined,
            sku_style: styleCode,
            sku_color: sourceColor,
            is_new_color: sourceIsNewColor,
            customer_id: sourceCustomerId,
            customer_name: sourceCustomerName,
            sku_description: sourceDescription,
            is_new_description: !!sourceDescription,
            period_code: p.period_code,
            period_start: p.period_start,
            period_end: p.period_end,
            buyer_request_qty: 0,
            override_qty: 0,
            final_forecast_qty: 0,
            historical_trailing_qty: 0,
            ly_reference_qty: null,
            historical_margin_pct: null,
            system_forecast_qty: 0,
            system_forecast_qty_original: 0,
          }));
          setRows((prev) => [...prev, ...optimisticRows]);
          // Fire the network inserts in parallel — DON'T await,
          // so the toast + UI feel instant. Rebuild reconciles.
          void Promise.all(toClone.map((p) => wholesaleRepo.insertTbdRow(selectedRun.id, {
            style_code: styleCode,
            color: sourceColor,
            is_new_color: sourceIsNewColor,
            customer_id: sourceCustomerId,
            group_name: row.group_name ?? null,
            sub_category_name: row.sub_category_name ?? null,
            period_start: p.period_start,
            period_end: p.period_end,
            period_code: p.period_code,
            notes: sourceDescription,
          }).catch((e) => {
            // Surface but don't block the main save — the planner
            // can retry or add manually.
            console.warn(`[planning] sibling-period clone for ${styleCode} ${p.period_code} failed`, e);
          })));
          setToast({
            text: `Style set to ${styleCode} · cloned to ${toClone.length} other period${toClone.length === 1 ? "" : "s"}`,
            kind: "success",
          });
        } else {
          setToast({ text: `Style set to ${styleCode}`, kind: "success" });
        }
      } else {
        setToast({ text: `Style set to ${styleCode}`, kind: "success" });
      }
      fireRebuild();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("23505")) {
        setToast({ text: `A TBD row already exists for ${styleCode} in this period. Drill in to edit it directly.`, kind: "error" });
      } else {
        setToast({ text: `Style save failed — ${msg}`, kind: "error" });
      }
      fireRebuild();
    }
  }

  // Reassign a TBD stock-buy row to a real customer (or back to the
  // (Supply Only) placeholder). Decision (a): the row stays as-is —
  // it just changes ownership. The next planning build may absorb
  // the qty into the new customer's regular forecast row, but until
  // then the line continues to render on the grid as is_tbd.
  async function saveTbdCustomer(row: IpPlanningGridRow, customerId: string, customerName: string) {
    if (!selectedRun) return;
    const dup = findTbdDuplicate(row.sku_style ?? "", row.sku_color ?? "", customerId, row.period_code, row.forecast_id);
    if (dup) {
      setToast({
        text: `Already have a ${row.sku_style ?? "TBD"} / ${row.sku_color ?? "TBD"} row for ${customerName} in ${row.period_code}. Pick a different customer.`,
        kind: "error",
      });
      return;
    }
    // Customer is per-row by default. The exception: editing the
    // FIRST row of a NEW style (earliest period_start among siblings)
    // is treated as a master-level change and backfills siblings that
    // share row 1's PRE-edit customer (or the "(Supply Only)"
    // placeholder). Editing any subsequent period's row is a per-row
    // adjustment that does NOT ripple — that's how a planner re-targets
    // a single month without touching the rest.
    const fid = row.forecast_id;
    const isFirst = isFirstRowOfNewStyle(row);
    const placeholderSiblings = isFirst
      ? siblingTbdRowsForNewStyle(row).filter((s) =>
          s.customer_id === row.customer_id || s.customer_name === "(Supply Only)",
        )
      : [];
    const placeholderSiblingFids = new Set(placeholderSiblings.map((s) => s.forecast_id));
    setRows((prev) => prev.map((r) => {
      if (r.forecast_id === fid) return { ...r, customer_id: customerId, customer_name: customerName };
      if (placeholderSiblingFids.has(r.forecast_id)) return { ...r, customer_id: customerId, customer_name: customerName };
      return r;
    }));
    // Editing a TBD row's dimensions invalidates the add-undo history.
    setAddUndoStack([]);
    try {
      await saveTbdField(row, { customer_id: customerId });
      const patchableSiblings = placeholderSiblings.filter((s) => !!s.tbd_id);
      if (patchableSiblings.length > 0) {
        void Promise.all(patchableSiblings.map((s) => wholesaleRepo.patchTbdRow(s.tbd_id!, {
          customer_id: customerId,
        }).catch((e) => console.warn(`[planning] customer backfill ${s.period_code} failed`, e))));
      }
      setToast({
        text: placeholderSiblings.length > 0
          ? `Reassigned to ${customerName} · backfilled ${placeholderSiblings.length} sibling period${placeholderSiblings.length === 1 ? "" : "s"}`
          : `Reassigned to ${customerName}`,
        kind: "success",
      });
      const seq = ++rebuildSeq.current;
      void (async () => {
        try {
          const refreshed = await buildGridRows(selectedRun);
          if (seq !== rebuildSeq.current) return;
          setRows(refreshed);
        } catch (e) { console.warn("[ip rebuild]", e); }
      })();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setToast({ text: `Customer reassign failed — ${msg}`, kind: "error" });
      const seq = ++rebuildSeq.current;
      const refreshed = await buildGridRows(selectedRun);
      if (seq !== rebuildSeq.current) return;
      setRows(refreshed);
    }
  }

  // Rename the color on a TBD stock-buy row. is_new_color is set per
  // the caller's judgement (the grid checks the typed string against
  // the style's known colors before calling). Optimistic UI updates
  // the local row immediately; rebuild reconciles on success.
  // Helper: collect every TBD row sharing the same style_code as
  // the input row, EXCEPT the row itself. Includes optimistic siblings
  // that don't yet have a tbd_id stamped — callers must filter to
  // tbd_id-only when issuing network PATCHes, and use the full set
  // for local-state updates so the UI reflects the change on every
  // sibling immediately. The addTbdRow sibling-insert resolver
  // reconciles any drift the planner introduced while the insert
  // was in flight.
  function siblingTbdRowsForNewStyle(row: IpPlanningGridRow): IpPlanningGridRow[] {
    const styleLower = (row.sku_style ?? "").toLowerCase();
    if (!styleLower || styleLower === "tbd") return [];
    if (masterStyles.some((m) => m.style_code.toLowerCase() === styleLower)) return [];
    return rows.filter((r) =>
      r.is_tbd
      && r.forecast_id !== row.forecast_id
      && (r.sku_style ?? "").toLowerCase() === styleLower,
    );
  }

  // Identify the "first row" of a NEW style for cross-period propagation
  // decisions. Defined as the row with the earliest period_start (e.g.
  // Jan in a Jan–Dec plan), tied broken by tbd_id. Editing the first row
  // is treated as setting the master values for the whole NEW style;
  // editing any other row is a per-period adjustment that shouldn't
  // ripple. Returns true when the input row is alone (no siblings).
  function isFirstRowOfNewStyle(row: IpPlanningGridRow): boolean {
    const styleLower = (row.sku_style ?? "").toLowerCase();
    if (!styleLower || styleLower === "tbd") return true;
    if (masterStyles.some((m) => m.style_code.toLowerCase() === styleLower)) return true;
    const family = rows.filter((r) =>
      r.is_tbd && (r.sku_style ?? "").toLowerCase() === styleLower,
    );
    if (family.length <= 1) return true;
    const sorted = [...family].sort((a, b) => {
      const ps = a.period_start.localeCompare(b.period_start);
      if (ps !== 0) return ps;
      return (a.tbd_id ?? "").localeCompare(b.tbd_id ?? "");
    });
    return sorted[0].forecast_id === row.forecast_id;
  }

  // Free-text description on TBD rows. Stored in the row's `notes`
  // column (no dedicated description column on ip_wholesale_forecast_tbd
  // — notes serves dual purpose for TBD rows). Empty string clears
  // the override so the grid falls back to master description.
  async function saveTbdDescription(row: IpPlanningGridRow, description: string) {
    if (!selectedRun) return;
    const fid = row.forecast_id;
    const next = description.trim() === "" ? null : description.trim();
    const siblings = siblingTbdRowsForNewStyle(row);
    // Confirm before propagating across periods — only when the
    // row already has a description (planner is REPLACING, not
    // setting for the first time) AND siblings exist on the same
    // master-unknown style. The first-time set is the common
    // single-row flow and shouldn't pop a modal.
    const hadValue = !!row.sku_description?.trim();
    if (hadValue && siblings.length > 0) {
      const ok = await askConfirm(
        `Update description across ${siblings.length + 1} periods?`,
        `Style ${row.sku_style ?? ""} description will change to "${next ?? "(empty)"}" on this row AND on every other period in the build.`,
        "Update all",
      );
      if (!ok) return;
    }
    // Optimistic update — apply to the edited row AND every sibling
    // up front so the cells repopulate the moment the planner
    // confirms. Without this, the UI lagged ~15-20s waiting for
    // the buildGridRows rebuild to finish on every save.
    const siblingFids = new Set(siblings.map((s) => s.forecast_id));
    setRows((prev) => prev.map((r) => {
      if (r.forecast_id === fid) return { ...r, sku_description: next, is_new_description: !!next };
      if (siblingFids.has(r.forecast_id)) return { ...r, sku_description: next, is_new_description: !!next };
      return r;
    }));
    try {
      await saveTbdField(row, { notes: next });
      // Propagate to every sibling-period row when the row's style
      // is master-unknown — the planner expects the description
      // they typed for "RYB9999" to apply across all the periods
      // their new style spans.
      const patchableSiblings = siblings.filter((s) => !!s.tbd_id);
      if (patchableSiblings.length > 0) {
        await Promise.all(patchableSiblings.map((s) => wholesaleRepo.patchTbdRow(s.tbd_id!, { notes: next })
          .catch((e) => console.warn(`[planning] description propagate ${s.period_code} failed`, e))));
      }
      setToast({
        text: next
          ? (siblings.length > 0 ? `Description set · cloned to ${siblings.length} sibling period${siblings.length === 1 ? "" : "s"}` : `Description set`)
          : `Description cleared`,
        kind: "success",
      });
      const seq = ++rebuildSeq.current;
      void (async () => {
        try {
          const refreshed = await buildGridRows(selectedRun);
          if (seq !== rebuildSeq.current) return;
          setRows(refreshed);
        } catch (e) { console.warn("[ip rebuild]", e); }
      })();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setToast({ text: `Description save failed — ${msg}`, kind: "error" });
    }
  }

  // Create a brand-new customer in ip_customer_master and assign
  // the row to them. Triggered from "Add as NEW customer" in the
  // TBD customer picker. Refreshes the local customers list so the
  // new customer immediately appears in every cell's dropdown.
  async function saveTbdNewCustomer(row: IpPlanningGridRow, customerName: string) {
    if (!selectedRun) return;
    const trimmed = customerName.trim();
    if (!trimmed) {
      setToast({ text: "Customer name can't be empty", kind: "error" });
      return;
    }
    try {
      const created = await wholesaleRepo.insertCustomer(trimmed);
      // Append the new customer to local state so all dropdowns
      // know about them right away. The minimal IpCustomer shape
      // is enough for the picker (id + name) but we stamp
      // external_refs.planning_added too so the NEW-badge logic in
      // the cell + other dropdowns matches what the DB returned.
      setCustomers((prev) => {
        if (prev.some((c) => c.id === created.id)) return prev;
        const newRow: IpCustomer = {
          id: created.id,
          customer_code: "",
          name: created.name,
          parent_customer_id: null,
          customer_tier: null,
          country: null,
          channel_id: null,
          active: true,
          external_refs: { planning_added: "1" },
        };
        return [...prev, newRow].sort((a, b) => a.name.localeCompare(b.name));
      });
      // Flag the customer as NEW for this session so the customer
      // cell badges them. Cleared on page refresh.
      setNewCustomerIds((prev) => {
        const next = new Set(prev);
        next.add(created.id);
        return next;
      });
      await saveTbdCustomer(row, created.id, created.name);
      setToast({ text: `Added new customer "${created.name}" and assigned the row to them`, kind: "success" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setToast({ text: `Add customer failed — ${msg}`, kind: "error" });
    }
  }

  // Promote a planner-added new style+color into the SHARED company masters
  // (ip_item_master + style_master) so it shows in Tangerine + ATS, where
  // someone completes the details. Opt-in (a TBD row's "Add to DB" button) — the
  // default stays temporary/planning-only. Idempotent server-side.
  async function promoteTbdStyleColor(row: IpPlanningGridRow) {
    const style = (row.sku_style ?? "").trim();
    const color = (row.sku_color ?? "").trim();
    if (!style || style.toUpperCase() === "TBD" || !color || color.toUpperCase() === "TBD") {
      setToast({ text: "Give the row a real style and color before adding it to the database.", kind: "error" });
      return;
    }
    const ok = await confirmDialog(
      `Add "${style} / ${color}" to the company database?\n\n` +
      `It will be created in the Style Master + item master and become visible in Tangerine and ATS. ` +
      `It's flagged for review so someone can complete the details (brand, category, size scale, …).`,
      { title: "Add to company database", confirmText: "Add to database", cancelText: "Cancel", confirmColor: "#3B82F6" },
    );
    if (!ok) return;
    try {
      const r = await promoteStyleColor({
        style_code: style,
        color,
        description: row.sku_description ?? null,
        group_name: row.group_name ?? null,
        sub_category_name: row.sub_category_name ?? null,
      });
      // Lowercased key so every row with this style+color (across all periods
      // and customers) recognizes the promote — the render gate matches the
      // same normalized key.
      setPromotedTbdKeys((prev) => new Set(prev).add(`${style.toLowerCase()}|${color.toLowerCase()}`));
      const parts: string[] = [];
      if (r.style_created) parts.push("style created"); else if (r.style_existed) parts.push("style already existed");
      if (r.item_created) parts.push("item created"); else if (r.item_existed) parts.push("item already existed");
      const warn = r.warnings.length ? ` (${r.warnings.join("; ")})` : "";
      setToast({
        text: `Added "${style} / ${color}" to the company database — ${parts.join(", ") || "done"}${warn}`,
        kind: r.warnings.length ? "info" : "success",
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setToast({ text: `Add to database failed — ${msg}`, kind: "error" });
    }
  }

  async function saveTbdColor(row: IpPlanningGridRow, color: string, isNewColor: boolean) {
    if (!selectedRun) return;
    const dup = findTbdDuplicate(row.sku_style ?? "", color, row.customer_id, row.period_code, row.forecast_id);
    if (dup) {
      setToast({
        text: `Already have a ${row.sku_style ?? "TBD"} / ${color} row for ${dup.customer_name} in ${row.period_code}. Pick a different color.`,
        kind: "error",
      });
      return;
    }
    // Color is a per-row attribute. Backfill siblings of the same NEW
    // style that share the row's PRE-edit color (a second color change
    // from Blue → Red should propagate to siblings still showing Blue),
    // OR siblings still showing the placeholder TBD. Siblings where the
    // planner has already set a different explicit color stay untouched.
    const fid = row.forecast_id;
    const placeholderSiblings = siblingTbdRowsForNewStyle(row).filter((s) =>
      !s.sku_color || s.sku_color === "TBD" || s.sku_color === row.sku_color,
    );
    const placeholderSiblingFids = new Set(placeholderSiblings.map((s) => s.forecast_id));
    setRows((prev) => prev.map((r) => {
      if (r.forecast_id === fid) return { ...r, sku_color: color, is_new_color: isNewColor };
      if (placeholderSiblingFids.has(r.forecast_id)) return { ...r, sku_color: color, is_new_color: isNewColor };
      return r;
    }));
    // Editing a TBD row's dimensions invalidates the add-undo history.
    setAddUndoStack([]);
    try {
      await saveTbdField(row, { color, is_new_color: isNewColor });
      // PATCH only siblings with a real tbd_id — optimistic ones
      // still in flight will be reconciled by addTbdRow's resolver
      // when their INSERT lands. Local state already updated above.
      // Await Promise.all (instead of fire-and-forget) so the rebuild
      // below kicks off only AFTER the DB has every sibling's new
      // color persisted. Without this, a rebuild started in the gap
      // between PATCHes could fetch a half-mutated state and revert
      // some periods to their pre-edit color.
      const patchableSiblings = placeholderSiblings.filter((s) => !!s.tbd_id);
      if (patchableSiblings.length > 0) {
        await Promise.all(patchableSiblings.map((s) => wholesaleRepo.patchTbdRow(s.tbd_id!, {
          color, is_new_color: isNewColor,
        }).catch((e) => console.warn(`[planning] color backfill ${s.period_code} failed`, e))));
      }
      setToast({
        text: placeholderSiblings.length > 0
          ? `Set color to "${color}" · backfilled ${placeholderSiblings.length} sibling period${placeholderSiblings.length === 1 ? "" : "s"}`
          : (isNewColor
            ? `Set color to "${color}" (NEW — not in master yet)`
            : `Set color to "${color}"`),
        kind: "success",
      });
      const seq = ++rebuildSeq.current;
      void (async () => {
        try {
          const refreshed = await buildGridRows(selectedRun);
          if (seq !== rebuildSeq.current) return;
          setRows(refreshed);
        } catch (e) { console.warn("[ip rebuild]", e); }
      })();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setToast({ text: `Color save failed — ${msg}`, kind: "error" });
      const seq = ++rebuildSeq.current;
      const refreshed = await buildGridRows(selectedRun);
      if (seq !== rebuildSeq.current) return;
      setRows(refreshed);
    }
  }

  // Persist edits on a TBD stock-buy row (forecast_id prefixed "tbd:").
  // Synthetic rows (no tbd_id yet) get upserted into
  // ip_wholesale_forecast_tbd with the supplied field overrides; rows
  // already persisted get a targeted PATCH. Either way, on success we
  // rebuild the grid (fire-and-forget) so the rest of the row state
  // (final_forecast_qty, etc.) reconciles.
  async function saveTbdField(
    row: IpPlanningGridRow,
    fields: Partial<{
      buyer_request_qty: number;
      override_qty: number;
      final_forecast_qty: number;
      planned_buy_qty: number | null;
      unit_cost: number | null;
      color: string;
      is_new_color: boolean;
      customer_id: string;
      group_name: string | null;
      sub_category_name: string | null;
      notes: string | null;
    }>,
  ): Promise<void> {
    if (!selectedRun) return;
    if (!row.sku_style) throw new Error("saveTbdField: TBD row missing sku_style");
    // Diagnostic — surface which path runs and the payload, so we
    // can debug "typed value reverted to original after save".
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.log("[ip-debug saveTbdField]", {
        path: row.tbd_id ? "patch" : "upsert",
        tbd_id: row.tbd_id,
        forecast_id: row.forecast_id,
        sku_style: row.sku_style,
        sku_color: row.sku_color,
        customer_name: row.customer_name,
        fields,
      });
    }
    if (row.tbd_id) {
      await wholesaleRepo.patchTbdRow(row.tbd_id, fields);
    } else {
      // For nullable fields (planned_buy_qty / unit_cost / notes /
      // group_name / sub_category_name) the planner can legitimately
      // pass `null` to clear the value. `??` would treat null as
      // "absent" and fall back to the row's existing value, silently
      // reverting the clear. Use `in` to distinguish "field provided
      // (even null)" from "field not provided".
      const has = <K extends keyof typeof fields>(k: K): boolean => Object.prototype.hasOwnProperty.call(fields, k);
      const { id: newTbdId } = await wholesaleRepo.upsertTbdRow(selectedRun.id, {
        style_code: row.sku_style,
        color: has("color") ? (fields.color ?? "TBD") : (row.sku_color ?? "TBD"),
        is_new_color: has("is_new_color") ? !!fields.is_new_color : (row.is_new_color ?? false),
        customer_id: has("customer_id") ? fields.customer_id! : row.customer_id,
        group_name: has("group_name") ? (fields.group_name ?? null) : (row.group_name ?? null),
        sub_category_name: has("sub_category_name") ? (fields.sub_category_name ?? null) : (row.sub_category_name ?? null),
        period_start: row.period_start,
        period_end: row.period_end,
        period_code: row.period_code,
        buyer_request_qty: has("buyer_request_qty") ? (fields.buyer_request_qty ?? 0) : row.buyer_request_qty,
        override_qty: has("override_qty") ? (fields.override_qty ?? 0) : row.override_qty,
        final_forecast_qty: has("final_forecast_qty") ? (fields.final_forecast_qty ?? 0) : row.final_forecast_qty,
        planned_buy_qty: has("planned_buy_qty") ? (fields.planned_buy_qty ?? null) : (row.planned_buy_qty ?? null),
        unit_cost: has("unit_cost") ? (fields.unit_cost ?? null) : (row.unit_cost ?? null),
        notes: has("notes") ? (fields.notes ?? null) : (row.notes ?? null),
      });
      // Stamp the returned id into local state so the row's
      // forecast_id and tbd_id reflect the persisted record.
      // Future edits hit the simpler patchTbdRow path, and the
      // optimistic state survives whatever the next rebuild
      // returns (the rebuild will produce a row with the same
      // tbd_id, so setRows-replacing won't re-introduce a
      // synthetic).
      const newForecastId = `tbd:${newTbdId}`;
      setRows((prev) => prev.map((r) => r.forecast_id === row.forecast_id
        ? { ...r, tbd_id: newTbdId, forecast_id: newForecastId }
        : r,
      ));
    }
  }

  async function saveBuyQty(forecastId: string, qty: number | null) {
    const run = selectedRun;
    if (!run) return;
    const target = rows.find((r) => r.forecast_id === forecastId) ?? null;
    setRows((prev) => prev.map((r) => {
      if (r.forecast_id !== forecastId) return r;
      const newBuy = qty ?? 0;
      const oldBuy = r.planned_buy_qty ?? 0;
      const delta = newBuy - oldBuy;
      // available_supply already includes the prior buy, so just shift it.
      const newAvail = (r.available_supply_qty ?? 0) + delta;
      const newShortage = Math.max(0, r.final_forecast_qty - newAvail);
      const newExcess = Math.max(0, newAvail - r.final_forecast_qty);
      return {
        ...r,
        planned_buy_qty: qty,
        available_supply_qty: newAvail,
        projected_shortage_qty: newShortage,
        projected_excess_qty: newExcess,
      };
    }));
    try {
      if (target?.is_tbd) {
        await saveTbdField(target, { planned_buy_qty: qty });
      } else {
        await wholesaleRepo.patchForecastBuyQty(forecastId, qty);
      }
      setToast({ text: qty != null ? `Buy qty set to ${qty.toLocaleString()}${target?.is_tbd ? " (TBD stock buy)" : ""}` : "Buy qty cleared", kind: "success" });
      // Fire-and-forget — Short/Excess update a moment later when the
      // rebuild finishes. Guarded by rebuildSeq so a slow rebuild can't
      // overwrite a faster one started later.
      const seq = ++rebuildSeq.current;
      void (async () => {
        try {
          const refreshed = await buildGridRows(run);
          if (seq !== rebuildSeq.current) return;
          setRows(refreshed);
          setSelectedRow((p) => p ? (refreshed.find((r) => r.forecast_id === p.forecast_id) ?? p) : null);
        } catch (e) { console.warn("[ip rebuild]", e); }
      })();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setToast({ text: `Buy qty save failed — ${msg}`, kind: "error" });
      const seq = ++rebuildSeq.current;
      try {
        const refreshed = await buildGridRows(run);
        if (seq !== rebuildSeq.current) return;
        setRows(refreshed);
        setSelectedRow((p) => p ? (refreshed.find((r) => r.forecast_id === p.forecast_id) ?? p) : null);
      } catch (e) { console.warn("[ip rebuild]", e); }
    }
  }

  // Bulk "Shift Buyer −1 month" for (Supply Only) stock-buy rows: every Buyer
  // qty moves to the same style/color's prior-month row (Apr 1,200 → Mar 1,200),
  // so the whole schedule slides one month earlier. The last month empties; the
  // earliest month's qty creates the month before it. planBuyerShiftBackOneMonth
  // computes the minimal set of writes from the CURRENT grid state.
  async function shiftBuyerBack(customerIds: string[]) {
    const run = selectedRun;
    if (!run) return;
    // Rows in scope: TBD stock-buy rows for the selected customers. Empty
    // selection falls back to (Supply Only) by name (legacy behavior).
    const idSet = new Set(customerIds);
    const scopedRows = rows.filter((r) => r.is_tbd && !r.is_aggregate && (
      idSet.size > 0 ? idSet.has(r.customer_id) : r.customer_name === "(Supply Only)"
    ));
    if (scopedRows.length === 0) {
      setToast({ text: "No Buyer quantities to shift for the selected customer(s).", kind: "info" });
      return;
    }
    // Plan PER customer (see planBuyerShiftBackForCustomers) so two customers
    // sharing a style/color don't collide in the (style,color)-keyed planner.
    const ops = planBuyerShiftBackForCustomers(scopedRows);
    if (ops.length === 0) {
      setToast({ text: "Nothing to shift — the selected customer(s) have no Buyer quantities.", kind: "info" });
      return;
    }
    const custNames = Array.from(new Set(scopedRows.map((r) => r.customer_name)));
    const custLabel = custNames.length === 1 ? custNames[0] : `${custNames.length} customers`;
    const landings = ops.filter((o) => o.new_buyer > 0).length;
    const ok = await askConfirm(
      "Shift Buyer back one month?",
      `Moves every Buyer quantity for ${custLabel} to the prior month — e.g. April → March. ${ops.length} row${ops.length === 1 ? "" : "s"} change (${landings} landing month${landings === 1 ? "" : "s"}); the last month empties and the earliest month's qty creates the month before it. Buy, System and Override are unchanged.`,
      "Shift back one month",
    );
    if (!ok) return;
    const ovrByTbd = new Map(scopedRows.filter((r) => r.tbd_id).map((r) => [r.tbd_id!, r.override_qty ?? 0]));
    try {
      // System is always 0 on (Supply Only) TBD rows, so Final = Buyer + Override.
      await Promise.all(ops.map((op) => {
        const ovr = op.existing_tbd_id ? (ovrByTbd.get(op.existing_tbd_id) ?? 0) : 0;
        const final = Math.max(0, op.new_buyer + ovr);
        if (op.existing_tbd_id) {
          return wholesaleRepo.patchTbdRow(op.existing_tbd_id, { buyer_request_qty: op.new_buyer, final_forecast_qty: final });
        }
        return wholesaleRepo.insertTbdRow(run.id, {
          style_code: op.style_code,
          color: op.color,
          is_new_color: !!op.template.is_new_color,
          customer_id: op.template.customer_id,
          group_name: op.template.group_name,
          sub_category_name: op.template.sub_category_name,
          period_start: op.period_start,
          period_end: op.period_end,
          period_code: op.period_code,
          buyer_request_qty: op.new_buyer,
          final_forecast_qty: final,
        });
      }));
      setToast({ text: `Shifted Buyer back one month for ${custLabel} — ${ops.length} row${ops.length === 1 ? "" : "s"} updated.`, kind: "success" });
    } catch (e) {
      setToast({ text: `Shift failed — ${e instanceof Error ? e.message : String(e)}`, kind: "error" });
    }
    // Rebuild after all writes settle so the grid reflects the shifted schedule.
    const seq = ++rebuildSeq.current;
    try {
      const refreshed = await buildGridRows(run);
      if (seq === rebuildSeq.current) setRows(refreshed);
    } catch (e) { console.warn("[ip rebuild]", e); }
  }

  // Inline-edit Buyer request qty. Recomputes final_forecast_qty from
  // (system + buyer + override) clamped at 0, mirrors the compute layer.
  // TBD rows (forecast_id starts with "tbd:") route to the dedicated
  // ip_wholesale_forecast_tbd table instead of ip_wholesale_forecast.
  async function saveBuyerRequest(forecastId: string, qty: number) {
    const run = selectedRun;
    if (!run) return;
    const row = rows.find((r) => r.forecast_id === forecastId);
    if (!row) return;
    const final = Math.max(0, row.system_forecast_qty + qty + row.override_qty);
    setRows((prev) => prev.map((r) => r.forecast_id === forecastId ? { ...r, buyer_request_qty: qty, final_forecast_qty: final } : r));
    try {
      if (row.is_tbd) {
        await saveTbdField(row, { buyer_request_qty: qty, final_forecast_qty: final });
        setToast({ text: `Buyer request set to ${qty.toLocaleString()} (TBD stock buy)`, kind: "success" });
      } else {
        await wholesaleRepo.patchForecastBuyerRequest(forecastId, qty, final);
        setToast({ text: `Buyer request set to ${qty.toLocaleString()}`, kind: "success" });
      }
      const seq = ++rebuildSeq.current;
      void (async () => {
        try {
          const refreshed = await buildGridRows(run);
          if (seq !== rebuildSeq.current) return;
          setRows(refreshed);
          setSelectedRow((p) => p ? (refreshed.find((r) => r.forecast_id === p.forecast_id) ?? p) : null);
        } catch (e) { console.warn("[ip rebuild]", e); }
      })();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setToast({ text: `Buyer request save failed — ${msg}`, kind: "error" });
      const seq = ++rebuildSeq.current;
      try {
        const refreshed = await buildGridRows(run);
        if (seq !== rebuildSeq.current) return;
        setRows(refreshed);
      } catch (e) { console.warn("[ip rebuild]", e); }
    }
  }

  // Inline-edit Override qty. Bypasses the audit-logged applyOverride
  // path (use the drawer when you need a reason code + note).
  async function saveOverrideQty(forecastId: string, qty: number) {
    const run = selectedRun;
    if (!run) return;
    const row = rows.find((r) => r.forecast_id === forecastId);
    if (!row) return;
    const final = Math.max(0, row.system_forecast_qty + row.buyer_request_qty + qty);
    setRows((prev) => prev.map((r) => r.forecast_id === forecastId ? { ...r, override_qty: qty, final_forecast_qty: final } : r));
    try {
      if (row.is_tbd) {
        await saveTbdField(row, { override_qty: qty, final_forecast_qty: final });
        setToast({ text: `Override set to ${qty > 0 ? "+" : ""}${qty.toLocaleString()} (TBD stock buy)`, kind: "success" });
      } else {
        await wholesaleRepo.patchForecastOverride(forecastId, qty, final);
        setToast({ text: `Override set to ${qty > 0 ? "+" : ""}${qty.toLocaleString()}`, kind: "success" });
      }
      const seq = ++rebuildSeq.current;
      void (async () => {
        try {
          const refreshed = await buildGridRows(run);
          if (seq !== rebuildSeq.current) return;
          setRows(refreshed);
          setSelectedRow((p) => p ? (refreshed.find((r) => r.forecast_id === p.forecast_id) ?? p) : null);
        } catch (e) { console.warn("[ip rebuild]", e); }
      })();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setToast({ text: `Override save failed — ${msg}`, kind: "error" });
      const seq = ++rebuildSeq.current;
      try {
        const refreshed = await buildGridRows(run);
        if (seq !== rebuildSeq.current) return;
        setRows(refreshed);
      } catch (e) { console.warn("[ip rebuild]", e); }
    }
  }

  // Save a bucket-level buy for an aggregate row. The grid computes
  // the bucket_key + dimensions; we just upsert (or delete when qty
  // is null/0) and refresh the local map.
  async function saveBucketBuy(args: {
    bucket_key: string;
    qty: number | null;
    collapse_mode: string;
    customer_id: string | null;
    group_name: string | null;
    sub_category_name: string | null;
    gender: string | null;
    period_code: string;
  }) {
    if (!selectedRun) return;
    let userName: string | null = null;
    try {
      const raw = sessionStorage.getItem("plm_user");
      if (raw) userName = JSON.parse(raw)?.name ?? null;
    } catch { /* ignore */ }
    try {
      if (args.qty == null || args.qty === 0) {
        await wholesaleRepo.deleteBucketBuy(selectedRun.id, args.bucket_key);
        setBucketBuys((prev) => {
          const next = new Map(prev);
          next.delete(args.bucket_key);
          return next;
        });
        setToast({ text: "Bucket buy cleared", kind: "success" });
      } else {
        await wholesaleRepo.upsertBucketBuy(selectedRun.id, {
          bucket_key: args.bucket_key,
          qty: args.qty,
          collapse_mode: args.collapse_mode,
          customer_id: args.customer_id,
          group_name: args.group_name,
          sub_category_name: args.sub_category_name,
          gender: args.gender,
          period_code: args.period_code,
          created_by: userName,
        });
        setBucketBuys((prev) => {
          const next = new Map(prev);
          next.set(args.bucket_key, args.qty as number);
          return next;
        });
        setToast({ text: `Bucket buy set to ${args.qty.toLocaleString()}`, kind: "success" });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setToast({ text: `Bucket buy save failed — ${msg}`, kind: "error" });
    }
  }

  // Direct override of the System forecast qty. Pass null to clear
  // (revert to the computed value). Stamps overridden_at + overridden_by
  // so the cell tooltip can show "from X to Y on DATE".
  async function saveSystemOverride(forecastId: string, qty: number | null) {
    const run = selectedRun;
    if (!run) return;
    const row = rows.find((r) => r.forecast_id === forecastId);
    if (!row) return;
    const effectiveSystem = qty ?? row.system_forecast_qty_original;
    const final = Math.max(0, effectiveSystem + row.buyer_request_qty + row.override_qty);
    const nowIso = new Date().toISOString();
    let userName: string | null = null;
    try {
      const raw = sessionStorage.getItem("plm_user");
      if (raw) userName = JSON.parse(raw)?.name ?? null;
    } catch { /* fall through */ }
    setRows((prev) => prev.map((r) =>
      r.forecast_id !== forecastId ? r : {
        ...r,
        system_forecast_qty: effectiveSystem,
        system_forecast_qty_overridden_at: qty != null ? nowIso : null,
        system_forecast_qty_overridden_by: qty != null ? userName : null,
        final_forecast_qty: final,
      }
    ));
    try {
      // TBD rows have synthetic forecast_ids ("tbd:<uuid>") that
      // can't be cast to uuid by PostgREST. The system override is
      // stored on the regular forecast table only — for TBD rows,
      // there's no equivalent column, so we just no-op the network
      // write and let the optimistic update stand. The grid reflects
      // the typed value; rebuild reconciles.
      if (row.is_tbd) {
        setToast({ text: "System override doesn't apply to TBD stock-buy rows.", kind: "error" });
        return;
      }
      await wholesaleRepo.patchForecastSystemOverride(forecastId, qty, final, userName);
      setToast({
        text: qty != null
          ? `System forecast set to ${qty.toLocaleString()} (was ${row.system_forecast_qty_original.toLocaleString()})`
          : "System forecast reset to suggested value",
        kind: "success",
      });
      const seq = ++rebuildSeq.current;
      void (async () => {
        try {
          const refreshed = await buildGridRows(run);
          if (seq !== rebuildSeq.current) return;
          setRows(refreshed);
        } catch (e) { console.warn("[ip rebuild]", e); }
      })();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setToast({ text: `System forecast save failed — ${msg}`, kind: "error" });
      const seq = ++rebuildSeq.current;
      try {
        const refreshed = await buildGridRows(run);
        if (seq !== rebuildSeq.current) return;
        setRows(refreshed);
      } catch (e) { console.warn("[ip rebuild]", e); }
    }
  }

  async function saveUnitCost(forecastId: string, cost: number | null) {
    const run = selectedRun;
    if (!run) return;
    const target = rows.find((r) => r.forecast_id === forecastId) ?? null;
    // Propagate the typed cost to every OTHER non-aggregate row of the same
    // style + color in the run (all periods, all customers). Symmetric: a
    // number fans the value out; a clear-to-null reverts the whole
    // style/color group back to auto-fill. Aggregate edits DON'T reach here
    // (they route through saveUnitCostBucket's own child fan-out), so there's
    // no double-propagation. See collectStyleColorPropagationTargets.
    const prop = target
      ? collectStyleColorPropagationTargets(target, rows)
      : { forecastIds: [], tbdRows: [] };
    const siblingCount = prop.forecastIds.length + prop.tbdRows.length;
    const affected = new Set<string>([
      forecastId,
      ...prop.forecastIds,
      ...prop.tbdRows.map((t) => t.forecast_id),
    ]);
    setRows((prev) => prev.map((r) => {
      if (!affected.has(r.forecast_id)) return r;
      const effective = cost ?? r.avg_cost ?? r.ats_avg_cost ?? r.item_cost ?? null;
      return { ...r, unit_cost_override: cost, unit_cost: effective };
    }));
    try {
      // TBD rows live in ip_wholesale_forecast_tbd, not the regular
      // forecast table. Their forecast_id has a "tbd:" prefix that
      // PostgREST can't cast to uuid for the regular forecast PATCH;
      // route through saveTbdField (patchTbdRow under the hood) so
      // the PATCH hits the right table with the right id.
      if (target?.is_tbd) {
        await saveTbdField(target, { unit_cost: cost });
      } else {
        await wholesaleRepo.patchForecastUnitCostOverride(forecastId, cost);
      }
      // Fan the same cost onto the style/color siblings, reusing the bucket
      // handler's write pattern: forecast PATCHes in bounded parallel chunks,
      // TBD upserts sequential (each may mutate rows state / stamp a tbd_id).
      const CHUNK = 25;
      for (let i = 0; i < prop.forecastIds.length; i += CHUNK) {
        const chunk = prop.forecastIds.slice(i, i + CHUNK);
        await Promise.all(chunk.map((id) => wholesaleRepo.patchForecastUnitCostOverride(id, cost)));
      }
      for (const t of prop.tbdRows) {
        await saveTbdField(t, { unit_cost: cost });
      }
      if (siblingCount > 0) {
        // total = the edited row + every sibling now carrying this cost.
        const total = siblingCount + 1;
        const styleLabel = (target?.sku_style ?? "").trim();
        const colorLabel = (target?.sku_color ?? "").trim();
        const scope = `${total} ${styleLabel} / ${colorLabel} row${total === 1 ? "" : "s"}`;
        setToast({
          text: cost != null
            ? `Unit cost $${cost.toFixed(2)} applied to ${scope}`
            : `Unit cost cleared on ${scope} — reverted to auto-fill`,
          kind: "success",
        });
      } else {
        setToast({
          text: cost != null ? `Unit cost set to $${cost.toFixed(2)}${target?.is_tbd ? " (TBD stock buy)" : ""}` : "Unit cost reset to auto-fill",
          kind: "success",
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setToast({ text: `Unit cost save failed — ${msg}`, kind: "error" });
      const seq = ++rebuildSeq.current;
      try {
        const refreshed = await buildGridRows(run);
        if (seq !== rebuildSeq.current) return;
        setRows(refreshed);
        setSelectedRow((p) => p ? (refreshed.find((r) => r.forecast_id === p.forecast_id) ?? p) : null);
      } catch (e) { console.warn("[ip rebuild]", e); }
    }
  }

  // Fan a Unit Cost typed into a collapsed/aggregate row out to EVERY
  // child of the bucket. Real forecast children get an
  // unit_cost_override PATCH; TBD stock-buy children route through the
  // TBD path (saveTbdField) exactly as saveUnitCost distinguishes.
  // Passing null clears the override on every child → each reverts to
  // its own auto-fill on the next rebuild. Falls back to the single-row
  // path when the row isn't actually an aggregate.
  async function saveUnitCostBucket(row: IpPlanningGridRow, cost: number | null) {
    const run = selectedRun;
    if (!run) return;
    const byId = new Map(rows.map((r) => [r.forecast_id, r] as const));
    const targets = collectUnitCostBucketTargets(row, byId);
    if (!targets) {
      // Not an aggregate (or no underlying ids) — single-row behavior.
      await saveUnitCost(row.forecast_id, cost);
      return;
    }
    const { forecastIds, tbdRows } = targets;
    const affected = new Set<string>([...forecastIds, ...tbdRows.map((t) => t.forecast_id)]);
    if (affected.size === 0) return;
    // Optimistic: stamp every affected child (and, via re-aggregation on
    // render, the displayed aggregate unit_cost) before the writes land.
    setRows((prev) => prev.map((r) => {
      if (!affected.has(r.forecast_id)) return r;
      const effective = cost ?? r.avg_cost ?? r.ats_avg_cost ?? r.item_cost ?? null;
      return { ...r, unit_cost_override: cost, unit_cost: effective };
    }));
    try {
      // Batch the forecast writes in bounded chunks so a wide bucket
      // doesn't fire hundreds of requests at once (mirrors the buy-plan
      // fan-out). patchForecastUnitCostOverride already wraps each PATCH
      // in withRetryOn57014.
      const CHUNK = 25;
      for (let i = 0; i < forecastIds.length; i += CHUNK) {
        const chunk = forecastIds.slice(i, i + CHUNK);
        await Promise.all(chunk.map((id) => wholesaleRepo.patchForecastUnitCostOverride(id, cost)));
      }
      // TBD writes are sequential — saveTbdField may upsert and mutate
      // rows state (stamping a new tbd_id), which must settle in order.
      for (const t of tbdRows) {
        await saveTbdField(t, { unit_cost: cost });
      }
      const n = affected.size;
      setToast({
        text: cost != null
          ? `$${cost.toFixed(2)} applied to ${n} SKU${n === 1 ? "" : "s"}`
          : `Unit cost reset to auto-fill on ${n} SKU${n === 1 ? "" : "s"}`,
        kind: "success",
      });
      const seq = ++rebuildSeq.current;
      void (async () => {
        try {
          const refreshed = await buildGridRows(run);
          if (seq !== rebuildSeq.current) return;
          setRows(refreshed);
        } catch (e) { console.warn("[ip rebuild]", e); }
      })();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setToast({ text: `Unit cost save failed — ${msg}`, kind: "error" });
      const seq = ++rebuildSeq.current;
      try {
        const refreshed = await buildGridRows(run);
        if (seq !== rebuildSeq.current) return;
        setRows(refreshed);
      } catch (e) { console.warn("[ip rebuild]", e); }
    }
  }

  async function saveOverride(args: { override_qty: number; reason_code: IpOverrideReasonCode; note: string | null }) {
    if (!selectedRow) return;
    const run = selectedRun;
    if (!run) return;
    // TBD rows can't go through fetchForecast (their forecast_id is
    // a synthetic "tbd:<uuid>" that PostgREST won't cast to uuid).
    // Skip the audited applyOverride path and patch the TBD row's
    // override_qty + final_forecast_qty directly.
    if (selectedRow.is_tbd) {
      const final = Math.max(0, selectedRow.system_forecast_qty + selectedRow.buyer_request_qty + args.override_qty);
      try {
        await saveTbdField(selectedRow, { override_qty: args.override_qty, final_forecast_qty: final });
        setToast({ text: "Override saved (TBD stock buy — no audit log)", kind: "success" });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setToast({ text: `Override save failed — ${msg}`, kind: "error" });
        throw e;
      }
      const seq = ++rebuildSeq.current;
      const refreshed = await buildGridRows(run);
      if (seq !== rebuildSeq.current) return;
      setRows(refreshed);
      setSelectedRow(refreshed.find((r) => r.forecast_id === selectedRow.forecast_id) ?? null);
      return;
    }
    // Find the underlying forecast row (grid row carries the id).
    const forecast = await fetchForecast(selectedRow.forecast_id);
    if (!forecast) throw new Error("Forecast row not found — was it deleted?");
    await applyOverride({
      forecast,
      override_qty: args.override_qty,
      reason_code: args.reason_code,
      note: args.note,
      created_by: null,
    });
    await loadRunData();
    // Refresh the drawer's row object from the rebuilt rows.
    const refreshed = await buildGridRows(run);
    const row = refreshed.find((r) => r.forecast_id === selectedRow.forecast_id) ?? null;
    setSelectedRow(row);
    setToast({ text: "Override saved", kind: "success" });
  }

  return (
    <div style={S.app}>
      <div style={S.content}>
        {bootstrapPhase !== "ready" ? (
          <BootstrapStatusBar phase={bootstrapPhase} onCancel={() => setBootstrapPhase("ready")} />
        ) : (
        <>
        <SystemHealthBanner />
        {/* Xoro sales-history ingestion controls — only relevant on the
            planning grid. The Future Demand Requests tab has its own
            sales-history readout (per Cat / Sub Cat / Style) so this
            ingestion bar stays hidden there to remove the visual noise. */}
        {tab === "grid" && (
        <div style={{ ...S.card, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", position: "relative" }}>
          <CollapseChevron
            collapsed={salesHistCollapsed}
            onToggle={() => {
              const next = !salesHistCollapsed;
              setSalesHistCollapsed(next);
              saveCollapsedFlag(STORAGE_KEYS.collapseSales, next);
            }}
            label="Sales history"
          />
          <strong style={{ color: PAL.text, fontSize: 13 }}>Sales history:</strong>
          {!salesHistCollapsed && (<>
          <AppDatePicker value={ingestFrom} onCommit={setIngestFrom} style={{ ...S.input, width: 140 }} />
          <span style={{ color: PAL.textDim, fontSize: 12 }}>to</span>
          <AppDatePicker value={ingestTo} onCommit={setIngestTo} style={{ ...S.input, width: 140 }} />
          {!autoWalking ? (
            <button style={S.btnSecondary} onClick={autoWalkSales} disabled={ingesting} title="Bootstrap / history extension only. Walks every invoice page from page 1 — use this to pull history older than the nightly 'Last Calendar Year to Date' window (~17 months). Routine daily updates are covered by the nightly pipeline.">
              {runningKind === "autowalk" ? "Working…" : "▶ Fetch all Xoro sales"}
            </button>
          ) : (
            <button style={{ ...S.btnSecondary, color: PAL.red, borderColor: PAL.red }} onClick={() => { autoWalkAbort.current = true; }}>
              ■ Stop fetch
            </button>
          )}
          {/* Retired buttons (intentionally hidden — nightly pipeline covers both):
              - "↻ Sync newest sales" — post_invoice_detail.py incrementally upserts
                ip_sales_history_wholesale every night ("Last Calendar Year to Date")
              - "+ Add new items (Xoro)" — post_master_data.py does a full upsert of
                CurrentProducts into ip_item_master every night (new items included)
              - "Upload item master (Excel)" + "Upload sales (Excel)" — retired
                earlier for the same reason. Manual Excel uploads bypassed the
                canonical tables and risked overwriting fresh nightly data with
                a stale spreadsheet.
              The underlying services (syncNewestSalesViaServer, syncMissingItems,
              ingestSalesExcel, ingestItemMasterExcel) remain wired up for
              emergency dev-console re-runs; only the buttons are hidden. */}
          <button style={S.btnSecondary} onClick={() => void runSupplySync("ats")} disabled={ingesting || autoWalking} title="Mid-day refresh: pulls on-hand / on-SO from the ATS app's persisted Excel snapshot into ip_inventory_snapshot. Nightly post_planning_supply.py already runs this at 21:00.">
            {runningKind === "ats" ? "Working…" : "Sync on-hand (ATS)"}
          </button>
          <button style={S.btnSecondary} onClick={() => void runSupplySync("tanda")} disabled={ingesting || autoWalking} title="Mid-day refresh: pulls open POs from the PO WIP app's tanda_pos table into ip_open_purchase_orders. Nightly post_purchase_orders.py already runs this at 21:00.">
            {runningKind === "tanda" ? "Working…" : "Sync open POs (TandA)"}
          </button>
          <span style={{ color: PAL.textMuted, fontSize: 12, flexBasis: "100%" }}>
            Item master columns: SKU (or Style+Color), Description, Style, Color, AvgCost. Sales columns: SKU, Customer, Date, Qty (UnitPrice/InvoiceNumber optional). Rebuild forecast after upload.
          </span>
          </>)}
        </div>
        )}

        <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
          <TabButton active={tab === "grid"} onClick={() => setTab("grid")}>Planning grid</TabButton>
          <TabButton active={tab === "requests"} onClick={() => setTab("requests")}>
            Future demand requests ({requests.length})
          </TabButton>
        </div>

        {tab === "grid" && (
          <>
            <div style={{ position: "relative" }}>
              <CollapseChevron
                collapsed={monthlyTotalsCollapsed}
                onToggle={() => {
                  const next = !monthlyTotalsCollapsed;
                  setMonthlyTotalsCollapsed(next);
                  saveCollapsedFlag(STORAGE_KEYS.collapseTotals, next);
                }}
                label="Monthly totals"
              />
              {!monthlyTotalsCollapsed && (
                <MonthlyTotalsCards rows={scopedRows} systemSuggestionsOn={systemSuggestionsOn} />
              )}
              {monthlyTotalsCollapsed && (
                <div style={{ ...S.card, padding: "10px 14px", color: PAL.textMuted, fontSize: 12, marginBottom: 12 }}>
                  Total Buy + Final Forecast hidden — click ▾ to expand.
                </div>
              )}
            </div>
            <WholesalePlanningGrid
              runHorizon={selectedRun?.horizon_start && selectedRun?.horizon_end
                ? { start: selectedRun.horizon_start, end: selectedRun.horizon_end }
                : null}
              headerSlot={
                <>
                  {/* Build card sits directly above the search/filter
                      toolbar so the planner sees Build adjacent to
                      whatever filters they've set. The grid's onFiltersChange
                      callback feeds buildFilter so the Build button
                      relabels itself "Build (filtered)" when scoped. */}
                  <PlanningRunControls
                    runs={runs}
                    selectedRunId={selectedRunId}
                    onSelect={(id) => setSelectedRunId(id)}
                    onChange={refreshAll}
                    onToast={(t) => setToast(t)}
                    scope="wholesale"
                    buildFilter={buildFilter}
                  />
                  {selectedRun && (
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                      <span style={{ fontSize: 12, color: PAL.textDim, fontWeight: 600 }}>Forecast method</span>
                      {(Object.keys(FORECAST_METHOD_LABELS) as IpForecastMethodPreference[]).map((pref) => {
                        const active = selectedRun.forecast_method_preference === pref;
                        return (
                          <button
                            key={pref}
                            onClick={() => void handleMethodChange(pref)}
                            style={{
                              background: active ? PAL.accent : "transparent",
                              color: active ? "#fff" : PAL.textDim,
                              border: `1px solid ${active ? PAL.accent : PAL.border}`,
                              borderRadius: 6,
                              padding: "4px 10px",
                              fontSize: 12,
                              fontWeight: 600,
                              cursor: "pointer",
                            }}
                          >
                            {FORECAST_METHOD_LABELS[pref]}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </>
              }
              rows={rows}
              loading={loading}
              onSelectRow={setSelectedRow}
              onUpdateBuyQty={saveBuyQty}
              onUpdateBucketBuy={saveBucketBuy}
              onUpdateUnitCost={saveUnitCost}
              onUpdateUnitCostBucket={saveUnitCostBucket}
              onUpdateBuyerRequest={saveBuyerRequest}
              onShiftBuyerBack={shiftBuyerBack}
              onUpdateOverride={saveOverrideQty}
              onUpdateSystemOverride={saveSystemOverride}
              onUpdateTbdColor={saveTbdColor}
              onUpdateTbdStyle={saveTbdStyle}
              onUpdateTbdCustomer={saveTbdCustomer}
              onAddTbdNewCustomer={saveTbdNewCustomer}
              newCustomerIds={newCustomerIds}
              onUpdateTbdDescription={saveTbdDescription}
              onAddTbdRow={addTbdRow}
              onDeleteTbdRow={deleteTbdRow}
              onPromoteTbdRow={promoteTbdStyleColor}
              promotedTbdKeys={promotedTbdKeys}
              onUndoLastAdd={undoLastAddedTbd}
              undoDepth={addUndoStack.length}
              lastAddedTbdMarker={addUndoStack.length > 0 ? {
                style_code: addUndoStack[addUndoStack.length - 1].style_code,
                color: addUndoStack[addUndoStack.length - 1].color,
                customer_id: addUndoStack[addUndoStack.length - 1].customer_ids[0],
                period_code: addUndoStack[addUndoStack.length - 1].period_codes[0],
              } : undefined}
              focusBatch={focusBatch}
              masterColorsLower={masterColorsLower}
              masterColorsByStyleLower={masterColorsByStyleLower}
              masterStyles={masterStyles}
              ppkUnitsByStyle={ppkUnitsByStyle}
              masterCustomers={customers}
              onFiltersChange={setBuildFilter}
              bucketBuys={bucketBuys}
              systemSuggestionsOn={systemSuggestionsOn}
              onSystemSuggestionsChange={setSystemSuggestionsOnPersistent}
              onScopeChange={setScopedRows}
            />
          </>
        )}

        {tab === "requests" && (
          <FutureDemandRequestsPanel
            customers={customers}
            categories={categories}
            items={items}
            requests={requests}
            onChange={refreshAll}
            onToast={(t) => setToast(t)}
          />
        )}
        {/* Inline detail panel — used to be a side drawer overlay.
            Now flows below the grid so the planner keeps page
            context visible. Same component; the drawer styles
            were redefined as inline-card styles centrally. */}
        {selectedRow && (
          <ForecastDetailDrawer
            row={selectedRow}
            overrides={overridesForRow}
            onClose={() => setSelectedRow(null)}
            onSaveOverride={saveOverride}
            onUpdateBuyQty={saveBuyQty}
          />
        )}
        </>
        )}
      </div>


      <Toast toast={toast} onDismiss={() => setToast(null)} />

      {/* Upload summary — required-dismiss modal shown after every
          Excel upload completes. Replaces the previous auto-fading
          status bar so the planner can read the counts before
          moving on. Only the X / Close button dismisses; the
          backdrop click is intentionally a no-op so the planner
          can't accidentally lose the summary. */}
      {uploadSummary && (() => {
        const u = uploadSummary;
        const skipped = u.skipped_no_sku + u.skipped_no_date + u.skipped_zero_qty + u.skipped_bad_cost + u.skipped_duplicate + u.skipped_variant_duplicate;
        const hasIssues = u.failedMessage || u.errors.length > 0 || u.warnings.length > 0;
        const accent = u.failedMessage ? PAL.red : (hasIssues ? PAL.yellow : PAL.green);
        return (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 600, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div style={{
              background: PAL.panel,
              border: `1px solid ${accent}`,
              borderRadius: 10,
              padding: 22,
              width: "min(640px, 95vw)",
              maxHeight: "90vh",
              overflowY: "auto",
              boxSizing: "border-box",
              color: PAL.text,
              boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                <div>
                  <div style={{ fontSize: 11, color: PAL.textMuted, textTransform: "uppercase", letterSpacing: 1 }}>
                    {u.kind === "sales" ? "Sales upload" : "Item master upload"}
                  </div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: accent, marginTop: 2 }}>
                    {u.failedMessage ? "Upload failed" : (u.inserted > 0 ? "Upload complete" : "Upload finished — nothing saved")}
                  </div>
                  <div style={{ fontSize: 12, color: PAL.textDim, marginTop: 4, fontFamily: "monospace" }}>{u.fileName}</div>
                </div>
                <button style={S.btnGhost} onClick={() => setUploadSummary(null)} title="Close">✕</button>
              </div>

              {u.failedMessage ? (
                <div style={{ ...S.infoCell, padding: "10px 12px", background: PAL.red + "11", border: `1px solid ${PAL.red}55`, color: PAL.red, fontSize: 12 }}>
                  {u.failedMessage}
                </div>
              ) : (
                <>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 8, marginBottom: 12 }}>
                    <div style={S.infoCell}>
                      <div style={S.infoLabel}>Rows read</div>
                      <div style={{ ...S.infoValue, fontFamily: "monospace" }}>{u.parsed.toLocaleString()}</div>
                    </div>
                    <div style={S.infoCell}>
                      <div style={S.infoLabel}>Style+Color rows saved</div>
                      <div style={{ ...S.infoValue, fontFamily: "monospace", color: u.inserted > 0 ? PAL.green : PAL.textMuted }}>{u.inserted.toLocaleString()}</div>
                    </div>
                    {u.kind === "master" && (
                      <div style={S.infoCell} title="Full SKU rows (with size) — invisible to the planning grid; used by the future PO builder to assemble Xoro line items.">
                        <div style={S.infoLabel}>Variant rows saved (with size)</div>
                        <div style={{ ...S.infoValue, fontFamily: "monospace", color: u.inserted_variants > 0 ? PAL.green : PAL.textMuted }}>{u.inserted_variants.toLocaleString()}</div>
                      </div>
                    )}
                    <div style={S.infoCell}>
                      <div style={S.infoLabel}>Skipped</div>
                      <div style={{ ...S.infoValue, fontFamily: "monospace", color: skipped > 0 ? PAL.yellow : PAL.textMuted }}>{skipped.toLocaleString()}</div>
                    </div>
                  </div>

                  {skipped > 0 && (
                    <div style={{ ...S.infoCell, padding: "10px 12px", marginBottom: 10 }}>
                      <div style={S.infoLabel}>Skip breakdown</div>
                      <div style={{ fontSize: 12, color: PAL.textDim, lineHeight: 1.6 }}>
                        {u.skipped_no_sku > 0 && <div>· <strong>{u.skipped_no_sku.toLocaleString()}</strong> rows missing SKU</div>}
                        {u.skipped_no_date > 0 && <div>· <strong>{u.skipped_no_date.toLocaleString()}</strong> rows missing date</div>}
                        {u.skipped_zero_qty > 0 && <div>· <strong>{u.skipped_zero_qty.toLocaleString()}</strong> rows with zero quantity</div>}
                        {u.skipped_bad_cost > 0 && <div>· <strong>{u.skipped_bad_cost.toLocaleString()}</strong> rows with unparseable cost</div>}
                        {u.skipped_duplicate > 0 && (
                          <div>· <strong>{u.skipped_duplicate.toLocaleString()}</strong> duplicate {u.kind === "master"
                            ? `(style, color) pairs — Excel had multiple sizes per (style, color), collapsed to one rolled-up row each. Size data preserved separately as ${u.inserted_variants.toLocaleString()} variant rows above (used by future PO builder).`
                            : "lines (same invoice + style+color + date — qty summed, prices weight-averaged)"}</div>
                        )}
                        {u.skipped_variant_duplicate > 0 && u.kind === "master" && (
                          <div>· <strong>{u.skipped_variant_duplicate.toLocaleString()}</strong> duplicate (style, color, size) variants — same physical SKU appeared more than once in the spreadsheet. First occurrence kept; the rest collapsed.</div>
                        )}
                        {/* Full raw-row dump of every (style, color, size)
                            collision so the planner can verify whether the
                            "duplicates" are actually identical or whether
                            our dedup key is missing a distinguishing column.
                            TSV format pastes directly into Excel. */}
                        {u.duplicate_variant_groups.length > 0 && u.kind === "master" && (() => {
                          const groups = u.duplicate_variant_groups;
                          const totalRows = groups.reduce((s, g) => s + g.rows.length, 0);
                          // Union of every column header across all colliding
                          // rows. Using a stable order: append in first-seen
                          // order so columns near the front of the spreadsheet
                          // stay near the front of the TSV.
                          const colSet = new Set<string>();
                          for (const g of groups) {
                            for (const row of g.rows) {
                              for (const k of Object.keys(row)) colSet.add(k);
                            }
                          }
                          const cols = Array.from(colSet);
                          const tsvHeader = ["variant_key", ...cols].join("\t");
                          const cellToTsv = (v: unknown): string => {
                            if (v == null) return "";
                            if (v instanceof Date) return v.toISOString();
                            const s = typeof v === "string" ? v : JSON.stringify(v);
                            // Strip tabs/newlines so the row stays on one line.
                            return s.replace(/\t/g, " ").replace(/\r?\n/g, " ");
                          };
                          const tsvBody = groups.flatMap((g) =>
                            g.rows.map((row) => [g.variant_key, ...cols.map((c) => cellToTsv(row[c]))].join("\t"))
                          );
                          const tsv = [tsvHeader, ...tsvBody].join("\n");
                          return (
                            <details style={{ marginTop: 6 }}>
                              <summary style={{ cursor: "pointer", fontSize: 12, color: PAL.textDim, fontWeight: 600 }}>
                                ▸ View {groups.length.toLocaleString()} duplicate group{groups.length === 1 ? "" : "s"} ({totalRows.toLocaleString()} row{totalRows === 1 ? "" : "s"} total) as TSV
                              </summary>
                              <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
                                <div style={{ fontSize: 11, color: PAL.textMuted }}>
                                  Paste into Excel to see every column side-by-side. If two rows look identical, your Excel may have a hidden column (warehouse, price tier, etc.) that's missing here — let me know and we'll add it to the dedup key.
                                </div>
                                <button
                                  type="button"
                                  style={{ ...S.btnSecondary, alignSelf: "flex-start", fontSize: 11, padding: "4px 10px" }}
                                  onClick={async () => {
                                    try {
                                      await navigator.clipboard.writeText(tsv);
                                      setToast({ text: `Copied ${totalRows.toLocaleString()} rows (TSV) to clipboard`, kind: "success" });
                                    } catch {
                                      setToast({ text: "Couldn't copy — your browser blocked clipboard access", kind: "error" });
                                    }
                                  }}
                                >
                                  Copy as TSV (paste into Excel)
                                </button>
                                <textarea
                                  readOnly
                                  value={tsv}
                                  onFocus={(e) => e.currentTarget.select()}
                                  style={{
                                    ...S.input,
                                    width: "100%",
                                    maxHeight: 240,
                                    minHeight: 100,
                                    fontFamily: "monospace",
                                    fontSize: 11,
                                    resize: "vertical" as const,
                                    background: PAL.bg,
                                    whiteSpace: "pre" as const,
                                  }}
                                />
                              </div>
                            </details>
                          );
                        })()}
                      </div>
                    </div>
                  )}

                  {u.warnings.length > 0 && (
                    <div style={{ ...S.infoCell, padding: "10px 12px", marginBottom: 10, background: PAL.yellow + "11", border: `1px solid ${PAL.yellow}44` }}>
                      <div style={{ ...S.infoLabel, color: PAL.yellow }}>Data-quality warnings ({u.warnings.length})</div>
                      <div style={{ fontSize: 12, color: PAL.textDim, marginTop: 4 }}>
                        {u.warnings.slice(0, 5).map((w, i) => <div key={i}>· {w}</div>)}
                        {u.warnings.length > 5 && <div style={{ color: PAL.textMuted }}>+ {u.warnings.length - 5} more in console</div>}
                      </div>
                      {/* Full SKU list of variant rows missing Size,
                          with copy-to-clipboard so the planner can fix
                          the source spreadsheet without re-deriving the
                          list from console. */}
                      {u.no_size_skus.length > 0 && (
                        <details style={{ marginTop: 8 }}>
                          <summary style={{ cursor: "pointer", fontSize: 12, color: PAL.yellow, fontWeight: 600 }}>
                            ▸ View {u.no_size_skus.length.toLocaleString()} SKU{u.no_size_skus.length === 1 ? "" : "s"} missing Size
                          </summary>
                          <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
                            <button
                              type="button"
                              style={{ ...S.btnSecondary, alignSelf: "flex-start", fontSize: 11, padding: "4px 10px" }}
                              onClick={async () => {
                                try {
                                  await navigator.clipboard.writeText(u.no_size_skus.join("\n"));
                                  setToast({ text: `Copied ${u.no_size_skus.length.toLocaleString()} SKUs to clipboard`, kind: "success" });
                                } catch {
                                  setToast({ text: "Couldn't copy — your browser blocked clipboard access", kind: "error" });
                                }
                              }}
                            >
                              Copy all to clipboard
                            </button>
                            <textarea
                              readOnly
                              value={u.no_size_skus.join("\n")}
                              onFocus={(e) => e.currentTarget.select()}
                              style={{
                                ...S.input,
                                width: "100%",
                                maxHeight: 180,
                                minHeight: 80,
                                fontFamily: "monospace",
                                fontSize: 11,
                                resize: "vertical" as const,
                                background: PAL.bg,
                              }}
                            />
                          </div>
                        </details>
                      )}
                    </div>
                  )}

                  {u.errors.length > 0 && (
                    <div style={{ ...S.infoCell, padding: "10px 12px", marginBottom: 10, background: PAL.red + "11", border: `1px solid ${PAL.red}44` }}>
                      <div style={{ ...S.infoLabel, color: PAL.red }}>Errors on {u.errors.length} row{u.errors.length === 1 ? "" : "s"}</div>
                      <div style={{ fontSize: 12, color: PAL.textDim, marginTop: 4, fontFamily: "monospace" }}>
                        {u.errors.slice(0, 5).map((e, i) => <div key={i}>· {e}</div>)}
                        {u.errors.length > 5 && <div style={{ color: PAL.textMuted, fontFamily: "inherit" }}>+ {u.errors.length - 5} more in console</div>}
                      </div>
                    </div>
                  )}
                </>
              )}

              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
                <button style={S.btnPrimary} onClick={() => setUploadSummary(null)}>Close</button>
              </div>
            </div>
          </div>
        );
      })()}

      {pendingConfirm && (
        <div
          onClick={pendingConfirm.onCancel}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)",
            zIndex: 500, display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: PAL.panel, color: PAL.text,
              border: `1px solid ${PAL.yellow}`, borderRadius: 12,
              padding: 20, width: "min(480px, 90vw)",
              boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              <span style={{
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                width: 24, height: 24, borderRadius: 12,
                background: PAL.yellow, color: "#000", fontWeight: 800, fontSize: 14,
              }}>!</span>
              <div style={{ fontSize: 15, fontWeight: 700 }}>{pendingConfirm.title}</div>
            </div>
            <div style={{ fontSize: 13, color: PAL.textDim, lineHeight: 1.5, whiteSpace: "pre-wrap", marginBottom: 16 }}>
              {pendingConfirm.body}
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" style={{ ...S.btnSecondary }} onClick={pendingConfirm.onCancel}>Cancel</button>
              <button
                type="button"
                style={{ ...S.btnPrimary, background: PAL.yellow, color: "#000", border: `1px solid ${PAL.yellow}` }}
                onClick={pendingConfirm.onConfirm}
              >{pendingConfirm.confirmLabel}</button>
            </div>
          </div>
        </div>
      )}
      {opStatus && (
        <OperationStatusBar
          label={opStatus.label}
          message={opStatus.message}
          canCancel={opStatus.canCancel}
          onCancel={() => {
            opStatus.onCancel?.();
            opDismissedRef.current = true;
            setOpStatus(null);
          }}
        />
      )}
    </div>
  );
}

