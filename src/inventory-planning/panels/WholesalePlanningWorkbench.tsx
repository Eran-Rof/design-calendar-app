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
import { ingestXoroSales } from "../services/xoroSalesIngestService";
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

  async function ingestSales() {
    setIngesting(true);
    try {
      const r = await ingestXoroSales({ dateFrom: ingestFrom, dateTo: ingestTo });
      if (r.error) {
        setToast({ text: `Ingest error: ${r.error}`, kind: "error" });
      } else {
        setToast({
          text: `Xoro sales: ${r.xoro_lines_fetched} lines fetched · ${r.inserted} rows upserted${r.skipped_no_sku > 0 ? ` · ${r.skipped_no_sku} skipped (no SKU match)` : ""}`,
          kind: r.inserted > 0 ? "success" : "info",
        });
        if (r.inserted > 0) await loadRunData();
      }
    } catch (e) {
      setToast({ text: "Ingest failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally {
      setIngesting(false);
    }
  }

  async function handleMethodChange(pref: IpForecastMethodPreference) {
    if (!selectedRun || selectedRun.forecast_method_preference === pref) return;
    await wholesaleRepo.updatePlanningRun(selectedRun.id, { forecast_method_preference: pref });
    setRuns((prev) => prev.map((r) => r.id === selectedRun.id ? { ...r, forecast_method_preference: pref } : r));
    setToast({ text: `Method set to "${FORECAST_METHOD_LABELS[pref]}" — rebuild forecast to apply`, kind: "info" });
  }

  async function saveBuyQty(forecastId: string, qty: number | null) {
    await wholesaleRepo.patchForecastBuyQty(forecastId, qty);
    const refreshed = await buildGridRows(selectedRun!);
    setRows(refreshed);
    setSelectedRow((prev) => prev ? (refreshed.find((r) => r.forecast_id === prev.forecast_id) ?? prev) : null);
    setToast({ text: qty != null ? `Buy qty set to ${qty.toLocaleString()}` : "Buy qty cleared", kind: "success" });
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
          <button style={S.btnPrimary} onClick={ingestSales} disabled={ingesting}>
            {ingesting ? "Ingesting…" : "Ingest Xoro sales"}
          </button>
          <span style={{ color: PAL.textMuted, fontSize: 12 }}>
            Pulls invoices from Xoro → ip_sales_history_wholesale. Rebuild forecast after ingesting.
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

