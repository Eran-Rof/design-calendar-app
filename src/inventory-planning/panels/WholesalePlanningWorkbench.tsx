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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { ingestXoroSales, ingestXoroItems, syncAtsSupply, syncTandaPos } from "../services/xoroSalesIngestService";
import { ingestSalesExcel, ingestAvgCostExcel, ingestItemMasterExcel, type ExcelIngestResult } from "../services/excelIngestService";
import { S, PAL } from "../components/styles";
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

  const selectedRun = useMemo(() => runs.find((r) => r.id === selectedRunId) ?? null, [runs, selectedRunId]);

  const loadMasters = useCallback(async () => {
    const [cs, cats, its, reqs, rs] = await Promise.all([
      wholesaleRepo.listCustomers(),
      wholesaleRepo.listCategories(),
      wholesaleRepo.listItems(),
      wholesaleRepo.listOpenRequests(),
      wholesaleRepo.listPlanningRuns("wholesale"),
    ]);
    setCustomers(cs);
    setCategories(cats);
    setItems(its);
    setRequests(reqs);
    setRuns(rs);
    if (!selectedRunId) {
      const active = rs.find((r) => r.status === "active") ?? rs[0] ?? null;
      if (active) setSelectedRunId(active.id);
    }
  }, [selectedRunId]);

  const loadRunData = useCallback(async () => {
    if (!selectedRun) { setRows([]); setOverrides([]); return; }
    const [grid, ovs] = await Promise.all([
      buildGridRows(selectedRun),
      wholesaleRepo.listOverrides(selectedRun.id),
    ]);
    setRows(grid);
    setOverrides(ovs);
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

  useEffect(() => {
    void refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (selectedRun) void loadRunData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRun]);

  const overridesForRow = useMemo(() => {
    if (!selectedRow) return [];
    return overrides.filter(
      (o) => o.customer_id === selectedRow.customer_id &&
             o.sku_id === selectedRow.sku_id &&
             o.period_start === selectedRow.period_start,
    );
  }, [overrides, selectedRow]);

  // Pull Xoro items into ip_item_master in 5-page chunks so a 20k-item
  // catalog can be ingested across 8 clicks without hitting the function
  // duration cap.
  const [itemsPageStart, setItemsPageStart] = useState(1);
  async function ingestItems() {
    setIngesting(true); setRunningKind("items");
    try {
      const r = await ingestXoroItems({ pageStart: itemsPageStart, pageLimit: 5 });
      if (r.error) {
        console.error("[xoro-items-sync] ingest failed", r);
        setToast({ text: `Items ingest error: ${r.error}`, kind: "error" });
      } else {
        setToast({
          text: `Xoro items: ${r.xoro_items_fetched} fetched · ${r.inserted} upserted (pages ${itemsPageStart}-${itemsPageStart + 4})`,
          kind: r.inserted > 0 ? "success" : "info",
        });
        // Bump the next chunk's start. If the call returned fewer than a
        // full chunk, reset — there's nothing more to fetch.
        if (r.xoro_items_fetched >= 5 * 500) setItemsPageStart((p) => p + 5);
        else setItemsPageStart(1);
      }
    } catch (e) {
      setToast({ text: "Items ingest failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally {
      setIngesting(false); setRunningKind(null);
    }
  }

  async function runSupplySync(kind: "ats" | "tanda") {
    setIngesting(true); setRunningKind(kind === "ats" ? "ats" : "tanda");
    try {
      if (kind === "tanda") {
        const r = await syncTandaPos();
        const err = (r as { error?: string }).error;
        if (err) setToast({ text: `TandA POs sync error: ${err}`, kind: "error" });
        else {
          const inserted = (r as { inserted?: number }).inserted ?? 0;
          const newSkus = (r as { auto_created_skus?: number }).auto_created_skus ?? 0;
          setToast({ text: `TandA POs: ${inserted} upserted${newSkus ? ` · ${newSkus} new SKUs` : ""}`, kind: inserted > 0 ? "success" : "info" });
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
          setToast({ text: `ATS sync error: ${r.error}`, kind: "error" });
          break;
        }
        chunks++;
        totalInserted += r.inserted ?? 0;
        totalNew += r.auto_created_skus ?? 0;
        totalSkipped += (r.skipped_zero_state ?? 0) + (r.skipped_no_sku ?? 0);
        totalAts = r.ats_skus_total ?? totalAts;
        const processed = Math.min(start + (r.ats_skus_in_batch ?? 0), totalAts);
        setToast({
          text: `ATS supply: chunk ${chunks} · ${processed.toLocaleString()}/${totalAts.toLocaleString()} SKUs · ${totalInserted} upserted · ${totalNew} new SKUs`,
          kind: "info",
        });
        if (r.done || r.next_start == null) {
          setToast({
            text: `✓ ATS supply DONE — ${totalInserted.toLocaleString()} upserted · ${totalNew} new SKUs · ${totalSkipped.toLocaleString()} skipped (zero state) · ${totalAts.toLocaleString()} total scanned in ${chunks} chunk(s)`,
            kind: "success",
          });
          if (totalInserted > 0) await loadRunData();
          break;
        }
        start = r.next_start;
      }
    } catch (e) {
      setToast({ text: `${kind} sync failed — ${e instanceof Error ? e.message : String(e)}`, kind: "error" });
    } finally {
      setIngesting(false); setRunningKind(null);
    }
  }

  async function ingestExcel(kind: "sales" | "avgcost" | "master", file: File) {
    setIngesting(true); setRunningKind(`excel-${kind}`);
    const label = kind === "sales" ? "Sales" : kind === "avgcost" ? "Avg costs" : "Item master";
    try {
      const onProgress = (msg: string) => setToast({ text: `${label} upload: ${msg}`, kind: "info" });
      const r: ExcelIngestResult =
        kind === "sales"   ? await ingestSalesExcel(file, onProgress) :
        kind === "avgcost" ? await ingestAvgCostExcel(file) :
                             await ingestItemMasterExcel(file, onProgress);
      const skipParts = [];
      if (r.skipped_no_sku) skipParts.push(`${r.skipped_no_sku} no-SKU`);
      if (r.skipped_no_date) skipParts.push(`${r.skipped_no_date} no-date`);
      if (r.skipped_zero_qty) skipParts.push(`${r.skipped_zero_qty} zero-qty`);
      if (r.skipped_bad_cost) skipParts.push(`${r.skipped_bad_cost} bad-cost`);
      const skipSummary = skipParts.length > 0 ? ` · skipped ${skipParts.join(", ")}` : "";
      const errSummary = r.errors.length > 0 ? ` · ⚠ ${r.errors.length} errors (see console)` : "";
      if (r.errors.length > 0) console.error(`[excel-${kind}] errors:`, r.errors);
      setToast({
        text: `✓ ${label} upload DONE — parsed ${r.parsed.toLocaleString()} rows · upserted ${r.inserted.toLocaleString()}${skipSummary}${errSummary}`,
        kind: r.errors.length > 0 ? "error" : r.inserted > 0 ? "success" : "info",
      });
      if (r.inserted > 0 && kind === "sales") await loadRunData();
      if (r.inserted > 0 && (kind === "avgcost" || kind === "master") && selectedRun) {
        const refreshed = await buildGridRows(selectedRun);
        setRows(refreshed);
      }
    } catch (e) {
      console.error(`[excel-${kind}] failed`, e);
      setToast({ text: `✗ ${label} upload FAILED — ${e instanceof Error ? e.message : String(e)} (see DevTools console)`, kind: "error" });
    } finally {
      setIngesting(false); setRunningKind(null);
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
    try {
      const r = await ingestXoroSales({
        dateFrom: "1900-01-01",
        dateTo: "2100-12-31",
        fromEnd: 3,
        pageLimit: 3,
      });
      if (r.error) {
        setToast({ text: `Sync newest error: ${r.error}`, kind: "error" });
        return;
      }
      const span = r.oldest_invoice_in_batch && r.newest_invoice_in_batch
        ? ` · covered ${r.oldest_invoice_in_batch}…${r.newest_invoice_in_batch}`
        : "";
      setToast({
        text: `✓ Sync newest DONE — ${r.xoro_lines_fetched} fetched · ${r.inserted} upserted${r.auto_created_skus ? ` · ${r.auto_created_skus} new SKUs` : ""}${r.auto_created_customers ? ` · ${r.auto_created_customers} new customers` : ""}${span}`,
        kind: r.inserted > 0 ? "success" : "info",
      });
      if (r.inserted > 0) await loadRunData();
    } catch (e) {
      setToast({ text: `Sync newest failed — ${e instanceof Error ? e.message : String(e)}`, kind: "error" });
    } finally {
      setIngesting(false); setRunningKind(null);
    }
  }

  async function autoWalkSales() {
    setAutoWalking(true); setRunningKind("autowalk");
    autoWalkAbort.current = false;
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
          setToast({ text: `Auto-walk transient error (page ${page}): ${msg} · retrying ${consecutiveErrors}/3`, kind: "info" });
          if (consecutiveErrors >= 3) {
            setToast({ text: `Auto-walk stopped on page ${page} after 3 retries: ${msg}`, kind: "error" });
            break;
          }
          // Brief backoff before retrying the same page.
          await new Promise((res) => setTimeout(res, 5000));
          continue;
        }
        pagesWalked += 2;
        if (r.error) {
          setToast({ text: `Auto-walk stopped on page ${page}: ${r.error}`, kind: "error" });
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
        setToast({
          text: `Auto-walk: page ${page} · ${r.oldest_invoice_in_batch ?? "?"}…${r.newest_invoice_in_batch ?? "?"} · running totals ${totalInserted} upserted, ${totalAutoSku} new SKUs${emptyHint}`,
          kind: "info",
        });
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
      setToast({
        text: `✓ Auto-walk DONE — ${pagesWalked} pages · covered ${earliestDate ?? "?"}…${latestDate ?? "?"} · ${totalInserted.toLocaleString()} upserted · ${totalAutoSku} new SKUs · ${totalAutoCust} new customers${aborted ? " · cancelled" : ceilingHit ? " · stopped at hard ceiling — re-click to continue" : ""}`,
        kind: totalInserted > 0 ? "success" : "info",
      });
      if (totalInserted > 0) await loadRunData();
    } finally {
      setAutoWalking(false); setRunningKind(null);
      autoWalkAbort.current = false;
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
  async function saveBuyQty(forecastId: string, qty: number | null) {
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
      await wholesaleRepo.patchForecastBuyQty(forecastId, qty);
      setToast({ text: qty != null ? `Buy qty set to ${qty.toLocaleString()}` : "Buy qty cleared", kind: "success" });
      // Fire-and-forget — Short/Excess update a moment later when the
      // rebuild finishes. The cell is already showing the new value.
      void (async () => {
        try {
          const refreshed = await buildGridRows(selectedRun!);
          setRows(refreshed);
          setSelectedRow((p) => p ? (refreshed.find((r) => r.forecast_id === p.forecast_id) ?? p) : null);
        } catch { /* swallow — next user action will refresh */ }
      })();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setToast({ text: `Buy qty save failed — ${msg}`, kind: "error" });
      const refreshed = await buildGridRows(selectedRun!);
      setRows(refreshed);
      setSelectedRow((p) => p ? (refreshed.find((r) => r.forecast_id === p.forecast_id) ?? p) : null);
    }
  }

  // Inline-edit Buyer request qty. Recomputes final_forecast_qty from
  // (system + buyer + override) clamped at 0, mirrors the compute layer.
  async function saveBuyerRequest(forecastId: string, qty: number) {
    const row = rows.find((r) => r.forecast_id === forecastId);
    if (!row) return;
    const final = Math.max(0, row.system_forecast_qty + qty + row.override_qty);
    setRows((prev) => prev.map((r) => r.forecast_id === forecastId ? { ...r, buyer_request_qty: qty, final_forecast_qty: final } : r));
    try {
      await wholesaleRepo.patchForecastBuyerRequest(forecastId, qty, final);
      setToast({ text: `Buyer request set to ${qty.toLocaleString()}`, kind: "success" });
      void (async () => {
        try {
          const refreshed = await buildGridRows(selectedRun!);
          setRows(refreshed);
          setSelectedRow((p) => p ? (refreshed.find((r) => r.forecast_id === p.forecast_id) ?? p) : null);
        } catch { /* swallow */ }
      })();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setToast({ text: `Buyer request save failed — ${msg}`, kind: "error" });
      const refreshed = await buildGridRows(selectedRun!);
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
      await wholesaleRepo.patchForecastOverride(forecastId, qty, final);
      setToast({ text: `Override set to ${qty > 0 ? "+" : ""}${qty.toLocaleString()}`, kind: "success" });
      void (async () => {
        try {
          const refreshed = await buildGridRows(selectedRun!);
          setRows(refreshed);
          setSelectedRow((p) => p ? (refreshed.find((r) => r.forecast_id === p.forecast_id) ?? p) : null);
        } catch { /* swallow */ }
      })();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setToast({ text: `Override save failed — ${msg}`, kind: "error" });
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
      const refreshed = await buildGridRows(selectedRun!);
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
          <button style={S.btnSecondary} onClick={ingestItems} disabled={ingesting || autoWalking} title="Pulls Xoro item catalog into ip_item_master. Click repeatedly to chunk through 20k items — page tracker advances automatically.">
            {runningKind === "items" ? "Working…" : `Ingest Xoro items (pages ${itemsPageStart}-${itemsPageStart + 4})`}
          </button>
          <label style={{ ...S.btnPrimary, display: "inline-flex", alignItems: "center", cursor: ingesting ? "not-allowed" : "pointer", opacity: ingesting ? 0.5 : 1 }} title="Authoritative source of truth for SKU, Style, Color, Description, Avg Cost. Sync handlers won't overwrite these fields.">
            {runningKind === "excel-master" ? "Working…" : "Upload item master (Excel)"}
            <input type="file" accept=".xlsx,.xls" disabled={ingesting} style={{ display: "none" }}
                   onChange={(e) => { const f = e.target.files?.[0]; if (f) { void ingestExcel("master", f); e.target.value = ""; } }} />
          </label>
          <label style={{ ...S.btnPrimary, display: "inline-flex", alignItems: "center", cursor: ingesting ? "not-allowed" : "pointer", opacity: ingesting ? 0.5 : 1 }}>
            {runningKind === "excel-sales" ? "Working…" : "Upload sales (Excel)"}
            <input type="file" accept=".xlsx,.xls" disabled={ingesting} style={{ display: "none" }}
                   onChange={(e) => { const f = e.target.files?.[0]; if (f) { void ingestExcel("sales", f); e.target.value = ""; } }} />
          </label>
          <label style={{ ...S.btnPrimary, display: "inline-flex", alignItems: "center", cursor: ingesting ? "not-allowed" : "pointer", opacity: ingesting ? 0.5 : 1 }}>
            {runningKind === "excel-avgcost" ? "Working…" : "Upload avg costs (Excel)"}
            <input type="file" accept=".xlsx,.xls" disabled={ingesting} style={{ display: "none" }}
                   onChange={(e) => { const f = e.target.files?.[0]; if (f) { void ingestExcel("avgcost", f); e.target.value = ""; } }} />
          </label>
          <button style={S.btnSecondary} onClick={() => void runSupplySync("ats")} disabled={ingesting || autoWalking} title="Pulls on-hand / on-SO from the ATS app's persisted Excel snapshot into ip_inventory_snapshot">
            {runningKind === "ats" ? "Working…" : "Sync on-hand (ATS)"}
          </button>
          <button style={S.btnSecondary} onClick={() => void runSupplySync("tanda")} disabled={ingesting || autoWalking} title="Pulls open POs from the PO WIP app's tanda_pos table into ip_open_purchase_orders">
            {runningKind === "tanda" ? "Working…" : "Sync open POs (TandA)"}
          </button>
          <span style={{ color: PAL.textMuted, fontSize: 12, flexBasis: "100%" }}>
            Sales columns: SKU, Customer, Date, Qty (UnitPrice/InvoiceNumber optional). Avg-cost columns: SKU, AvgCost. Rebuild forecast after upload.
          </span>
        </div>

        <PlanningRunControls
          runs={runs}
          selectedRunId={selectedRunId}
          onSelect={(id) => setSelectedRunId(id)}
          onChange={refreshAll}
          onToast={(t) => setToast(t)}
          scope="wholesale"
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

        <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
          <TabButton active={tab === "grid"} onClick={() => setTab("grid")}>Planning grid</TabButton>
          <TabButton active={tab === "requests"} onClick={() => setTab("requests")}>
            Future demand requests ({requests.length})
          </TabButton>
        </div>

        {tab === "grid" && (
          <WholesalePlanningGrid
            rows={rows}
            loading={loading}
            onSelectRow={setSelectedRow}
            onUpdateBuyQty={saveBuyQty}
            onUpdateUnitCost={saveUnitCost}
            onUpdateBuyerRequest={saveBuyerRequest}
            onUpdateOverride={saveOverrideQty}
          />
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

