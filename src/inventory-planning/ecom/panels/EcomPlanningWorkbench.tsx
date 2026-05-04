// Parent page for Phase 2. Mounts at /planning/ecom via main.tsx.
//
// Responsibilities:
//   • pick/create a run (reuses Phase 1 PlanningRunControls)
//   • run forecast pass (Phase 2 service)
//   • display grid + chart + drawer
//   • surface ingest action (Shopify orders/products → planning tables)
//
// Kept lean on purpose. Keeps the wholesale workbench untouched.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { IpPlanningRun } from "../../types/wholesale";
import type {
  IpEcomForecast,
  IpEcomGridRow,
  IpEcomOverrideEvent,
  IpEcomOverrideReason,
} from "../types/ecom";
import { wholesaleRepo } from "../../services/wholesalePlanningRepository";
import { ecomRepo, applyEcomOverride, buildEcomGridRows, runEcomForecastPass } from "../services";
import { ingestShopifyOrders, ingestShopifyProducts } from "../services/shopifyIngestService";
import { SB_HEADERS, SB_URL } from "../../../utils/supabase";
import { S, PAL } from "../../components/styles";
import PlanningRunControls from "../../panels/PlanningRunControls";
import Toast, { type ToastMessage } from "../../components/Toast";
import StaleDataBanner from "../../shared/components/StaleDataBanner";
import EcomPlanningGrid from "./EcomPlanningGrid";
import EcomForecastChart from "./EcomForecastChart";
import EcomOverrideDrawer from "../components/EcomOverrideDrawer";

async function fetchEcomForecast(id: string): Promise<IpEcomForecast | null> {
  if (!SB_URL) return null;
  const r = await fetch(`${SB_URL}/rest/v1/ip_ecom_forecast?id=eq.${id}&select=*`, { headers: SB_HEADERS });
  if (!r.ok) return null;
  const rows = (await r.json()) as IpEcomForecast[];
  return rows[0] ?? null;
}

type TabKey = "grid" | "chart";

