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
  IpFutureDemandRequest,
  IpOverrideReasonCode,
  IpPlannerOverride,
  IpPlanningGridRow,
  IpPlanningRun,
  IpWholesaleForecast,
} from "../types/wholesale";
import { wholesaleRepo } from "../services/wholesalePlanningRepository";
import { applyOverride, buildGridRows } from "../services/wholesaleForecastService";
import { S, PAL } from "../components/styles";
import { SB_HEADERS, SB_URL } from "../../utils/supabase";
import PlanningRunControls from "./PlanningRunControls";
import WholesalePlanningGrid from "./WholesalePlanningGrid";
import FutureDemandRequestsPanel from "./FutureDemandRequestsPanel";
import ForecastDetailDrawer from "../components/ForecastDetailDrawer";
import Toast, { type ToastMessage } from "../components/Toast";

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
  }, [selectedRunId]);

  const overridesForRow = useMemo(() => {
    if (!selectedRow) return [];
    return overrides.filter(
      (o) => o.customer_id === selectedRow.customer_id &&
             o.sku_id === selectedRow.sku_id &&
             o.period_start === selectedRow.period_start,
    );
  }, [overrides, selectedRow]);

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
          <a href="/planning/data-quality" style={{ ...S.btnSecondary, textDecoration: "none" }}>Data quality →</a>
          <a href="/" style={{ ...S.btnSecondary, textDecoration: "none" }}>Back to PLM</a>
        </div>
      </div>

      <div style={S.content}>
        <PlanningRunControls
          runs={runs}
          selectedRunId={selectedRunId}
          onSelect={(id) => setSelectedRunId(id)}
          onChange={refreshAll}
          onToast={(t) => setToast(t)}
        />

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

