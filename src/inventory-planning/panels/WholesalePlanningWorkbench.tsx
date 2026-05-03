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
import { applyOverride, buildGridRows } from "../services/wholesaleForecastService";
import { ingestXoroSales, syncAtsSupply, syncMissingItems, syncTandaPos } from "../services/xoroSalesIngestService";
import { ingestSalesExcel, ingestItemMasterExcel, type ExcelIngestResult } from "../services/excelIngestService";
import { S, PAL, formatPeriodCode } from "../components/styles";
import { SB_HEADERS, SB_URL } from "../../utils/supabase";
import PlanningRunControls from "./PlanningRunControls";
import WholesalePlanningGrid from "./WholesalePlanningGrid";
import FutureDemandRequestsPanel from "./FutureDemandRequestsPanel";
import ForecastDetailDrawer from "../components/ForecastDetailDrawer";
import Toast, { type ToastMessage } from "../components/Toast";
import StaleDataBanner from "../shared/components/StaleDataBanner";

async function fetchForecast(id: string): Promise<IpWholesaleForecast | null> {
  if (!SB_URL) return null;
  const r = await fetch(`${SB_URL}/rest/v1/ip_wholesale_forecast?id=eq.${id}&select=*`, { headers: SB_HEADERS });
  if (!r.ok) return null;
  const rows = (await r.json()) as IpWholesaleForecast[];
  return rows[0] ?? null;
}

type TabKey = "grid" | "requests";