export default function EcomPlanningWorkbench() {
  const [runs, setRuns] = useState<IpPlanningRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [rows, setRows] = useState<IpEcomGridRow[]>([]);
  const [overrides, setOverrides] = useState<IpEcomOverrideEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedRow, setSelectedRow] = useState<IpEcomGridRow | null>(null);
  const [tab, setTab] = useState<TabKey>("grid");
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [ingesting, setIngesting] = useState(false);
  const [building, setBuilding] = useState(false);

  const selectedRun = useMemo(() => runs.find((r) => r.id === selectedRunId) ?? null, [runs, selectedRunId]);

  const loadRuns = useCallback(async () => {
    // Accept both 'ecom' and 'all' scopes; the Phase 1 UI filtered to
    // 'wholesale' only, so here we show the ecom-appropriate runs.
    const [rs, allRs] = await Promise.all([
      wholesaleRepo.listPlanningRuns("ecom"),
      wholesaleRepo.listPlanningRuns("all"),
    ]);
    const combined = [...rs, ...allRs];
    const dedup = Array.from(new Map(combined.map((r) => [r.id, r])).values());
    setRuns(dedup);
    if (!selectedRunId && dedup.length > 0) {
      const active = dedup.find((r) => r.status === "active") ?? dedup[0];
      setSelectedRunId(active.id);
    }
  }, [selectedRunId]);

  const loadRunData = useCallback(async () => {
    if (!selectedRun) { setRows([]); setOverrides([]); return; }
    const [grid, ovs] = await Promise.all([
      buildEcomGridRows(selectedRun),
      ecomRepo.listOverrides(selectedRun.id),
    ]);
    setRows(grid);
    setOverrides(ovs);
  }, [selectedRun]);

  const refreshAll = useCallback(async () => {
    setLoading(true);
    try {
      await loadRuns();
      await loadRunData();
    } catch (e) {
      setToast({ text: "Load failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally {
      setLoading(false);
    }
  }, [loadRuns, loadRunData]);

  // Initial mount: load runs ONLY. Don't call refreshAll — its trailing
  // loadRunData() would race the [selectedRun] effect's loadRunData()
  // once setSelectedRunId(active.id) inside loadRuns propagates. Same
  // class of bug fixed in WholesalePlanningWorkbench.
  useEffect(() => {
    setLoading(true);
    loadRuns()
      .catch((e) => setToast({ text: "Load failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" }))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedRun) return;
    setLoading(true);
    loadRunData()
      .catch((e) => setToast({ text: "Load failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" }))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRun]);

  const overridesForRow = useMemo(() => {
    if (!selectedRow) return [];
    return overrides.filter(
      (o) => o.channel_id === selectedRow.channel_id &&
             o.sku_id === selectedRow.sku_id &&
             o.week_start === selectedRow.week_start,
    );
  }, [overrides, selectedRow]);

  async function saveOverride(args: { override_qty: number; reason_code: IpEcomOverrideReason; note: string | null }) {
    if (!selectedRow) return;
    const forecast = await fetchEcomForecast(selectedRow.forecast_id);
    if (!forecast) throw new Error("Forecast row not found — was it deleted?");
    await applyEcomOverride({
      forecast,
      override_qty: args.override_qty,
      reason_code: args.reason_code,
      note: args.note,
      created_by: null,
    });
    await loadRunData();
    const refreshed = await buildEcomGridRows(selectedRun!);
    setSelectedRow(refreshed.find((r) => r.forecast_id === selectedRow.forecast_id) ?? null);
    setToast({ text: "Override saved", kind: "success" });
  }

  async function saveBuyQty(forecastId: string, qty: number | null) {
    await ecomRepo.patchForecastBuyQty(forecastId, qty);
    const refreshed = await buildEcomGridRows(selectedRun!);
    setRows(refreshed);
    setSelectedRow((prev) => prev ? (refreshed.find((r) => r.forecast_id === prev.forecast_id) ?? prev) : null);
    setToast({ text: qty != null ? `Buy qty set to ${qty.toLocaleString()}` : "Buy qty cleared", kind: "success" });
  }

  async function toggleFlag(flag: "promo_flag" | "launch_flag" | "markdown_flag", value: boolean) {
    if (!selectedRow) return;
    await ecomRepo.patchForecastFlags(selectedRow.forecast_id, { [flag]: value });
    await loadRunData();
    const refreshed = await buildEcomGridRows(selectedRun!);
    setSelectedRow(refreshed.find((r) => r.forecast_id === selectedRow.forecast_id) ?? null);
    setToast({ text: `${flag.replace("_flag", "")} ${value ? "on" : "off"}`, kind: "success" });
  }

  async function buildForecast() {
    if (!selectedRun) { setToast({ text: "Pick a run first", kind: "error" }); return; }
    setBuilding(true);
    try {
      const r = await runEcomForecastPass(selectedRun);
      setToast({ text: `Ecom forecast built — ${r.forecast_rows_written} rows, ${r.triples_considered} triples`, kind: "success" });
      await loadRunData();
    } catch (e) {
      setToast({ text: "Build failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally {
      setBuilding(false);
    }
  }

  async function ingestShopify() {
    setIngesting(true);
    try {
      const [orders, products] = await Promise.all([
        ingestShopifyOrders({ limit: 20 }),
        ingestShopifyProducts({ limit: 10 }),
      ]);
      setToast({
        text: `Ingested ${orders.rows_inserted} order rows, ${products.channel_status_rows} status rows`,
        kind: "success",
      });
      await refreshAll();
    } catch (e) {
      setToast({ text: "Ingest failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally {
      setIngesting(false);
    }
  }

  return (
    <div style={S.app}>
      <div style={S.nav}>
        <div style={S.navLeft}>
          <div style={S.navLogo}>IP</div>
          <div>
            <div style={S.navTitle}>Demand & Inventory Planning</div>
            <div style={S.navSub}>Ecom workbench · Phase 2</div>
          </div>
        </div>
        <div style={S.navRight}>
          <a href="/planning/wholesale" style={{ ...S.btnSecondary, textDecoration: "none" }}>Wholesale</a>
          <a href="/planning/supply" style={{ ...S.btnSecondary, textDecoration: "none" }}>Supply →</a>
          <a href="/planning/scenarios" style={{ ...S.btnSecondary, textDecoration: "none" }} title="What-if scenarios, base vs scenario diff, exports & approvals">Scenarios</a>
          <a href="/planning/data-quality" style={{ ...S.btnSecondary, textDecoration: "none" }}>Data quality</a>
          <a href="/" style={{ ...S.btnSecondary, textDecoration: "none" }}>Back to PLM</a>
        </div>
      </div>

      <div style={S.content}>
        <StaleDataBanner
          watch={["shopify_orders", "shopify_products", "ecom_forecast"]}
          dismissKey="ecom_workbench"
        />
        <PlanningRunControls
          runs={runs}
          selectedRunId={selectedRunId}
          onSelect={(id) => setSelectedRunId(id)}
          onChange={refreshAll}
          onToast={(t) => setToast(t)}
          scope="ecom"
          showBuild={false}
        />

        <div style={{ ...S.card, display: "flex", gap: 10, alignItems: "center" }}>
          <strong style={{ color: PAL.text, fontSize: 13 }}>Ecom pipeline:</strong>
          <button style={S.btnSecondary} onClick={ingestShopify} disabled={ingesting}>
            {ingesting ? "Ingesting…" : "Ingest Shopify raw → normalized"}
          </button>
          <button style={S.btnPrimary} onClick={buildForecast} disabled={building || !selectedRun}>
            {building ? "Building…" : "Build ecom forecast"}
          </button>
          <span style={{ color: PAL.textMuted, fontSize: 12 }}>
            Ingest reads raw_shopify_payloads; Build reads ip_sales_history_ecom.
          </span>
        </div>

        <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
          <TabButton active={tab === "grid"} onClick={() => setTab("grid")}>Grid</TabButton>
          <TabButton active={tab === "chart"} onClick={() => setTab("chart")}>Chart</TabButton>
        </div>

        {tab === "grid" && (
          <EcomPlanningGrid rows={rows} loading={loading} onSelectRow={setSelectedRow} onUpdateBuyQty={saveBuyQty} />
        )}
        {tab === "chart" && (
          <EcomForecastChart run={selectedRun} row={selectedRow} />
        )}
      </div>

      {selectedRow && tab === "grid" && (
        <EcomOverrideDrawer
          row={selectedRow}
          overrides={overridesForRow}
          onClose={() => setSelectedRow(null)}
          onSaveOverride={saveOverride}
          onToggleFlag={toggleFlag}
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
