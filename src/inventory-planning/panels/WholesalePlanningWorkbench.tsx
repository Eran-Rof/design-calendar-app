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

import { useCallback, useEffect, useMemo, useState } from "react";
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
import { ingestXoroSales, ingestXoroItems } from "../services/xoroSalesIngestService";
import { ingestSalesExcel, ingestAvgCostExcel, type ExcelIngestResult } from "../services/excelIngestService";
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
    setIngesting(true);
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
      setIngesting(false);
    }
  }

  async function ingestExcel(kind: "sales" | "avgcost", file: File) {
    setIngesting(true);
    try {
      const r: ExcelIngestResult = kind === "sales"
        ? await ingestSalesExcel(file)
        : await ingestAvgCostExcel(file);
      const skipped = r.skipped_no_sku + r.skipped_no_date + r.skipped_zero_qty + r.skipped_bad_cost;
      setToast({
        text: `${kind === "sales" ? "Sales" : "Avg costs"}: ${r.parsed} parsed · ${r.inserted} upserted${skipped > 0 ? ` · ${skipped} skipped` : ""}`,
        kind: r.inserted > 0 ? "success" : "info",
      });
      if (r.inserted > 0 && kind === "sales") await loadRunData();
      if (r.inserted > 0 && kind === "avgcost" && selectedRun) {
        const refreshed = await buildGridRows(selectedRun);
        setRows(refreshed);
      }
    } catch (e) {
      setToast({ text: `${kind} upload failed — ${e instanceof Error ? e.message : String(e)}`, kind: "error" });
    } finally {
      setIngesting(false);
    }
  }

  // Page tracker for sales ingest — successive clicks advance through
  // pages 1, 2, 3 … within the same date window. Resets when the user
  // changes either date picker.
  const [salesPageStart, setSalesPageStart] = useState(1);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setSalesPageStart(1); }, [ingestFrom, ingestTo]);

  async function ingestSales() {
    setIngesting(true);
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
        setToast({
          text: `Xoro sales (page ${salesPageStart}): ${r.xoro_lines_fetched} fetched · ${r.inserted} upserted${r.auto_created_skus ? ` · ${r.auto_created_skus} new SKUs` : ""}${r.skipped_no_sku > 0 ? ` · ${r.skipped_no_sku} skipped` : ""}`,
          kind: r.inserted > 0 ? "success" : "info",
        });
        // Advance to next page if we got a full page; reset to 1 if we
        // got an empty page (end of date window).
        if (r.xoro_lines_fetched >= 100) setSalesPageStart((p) => p + 1);
        else setSalesPageStart(1);
        if (r.inserted > 0) await loadRunData();
      }
    } catch (e) {
      setToast({ text: "Ingest failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally {
      setIngesting(false);
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

  // Optimistic local update so Buy $ reflects the typed value immediately,
  // then refresh from DB so derived columns (Short, Excess, rolling supply)
  // recompute. A failure toasts and reverts via the same refresh path.
  async function saveBuyQty(forecastId: string, qty: number | null) {
    setRows((prev) => prev.map((r) => r.forecast_id === forecastId ? { ...r, planned_buy_qty: qty } : r));
    try {
      await wholesaleRepo.patchForecastBuyQty(forecastId, qty);
      setToast({ text: qty != null ? `Buy qty set to ${qty.toLocaleString()}` : "Buy qty cleared", kind: "success" });
      const refreshed = await buildGridRows(selectedRun!);
      setRows(refreshed);
      setSelectedRow((p) => p ? (refreshed.find((r) => r.forecast_id === p.forecast_id) ?? p) : null);
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
      const refreshed = await buildGridRows(selectedRun!);
      setRows(refreshed);
      setSelectedRow((p) => p ? (refreshed.find((r) => r.forecast_id === p.forecast_id) ?? p) : null);
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
      const refreshed = await buildGridRows(selectedRun!);
      setRows(refreshed);
      setSelectedRow((p) => p ? (refreshed.find((r) => r.forecast_id === p.forecast_id) ?? p) : null);
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
          <button style={S.btnPrimary} onClick={ingestSales} disabled={ingesting} title="Pulls one page (~100 invoices) per click. Page tracker advances automatically.">
            {ingesting ? "Working…" : `Ingest Xoro sales (page ${salesPageStart})`}
          </button>
          <button style={S.btnSecondary} onClick={ingestItems} disabled={ingesting} title="Pulls Xoro item catalog into ip_item_master. Click repeatedly to chunk through 20k items — page tracker advances automatically.">
            {ingesting ? "Working…" : `Ingest Xoro items (pages ${itemsPageStart}-${itemsPageStart + 4})`}
          </button>
          <label style={{ ...S.btnPrimary, display: "inline-flex", alignItems: "center", cursor: ingesting ? "not-allowed" : "pointer", opacity: ingesting ? 0.5 : 1 }}>
            {ingesting ? "Working…" : "Upload sales (Excel)"}
            <input type="file" accept=".xlsx,.xls" disabled={ingesting} style={{ display: "none" }}
                   onChange={(e) => { const f = e.target.files?.[0]; if (f) { void ingestExcel("sales", f); e.target.value = ""; } }} />
          </label>
          <label style={{ ...S.btnPrimary, display: "inline-flex", alignItems: "center", cursor: ingesting ? "not-allowed" : "pointer", opacity: ingesting ? 0.5 : 1 }}>
            {ingesting ? "Working…" : "Upload avg costs (Excel)"}
            <input type="file" accept=".xlsx,.xls" disabled={ingesting} style={{ display: "none" }}
                   onChange={(e) => { const f = e.target.files?.[0]; if (f) { void ingestExcel("avgcost", f); e.target.value = ""; } }} />
          </label>
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