export default function WholesalePlanningWorkbench() {
  const [runs, setRuns] = useState<IpPlanningRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
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
  // Distinct (style_code, group_name, sub_category_name) tuples from
  // the master. Drives the TBD style picker's category-wide list.
  const [masterStyles, setMasterStyles] = useState<Array<{ style_code: string; group_name: string | null; sub_category_name: string | null }>>([]);
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
    style_code: string | null;
    group_name: string | null;
    sub_category_name: string | null;
    gender: string | null;
    period_code: string | null;
    recommended_action: string | null;
    confidence_level: string | null;
    forecast_method: string | null;
  } | null>(null);

  // Lifted from the grid so MonthlyTotalsCards and the grid use the
  // same toggle. Without this lift, the top FINAL FORECAST card showed
  // raw final_forecast_qty while the grid's Σ Final reflected the
  // muted value — creating a visible discrepancy.
  const [systemSuggestionsOn, setSystemSuggestionsOn] = useState<boolean>(() => {
    try { return localStorage.getItem("ws_planning_system_suggestions_off") !== "1"; }
    catch { return true; }
  });
  function setSystemSuggestionsOnPersistent(v: boolean) {
    try {
      if (v) localStorage.removeItem("ws_planning_system_suggestions_off");
      else localStorage.setItem("ws_planning_system_suggestions_off", "1");
    } catch { /* ignore quota */ }
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
    const [cs, cats, its, reqs, rs, mcl, mst] = await Promise.all([
      wholesaleRepo.listCustomers(),
      wholesaleRepo.listCategories(),
      wholesaleRepo.listItems(),
      wholesaleRepo.listOpenRequests(),
      wholesaleRepo.listPlanningRuns("wholesale"),
      wholesaleRepo.listMasterColorsLower(),
      wholesaleRepo.listMasterStyles(),
    ]);
    setCustomers(cs);
    setCategories(cats);
    setItems(its);
    setRequests(reqs);
    setMasterColorsLower(mcl);
    setMasterStyles(mst);
    setRuns(rs);
    if (!selectedRunId) {
      const active = rs.find((r) => r.status === "active") ?? rs[0] ?? null;
      if (active) setSelectedRunId(active.id);
    }
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
      .then(() => {
        // Move to run-data so the status bar reflects what's happening
        // next. The [selectedRun] effect picks up loadRunData below.
        setBootstrapPhase((prev) => (prev === "masters" ? "run-data" : prev));
      })
      .catch((e) => {
        setToast({ text: "Load failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
        setBootstrapPhase("ready");
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
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
      const skipParts = [];
      if (r.skipped_no_sku) skipParts.push(`${r.skipped_no_sku} missing SKU`);
      if (r.skipped_no_date) skipParts.push(`${r.skipped_no_date} missing date`);
      if (r.skipped_zero_qty) skipParts.push(`${r.skipped_zero_qty} zero quantity`);
      if (r.skipped_bad_cost) skipParts.push(`${r.skipped_bad_cost} bad cost`);
      const skipSummary = skipParts.length > 0 ? ` · skipped ${skipParts.join(", ")}` : "";
      const errSummary = r.errors.length > 0 ? ` · ${r.errors.length} had problems` : "";
      const warnSummary = r.warnings && r.warnings.length > 0 ? ` · ${r.warnings.length} data-quality warning(s)` : "";
      if (r.errors.length > 0) console.error(`[excel-${kind}] errors:`, r.errors);
      if (r.warnings && r.warnings.length > 0) console.warn(`[excel-${kind}] warnings:`, r.warnings);
      reportOp(`Done — read ${r.parsed.toLocaleString()} rows, saved ${r.inserted.toLocaleString()}${skipSummary}${errSummary}${warnSummary}`);
      // Surface the first warning verbatim so the planner sees the
      // most actionable detail (sample SKUs) without opening DevTools.
      if (r.warnings && r.warnings.length > 0) {
        await new Promise<void>((res) => setTimeout(res, 1500));
        reportOp(`⚠ ${r.warnings[0]}${r.warnings.length > 1 ? ` (+${r.warnings.length - 1} more in console)` : ""}`);
      }
      await new Promise<void>((res) => setTimeout(res, 1800));
      if (r.inserted > 0 && kind === "sales") await loadRunData();
      if (r.inserted > 0 && kind === "master" && selectedRun) {
        const refreshed = await buildGridRows(selectedRun);
        setRows(refreshed);
      }
    } catch (e) {
      console.error(`[excel-${kind}] failed`, e);
      reportOp(`Couldn't finish — ${e instanceof Error ? e.message : String(e)}`);
      await new Promise<void>((res) => setTimeout(res, 2500));
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
  // Add a fresh (Supply Only) TBD stock-buy row from the inline +Add
  // form. Style + color default to "TBD"; the planner picks
  // category, sub-cat, customer, and period in the form. The new row
  // is upserted directly to ip_wholesale_forecast_tbd; on success we
  // rebuild the grid so the row appears.
  async function addTbdRow(args: {
    style_code: string;
    color: string;
    is_new_color: boolean;
    customer_id: string;
    group_name: string | null;
    sub_category_name: string | null;
    period_code: string;
  }) {
    if (!selectedRun) return;
    // Resolve period_code → period_start / period_end from the run's
    // periods list. We pull periods from the rows already loaded
    // (every row carries period_start + period_end alongside
    // period_code); pick the first match.
    const sample = rows.find((r) => r.period_code === args.period_code);
    if (!sample) {
      setToast({ text: `Couldn't find period ${args.period_code} in the current run`, kind: "error" });
      return;
    }
    try {
      await wholesaleRepo.upsertTbdRow(selectedRun.id, {
        ...args,
        is_user_added: true,
        period_start: sample.period_start,
        period_end: sample.period_end,
      });
      setToast({ text: `Added TBD row · ${args.period_code}`, kind: "success" });
      const seq = ++rebuildSeq.current;
      const refreshed = await buildGridRows(selectedRun);
      if (seq !== rebuildSeq.current) return;
      setRows(refreshed);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setToast({ text: `Add row failed — ${msg}`, kind: "error" });
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
        } catch { /* swallow */ }
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
    if (!row.tbd_id) {
      // The row is synthetic — upsert under the new style first so a
      // real id exists, then patch it. (The synthetic catch-all rows
      // start with no tbd_id and get one only on first edit.)
      try {
        await wholesaleRepo.upsertTbdRow(selectedRun.id, {
          style_code: styleCode,
          color: row.sku_color ?? "TBD",
          is_new_color: row.is_new_color ?? false,
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
        const seq = ++rebuildSeq.current;
        const refreshed = await buildGridRows(selectedRun);
        if (seq !== rebuildSeq.current) return;
        setRows(refreshed);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setToast({ text: `Style save failed — ${msg}`, kind: "error" });
      }
      return;
    }
    try {
      await wholesaleRepo.patchTbdRow(row.tbd_id, { style_code: styleCode });
      setToast({ text: `Style set to ${styleCode}`, kind: "success" });
      const seq = ++rebuildSeq.current;
      const refreshed = await buildGridRows(selectedRun);
      if (seq !== rebuildSeq.current) return;
      setRows(refreshed);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 23505 = unique violation (the target style already has its
      // own TBD row in this run/period). We can't auto-merge without
      // the planner's input on which color / customer wins; ask
      // them to drill in.
      if (msg.includes("23505")) {
        setToast({ text: `A TBD row already exists for ${styleCode} in this period. Drill in to edit it directly.`, kind: "error" });
      } else {
        setToast({ text: `Style save failed — ${msg}`, kind: "error" });
      }
    }
  }

  // Reassign a TBD stock-buy row to a real customer (or back to the
  // (Supply Only) placeholder). Decision (a): the row stays as-is —
  // it just changes ownership. The next planning build may absorb
  // the qty into the new customer's regular forecast row, but until
  // then the line continues to render on the grid as is_tbd.
  async function saveTbdCustomer(row: IpPlanningGridRow, customerId: string, customerName: string) {
    if (!selectedRun) return;
    const fid = row.forecast_id;
    setRows((prev) => prev.map((r) => r.forecast_id === fid ? { ...r, customer_id: customerId, customer_name: customerName } : r));
    try {
      await saveTbdField(row, { customer_id: customerId });
      setToast({ text: `Reassigned to ${customerName}`, kind: "success" });
      const seq = ++rebuildSeq.current;
      void (async () => {
        try {
          const refreshed = await buildGridRows(selectedRun);
          if (seq !== rebuildSeq.current) return;
          setRows(refreshed);
        } catch { /* swallow */ }
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
  async function saveTbdColor(row: IpPlanningGridRow, color: string, isNewColor: boolean) {
    if (!selectedRun) return;
    const fid = row.forecast_id;
    setRows((prev) => prev.map((r) => r.forecast_id === fid ? { ...r, sku_color: color, is_new_color: isNewColor } : r));
    try {
      await saveTbdField(row, { color, is_new_color: isNewColor });
      setToast({ text: isNewColor ? `Set color to "${color}" (NEW — not in master yet)` : `Set color to "${color}"`, kind: "success" });
      const seq = ++rebuildSeq.current;
      void (async () => {
        try {
          const refreshed = await buildGridRows(selectedRun);
          if (seq !== rebuildSeq.current) return;
          setRows(refreshed);
        } catch { /* swallow */ }
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
    if (row.tbd_id) {
      await wholesaleRepo.patchTbdRow(row.tbd_id, fields);
    } else {
      await wholesaleRepo.upsertTbdRow(selectedRun.id, {
        style_code: row.sku_style,
        color: fields.color ?? row.sku_color ?? "TBD",
        is_new_color: fields.is_new_color ?? false,
        customer_id: fields.customer_id ?? row.customer_id,
        group_name: fields.group_name ?? row.group_name ?? null,
        sub_category_name: fields.sub_category_name ?? row.sub_category_name ?? null,
        period_start: row.period_start,
        period_end: row.period_end,
        period_code: row.period_code,
        buyer_request_qty: fields.buyer_request_qty ?? row.buyer_request_qty,
        override_qty: fields.override_qty ?? row.override_qty,
        final_forecast_qty: fields.final_forecast_qty ?? row.final_forecast_qty,
        planned_buy_qty: fields.planned_buy_qty ?? row.planned_buy_qty,
        unit_cost: fields.unit_cost ?? row.unit_cost,
        notes: fields.notes ?? row.notes ?? null,
      });
    }
  }

  async function saveBuyQty(forecastId: string, qty: number | null) {
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
          const refreshed = await buildGridRows(selectedRun!);
          if (seq !== rebuildSeq.current) return;
          setRows(refreshed);
          setSelectedRow((p) => p ? (refreshed.find((r) => r.forecast_id === p.forecast_id) ?? p) : null);
        } catch { /* swallow — next user action will refresh */ }
      })();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setToast({ text: `Buy qty save failed — ${msg}`, kind: "error" });
      const seq = ++rebuildSeq.current;
      const refreshed = await buildGridRows(selectedRun!);
      if (seq !== rebuildSeq.current) return;
      setRows(refreshed);
      setSelectedRow((p) => p ? (refreshed.find((r) => r.forecast_id === p.forecast_id) ?? p) : null);
    }
  }

  // Inline-edit Buyer request qty. Recomputes final_forecast_qty from
  // (system + buyer + override) clamped at 0, mirrors the compute layer.
  // TBD rows (forecast_id starts with "tbd:") route to the dedicated
  // ip_wholesale_forecast_tbd table instead of ip_wholesale_forecast.
  async function saveBuyerRequest(forecastId: string, qty: number) {
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
          const refreshed = await buildGridRows(selectedRun!);
          if (seq !== rebuildSeq.current) return;
          setRows(refreshed);
          setSelectedRow((p) => p ? (refreshed.find((r) => r.forecast_id === p.forecast_id) ?? p) : null);
        } catch { /* swallow */ }
      })();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setToast({ text: `Buyer request save failed — ${msg}`, kind: "error" });
      const seq = ++rebuildSeq.current;
      const refreshed = await buildGridRows(selectedRun!);
      if (seq !== rebuildSeq.current) return;
      setRows(refreshed);
    }
  }

  // Inline-edit Override qty. Bypasses the audit-logged applyOverride
  // path (use the drawer when you need a reason code + note).
  async function saveOverrideQty(forecastId: string, qty: number) {
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
          const refreshed = await buildGridRows(selectedRun!);
          if (seq !== rebuildSeq.current) return;
          setRows(refreshed);
          setSelectedRow((p) => p ? (refreshed.find((r) => r.forecast_id === p.forecast_id) ?? p) : null);
        } catch { /* swallow */ }
      })();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setToast({ text: `Override save failed — ${msg}`, kind: "error" });
      const seq = ++rebuildSeq.current;
      const refreshed = await buildGridRows(selectedRun!);
      if (seq !== rebuildSeq.current) return;
      setRows(refreshed);
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
          const refreshed = await buildGridRows(selectedRun!);
          if (seq !== rebuildSeq.current) return;
          setRows(refreshed);
        } catch { /* swallow */ }
      })();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setToast({ text: `System forecast save failed — ${msg}`, kind: "error" });
      const refreshed = await buildGridRows(selectedRun!);
      setRows(refreshed);
    }
  }

  async function saveUnitCost(forecastId: string, cost: number | null) {
    setRows((prev) => prev.map((r) => {
      if (r.forecast_id !== forecastId) return r;
      const effective = cost ?? r.avg_cost ?? r.ats_avg_cost ?? r.item_cost ?? null;
      return { ...r, unit_cost_override: cost, unit_cost: effective };
    }));
    try {
      await wholesaleRepo.patchForecastUnitCostOverride(forecastId, cost);
      setToast({
        text: cost != null ? `Unit cost set to $${cost.toFixed(2)}` : "Unit cost reset to auto-fill",
        kind: "success",
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setToast({ text: `Unit cost save failed — ${msg}`, kind: "error" });
      const seq = ++rebuildSeq.current;
      const refreshed = await buildGridRows(selectedRun!);
      if (seq !== rebuildSeq.current) return;
      setRows(refreshed);
      setSelectedRow((p) => p ? (refreshed.find((r) => r.forecast_id === p.forecast_id) ?? p) : null);
    }
  }

  async function saveOverride(args: { override_qty: number; reason_code: IpOverrideReasonCode; note: string | null }) {
    if (!selectedRow) return;
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
    const refreshed = await buildGridRows(selectedRun!);
    const row = refreshed.find((r) => r.forecast_id === selectedRow.forecast_id) ?? null;
    setSelectedRow(row);
    setToast({ text: "Override saved", kind: "success" });
  }

  return (
    <div style={S.app}>
      <div style={S.nav}>
        <div style={S.navLeft}>
          <div style={S.navLogo}>IP</div>
          <div>
            <div style={S.navTitle}>Demand & Inventory Planning</div>
            <div style={S.navSub}>Wholesale workbench · Phase 1</div>
          </div>
        </div>
        <div style={S.navRight}>
          <a href="/planning/ecom" style={{ ...S.btnSecondary, textDecoration: "none" }}>Ecom</a>
          <a href="/planning/supply" style={{ ...S.btnSecondary, textDecoration: "none" }}>Supply →</a>
          <a href="/planning/data-quality" style={{ ...S.btnSecondary, textDecoration: "none" }}>Data quality</a>
          <a href="/" style={{ ...S.btnSecondary, textDecoration: "none" }}>Back to PLM</a>
        </div>
      </div>

      <div style={S.content}>
        {bootstrapPhase !== "ready" ? (
          <BootstrapStatusBar phase={bootstrapPhase} onCancel={() => setBootstrapPhase("ready")} />
        ) : (
        <>
        <StaleDataBanner
          watch={["xoro_sales_history", "xoro_inventory", "wholesale_forecast"]}
          dismissKey="wholesale_workbench"
        />
        <div style={{ ...S.card, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <strong style={{ color: PAL.text, fontSize: 13 }}>Sales history:</strong>
          <input type="date" value={ingestFrom} onChange={(e) => setIngestFrom(e.target.value)}
                 style={{ ...S.input, width: 140 }} />
          <span style={{ color: PAL.textDim, fontSize: 12 }}>to</span>
          <input type="date" value={ingestTo} onChange={(e) => setIngestTo(e.target.value)}
                 style={{ ...S.input, width: 140 }} />
          {!autoWalking ? (
            <button style={S.btnPrimary} onClick={autoWalkSales} disabled={ingesting} title="Pulls every invoice in your Xoro catalog. Forecast layer will trim to last 12 months from snapshot when building.">
              {runningKind === "autowalk" ? "Working…" : "▶ Fetch all Xoro sales"}
            </button>
          ) : (
            <button style={{ ...S.btnSecondary, color: PAL.red, borderColor: PAL.red }} onClick={() => { autoWalkAbort.current = true; }}>
              ■ Stop fetch
            </button>
          )}
          <button style={S.btnSecondary} onClick={syncNewestSales} disabled={ingesting || autoWalking} title="Pulls only the LAST 10 Xoro pages (~1000 newest invoices). Use after the Excel bootstrap for daily/weekly updates.">
            {runningKind === "newest" ? "Working…" : "↻ Sync newest sales"}
          </button>
          <label style={{ ...S.btnPrimary, display: "inline-flex", alignItems: "center", cursor: ingesting ? "not-allowed" : "pointer", opacity: ingesting ? 0.5 : 1 }} title="Authoritative source of truth for SKU, Style, Color, Description, Avg Cost. New items are auto-stubbed by sales/PO/ATS sync; re-upload the master to refresh them.">
            {runningKind === "excel-master" ? "Working…" : "Upload item master (Excel)"}
            <input type="file" accept=".xlsx,.xls" disabled={ingesting} style={{ display: "none" }}
                   onChange={(e) => { const f = e.target.files?.[0]; if (f) { void ingestExcel("master", f); e.target.value = ""; } }} />
          </label>
          <label style={{ ...S.btnPrimary, display: "inline-flex", alignItems: "center", cursor: ingesting ? "not-allowed" : "pointer", opacity: ingesting ? 0.5 : 1 }}>
            {runningKind === "excel-sales" ? "Working…" : "Upload sales (Excel)"}
            <input type="file" accept=".xlsx,.xls" disabled={ingesting} style={{ display: "none" }}
                   onChange={(e) => { const f = e.target.files?.[0]; if (f) { void ingestExcel("sales", f); e.target.value = ""; } }} />
          </label>
          <button style={S.btnSecondary} onClick={() => void runMissingItemsSync()} disabled={ingesting || autoWalking} title="Pulls the Xoro item catalog and inserts only SKUs not already in the item master. Existing rows are never modified.">
            {runningKind === "missing-items" ? "Working…" : "+ Add new items (Xoro)"}
          </button>
          <button style={S.btnSecondary} onClick={() => void runSupplySync("ats")} disabled={ingesting || autoWalking} title="Pulls on-hand / on-SO from the ATS app's persisted Excel snapshot into ip_inventory_snapshot">
            {runningKind === "ats" ? "Working…" : "Sync on-hand (ATS)"}
          </button>
          <button style={S.btnSecondary} onClick={() => void runSupplySync("tanda")} disabled={ingesting || autoWalking} title="Pulls open POs from the PO WIP app's tanda_pos table into ip_open_purchase_orders">
            {runningKind === "tanda" ? "Working…" : "Sync open POs (TandA)"}
          </button>
          <span style={{ color: PAL.textMuted, fontSize: 12, flexBasis: "100%" }}>
            Item master columns: SKU (or Style+Color), Description, Style, Color, AvgCost. Sales columns: SKU, Customer, Date, Qty (UnitPrice/InvoiceNumber optional). Rebuild forecast after upload.
          </span>
        </div>

        <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
          <TabButton active={tab === "grid"} onClick={() => setTab("grid")}>Planning grid</TabButton>
          <TabButton active={tab === "requests"} onClick={() => setTab("requests")}>
            Future demand requests ({requests.length})
          </TabButton>
        </div>

        {tab === "grid" && (
          <>
            <MonthlyTotalsCards rows={scopedRows} systemSuggestionsOn={systemSuggestionsOn} />
            <WholesalePlanningGrid
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
              onUpdateBuyerRequest={saveBuyerRequest}
              onUpdateOverride={saveOverrideQty}
              onUpdateSystemOverride={saveSystemOverride}
              onUpdateTbdColor={saveTbdColor}
              onUpdateTbdStyle={saveTbdStyle}
              onUpdateTbdCustomer={saveTbdCustomer}
              onAddTbdRow={addTbdRow}
              onDeleteTbdRow={deleteTbdRow}
              masterColorsLower={masterColorsLower}
              masterStyles={masterStyles}
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
        </>
        )}
      </div>

      {selectedRow && (
        <ForecastDetailDrawer
          row={selectedRow}
          overrides={overridesForRow}
          onClose={() => setSelectedRow(null)}
          onSaveOverride={saveOverride}
          onUpdateBuyQty={saveBuyQty}
        />
      )}

      <Toast toast={toast} onDismiss={() => setToast(null)} />
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

// Month-by-month rollup of Total Buy and Final Forecast — units + $.
// Sourced from the same `rows` the grid renders (post-build), so what
// you see here matches the grid totals.
function MonthlyTotalsCards({ rows, systemSuggestionsOn }: { rows: IpPlanningGridRow[]; systemSuggestionsOn: boolean }) {
  const totals = useMemo(() => {
    type Bucket = {
      buyQty: number; buyDollars: number;
      forecastQty: number; forecastDollars: number;
    };
    const months = new Map<string, Bucket>();
    let totalBuyQty = 0, totalBuyD = 0, totalFcQty = 0, totalFcD = 0;
    for (const r of rows) {
      const m = r.period_code;
      let b = months.get(m);
      if (!b) { b = { buyQty: 0, buyDollars: 0, forecastQty: 0, forecastDollars: 0 }; months.set(m, b); }
      const buy = r.planned_buy_qty ?? 0;
      const cost = r.unit_cost ?? r.avg_cost ?? 0;
      // Match the grid's mute logic: when system suggestions are OFF,
      // forecast = max(0, buyer + override). Otherwise use the
      // service-computed final_forecast_qty as-is.
      const finalEff = systemSuggestionsOn
        ? r.final_forecast_qty
        : Math.max(0, r.buyer_request_qty + r.override_qty);
      b.buyQty += buy;
      b.buyDollars += buy * cost;
      b.forecastQty += finalEff;
      b.forecastDollars += finalEff * cost;
      totalBuyQty += buy;
      totalBuyD += buy * cost;
      totalFcQty += finalEff;
      totalFcD += finalEff * cost;
    }
    const sorted = Array.from(months.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    return { sorted, totalBuyQty, totalBuyD, totalFcQty, totalFcD };
  }, [rows, systemSuggestionsOn]);

  const fmtUnits = (n: number) => Math.round(n).toLocaleString();
  const fmtUsd = (n: number) =>
    n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M`
      : n >= 10_000 ? `$${(n / 1000).toFixed(1)}k`
      : `$${Math.round(n).toLocaleString()}`;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
      <SummaryCard
        title="Total Buy"
        accent={PAL.green}
        totalUnits={totals.totalBuyQty}
        totalDollars={totals.totalBuyD}
        rows={totals.sorted.map(([m, b]) => ({ month: m, units: b.buyQty, dollars: b.buyDollars }))}
        fmtUnits={fmtUnits}
        fmtUsd={fmtUsd}
      />
      <SummaryCard
        title="Final Forecast"
        accent={PAL.accent2}
        totalUnits={totals.totalFcQty}
        totalDollars={totals.totalFcD}
        rows={totals.sorted.map(([m, b]) => ({ month: m, units: b.forecastQty, dollars: b.forecastDollars }))}
        fmtUnits={fmtUnits}
        fmtUsd={fmtUsd}
      />
    </div>
  );
}

function SummaryCard({
  title, accent, totalUnits, totalDollars, rows, fmtUnits, fmtUsd,
}: {
  title: string;
  accent: string;
  totalUnits: number;
  totalDollars: number;
  rows: Array<{ month: string; units: number; dollars: number }>;
  fmtUnits: (n: number) => string;
  fmtUsd: (n: number) => string;
}) {
  return (
    <div style={{ ...S.card, padding: 14 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ fontSize: 12, color: PAL.textMuted, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase" }}>{title}</div>
        <div style={{ display: "flex", gap: 16 }}>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 10, color: PAL.textMuted }}>Total units</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: accent, fontFamily: "monospace" }}>{fmtUnits(totalUnits)}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 10, color: PAL.textMuted }}>Total $</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: accent, fontFamily: "monospace" }}>{fmtUsd(totalDollars)}</div>
          </div>
        </div>
      </div>
      {rows.length === 0 ? (
        <div style={{ color: PAL.textMuted, fontSize: 12, fontStyle: "italic", padding: 8 }}>
          No data yet — build a forecast and add Buy quantities.
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1.2fr repeat(2, 1fr)", gap: 4, fontSize: 12 }}>
          <div style={{ color: PAL.textMuted, fontWeight: 600 }}>Month</div>
          <div style={{ color: PAL.textMuted, fontWeight: 600, textAlign: "right" }}>Units</div>
          <div style={{ color: PAL.textMuted, fontWeight: 600, textAlign: "right" }}>$</div>
          {rows.map((r) => (
            <Fragment key={r.month}>
              <div style={{ color: PAL.textDim }}>{formatPeriodCode(r.month)}</div>
              <div style={{ textAlign: "right", fontFamily: "monospace", color: r.units > 0 ? PAL.text : PAL.textMuted }}>
                {r.units > 0 ? fmtUnits(r.units) : "—"}
              </div>
              <div style={{ textAlign: "right", fontFamily: "monospace", color: r.dollars > 0 ? PAL.text : PAL.textMuted }}>
                {r.dollars > 0 ? fmtUsd(r.dollars) : "—"}
              </div>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

function OperationStatusBar({ label, message, canCancel, onCancel }: {
  label: string;
  message?: string;
  canCancel?: boolean;
  onCancel: () => void;
}) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: PAL.panel, borderRadius: 14, padding: "28px 32px", width: 380, maxWidth: "92vw", border: `1px solid ${PAL.border}`, boxSizing: "border-box" }}>
        <div style={{ fontWeight: 700, fontSize: 16, color: PAL.text, marginBottom: 8 }}>{label}</div>
        <div style={{ fontSize: 13, color: PAL.textMuted, marginBottom: 20, minHeight: 18, wordBreak: "break-word" as const }}>
          {message ?? "Working…"}
        </div>
        <div style={{ background: PAL.panelAlt, borderRadius: 8, height: 10, overflow: "hidden", marginBottom: 20, position: "relative", border: `1px solid ${PAL.borderFaint}` }}>
          <div style={{ position: "absolute", top: 0, bottom: 0, borderRadius: 8, background: `linear-gradient(90deg,${PAL.green},${PAL.accent})`, width: "35%", animation: "ipOpPulse 1.4s ease-in-out infinite" }} />
        </div>
        <style>{`@keyframes ipOpPulse { 0% { left: -35%; } 100% { left: 100%; } }`}</style>
        <button
          style={{ background: "none", border: `1px solid ${canCancel ? PAL.red : PAL.border}`, color: canCancel ? PAL.red : PAL.textMuted, borderRadius: 6, padding: "7px 18px", fontSize: 13, cursor: "pointer", width: "100%" }}
          onClick={onCancel}
          title={canCancel ? "Stop this and put things back the way they were" : "Hide this — work keeps going"}
        >
          {canCancel ? "Stop" : "Hide"}
        </button>
      </div>
    </div>
  );
}

function BootstrapStatusBar({ phase, onCancel }: { phase: "masters" | "run-data" | "ready"; onCancel: () => void }) {
  const PHASE_LABELS: Record<string, string> = {
    "masters": "Loading customers and items…",
    "run-data": "Loading forecast and inventory…",
    "ready": "",
  };
  const pct = phase === "masters" ? 25 : phase === "run-data" ? 75 : 100;
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: PAL.panel, borderRadius: 14, padding: "28px 32px", width: 380, maxWidth: "92vw", border: `1px solid ${PAL.border}`, boxSizing: "border-box", boxShadow: "0 8px 24px rgba(0,0,0,0.18)" }}>
        <div style={{ fontWeight: 700, fontSize: 16, color: PAL.text, marginBottom: 8 }}>Loading…</div>
        <div style={{ fontSize: 13, color: PAL.textMuted, marginBottom: 20 }}>{PHASE_LABELS[phase]}</div>
        <div style={{ background: PAL.panelAlt, borderRadius: 8, height: 10, overflow: "hidden", marginBottom: 20, border: `1px solid ${PAL.borderFaint}` }}>
          <div style={{ height: "100%", borderRadius: 8, background: `linear-gradient(90deg,${PAL.green},${PAL.accent})`, width: `${pct}%`, transition: "width 0.4s ease" }} />
        </div>
        <button
          style={{ background: "none", border: `1px solid ${PAL.red}`, color: PAL.red, borderRadius: 6, padding: "7px 18px", fontSize: 13, cursor: "pointer", width: "100%" }}
          onClick={onCancel}
        >
          Stop
        </button>
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
            style={{
              background: active ? PAL.panel : "transparent",
              border: `1px solid ${active ? PAL.accent : PAL.border}`,
              color: active ? PAL.text : PAL.textDim,
              borderRadius: 8,
              padding: "8px 14px",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}>
      {children}
    </button>
  );
}

