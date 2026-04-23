// Parent page for Phase 3. Mounts at /planning/supply via main.tsx.
//
// Layout:
//   1. Run selector + new-reconciliation-run modal (pick wholesale + ecom sources)
//   2. Build pass button
//   3. Tabs: Reconciliation grid · Exceptions
//   4. Detail drawer on row select
//
// Reuses Toast + styles. Does not touch Phases 1/2 tables — only reads
// demand.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { IpItem } from "../../types/entities";
import type { IpPlanningRun } from "../../types/wholesale";
import type {
  IpAllocationRule,
  IpInventoryRecommendation,
  IpReconciliationGridRow,
  IpSupplyException,
} from "../types/supply";
import { wholesaleRepo } from "../../services/wholesalePlanningRepository";
import { supplyRepo, buildReconciliationGrid, runReconciliationPass } from "../services";
import { S, PAL, formatDate } from "../../components/styles";
import Toast, { type ToastMessage } from "../../components/Toast";
import StaleDataBanner from "../../shared/components/StaleDataBanner";
import ReconciliationGrid from "./ReconciliationGrid";
import SupplyExceptionPanel from "./SupplyExceptionPanel";
import AllocationDetailDrawer from "../components/AllocationDetailDrawer";

type TabKey = "grid" | "exceptions";

export default function ReconciliationWorkbench() {
  const [runs, setRuns] = useState<IpPlanningRun[]>([]);
  const [wholesaleRuns, setWholesaleRuns] = useState<IpPlanningRun[]>([]);
  const [ecomRuns, setEcomRuns] = useState<IpPlanningRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [rows, setRows] = useState<IpReconciliationGridRow[]>([]);
  const [exceptions, setExceptions] = useState<IpSupplyException[]>([]);
  const [rules, setRules] = useState<IpAllocationRule[]>([]);
  const [recs, setRecs] = useState<IpInventoryRecommendation[]>([]);
  const [items, setItems] = useState<IpItem[]>([]);
  const [tab, setTab] = useState<TabKey>("grid");
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [showNewRun, setShowNewRun] = useState(false);
  const [selectedRow, setSelectedRow] = useState<IpReconciliationGridRow | null>(null);

  const selectedRun = useMemo(() => runs.find((r) => r.id === selectedRunId) ?? null, [runs, selectedRunId]);

  const skuCodeById = useMemo(() => new Map(items.map((i) => [i.id, i.sku_code])), [items]);

  const loadRuns = useCallback(async () => {
    const [all, ws, es] = await Promise.all([
      wholesaleRepo.listPlanningRuns("all"),
      wholesaleRepo.listPlanningRuns("wholesale"),
      wholesaleRepo.listPlanningRuns("ecom"),
    ]);
    setRuns(all);
    setWholesaleRuns(ws);
    setEcomRuns(es);
    if (!selectedRunId && all.length > 0) {
      const active = all.find((r) => r.status === "active") ?? all[0];
      setSelectedRunId(active.id);
    }
  }, [selectedRunId]);

  const loadRunData = useCallback(async () => {
    if (!selectedRun) { setRows([]); setExceptions([]); setRecs([]); return; }
    const [grid, exc, recList] = await Promise.all([
      buildReconciliationGrid(selectedRun),
      supplyRepo.listExceptions(selectedRun.id),
      supplyRepo.listRecommendations(selectedRun.id),
    ]);
    setRows(grid);
    setExceptions(exc);
    setRecs(recList);
  }, [selectedRun]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [its, rs] = await Promise.all([
        wholesaleRepo.listItems(),
        supplyRepo.listAllRules(),
      ]);
      setItems(its);
      setRules(rs);
      await loadRuns();
      await loadRunData();
    } catch (e) {
      setToast({ text: "Load failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally {
      setLoading(false);
    }
  }, [loadRuns, loadRunData]);

  useEffect(() => { void refresh(); /* eslint-disable-line */ }, []);
  useEffect(() => { if (selectedRun) void loadRunData(); /* eslint-disable-line */ }, [selectedRunId]);

  async function runPass() {
    if (!selectedRun) { setToast({ text: "Pick a run first", kind: "error" }); return; }
    setBuilding(true);
    try {
      const r = await runReconciliationPass(selectedRun);
      setToast({
        text: `Reconciled ${r.projected_rows} rows · ${r.recommendations} recs · ${r.exceptions} exceptions`,
        kind: "success",
      });
      await loadRunData();
    } catch (e) {
      setToast({ text: "Reconciliation failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally {
      setBuilding(false);
    }
  }

  const demandForSelected = useMemo(() => {
    // Without re-running compute we don't have the fine-grained demand
    // breakdown available in the grid row. The drawer will just show
    // the totals in that case — good enough for MVP.
    return undefined;
  }, [selectedRow?.projected_id]);

  return (
    <div style={S.app}>
      <div style={S.nav}>
        <div style={S.navLeft}>
          <div style={S.navLogo}>IP</div>
          <div>
            <div style={S.navTitle}>Demand & Inventory Planning</div>
            <div style={S.navSub}>Supply reconciliation · Phase 3</div>
          </div>
        </div>
        <div style={S.navRight}>
          <a href="/planning/wholesale" style={{ ...S.btnSecondary, textDecoration: "none" }}>Wholesale</a>
          <a href="/planning/ecom" style={{ ...S.btnSecondary, textDecoration: "none" }}>Ecom</a>
          <a href="/planning/accuracy" style={{ ...S.btnSecondary, textDecoration: "none" }}>Accuracy</a>
          <a href="/planning/scenarios" style={{ ...S.btnSecondary, textDecoration: "none" }}>Scenarios →</a>
          <a href="/planning/data-quality" style={{ ...S.btnSecondary, textDecoration: "none" }}>DQ</a>
          <a href="/" style={{ ...S.btnSecondary, textDecoration: "none" }}>Back to PLM</a>
        </div>
      </div>

      <div style={S.content}>
        <StaleDataBanner
          watch={["xoro_inventory", "xoro_open_pos", "planning_run", "wholesale_forecast", "ecom_forecast"]}
          dismissKey="supply_workbench"
        />
        <div style={{ ...S.card, marginBottom: 12 }}>
          <div style={S.toolbar}>
            <strong style={{ color: PAL.text, fontSize: 14 }}>Reconciliation run</strong>
            <select style={S.select} value={selectedRunId ?? ""} onChange={(e) => setSelectedRunId(e.target.value)}>
              <option value="">— pick —</option>
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} · {r.status} · {formatDate(r.horizon_start)}–{formatDate(r.horizon_end)}
                </option>
              ))}
            </select>
            <button style={S.btnSecondary} onClick={() => setShowNewRun(true)}>+ New reconciliation run</button>
            <button style={S.btnPrimary} onClick={runPass} disabled={building || !selectedRun}>
              {building ? "Reconciling…" : "Run reconciliation"}
            </button>
          </div>
          {selectedRun && (
            <div style={{ color: PAL.textMuted, fontSize: 12 }}>
              Snapshot {formatDate(selectedRun.source_snapshot_date)} ·
              wholesale source {selectedRun.wholesale_source_run_id ? selectedRun.wholesale_source_run_id.slice(0, 8) : "—"} ·
              ecom source {selectedRun.ecom_source_run_id ? selectedRun.ecom_source_run_id.slice(0, 8) : "—"}
            </div>
          )}
        </div>

        <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
          <TabButton active={tab === "grid"} onClick={() => setTab("grid")}>Reconciliation grid</TabButton>
          <TabButton active={tab === "exceptions"} onClick={() => setTab("exceptions")}>
            Exceptions ({exceptions.length})
          </TabButton>
        </div>

        {tab === "grid" && (
          <ReconciliationGrid rows={rows} loading={loading} onSelectRow={setSelectedRow} />
        )}
        {tab === "exceptions" && (
          <SupplyExceptionPanel exceptions={exceptions} skuCodeById={skuCodeById} />
        )}
      </div>

      {selectedRow && (
        <AllocationDetailDrawer
          row={selectedRow}
          rules={rules}
          recommendations={recs}
          demand={demandForSelected}
          onClose={() => setSelectedRow(null)}
        />
      )}

      {showNewRun && (
        <NewReconciliationRunModal
          wholesaleRuns={wholesaleRuns}
          ecomRuns={ecomRuns}
          onClose={() => setShowNewRun(false)}
          onCreated={async (id) => {
            setShowNewRun(false);
            setSelectedRunId(id);
            setToast({ text: "Reconciliation run created", kind: "success" });
            await refresh();
          }}
          onToast={(t) => setToast(t)}
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

// ── New reconciliation run modal ───────────────────────────────────────────

function NewReconciliationRunModal({
  wholesaleRuns, ecomRuns, onClose, onCreated, onToast,
}: {
  wholesaleRuns: IpPlanningRun[];
  ecomRuns: IpPlanningRun[];
  onClose: () => void;
  onCreated: (id: string) => Promise<void>;
  onToast: (t: ToastMessage) => void;
}) {
  const today = new Date();
  const yyyy = today.getUTCFullYear();
  const mm = String(today.getUTCMonth() + 1).padStart(2, "0");
  const [name, setName] = useState(`Recon — ${yyyy}-${mm}`);
  const [wholesaleId, setWholesaleId] = useState<string>(wholesaleRuns.find((r) => r.status === "active")?.id ?? wholesaleRuns[0]?.id ?? "");
  const [ecomId, setEcomId] = useState<string>(ecomRuns.find((r) => r.status === "active")?.id ?? ecomRuns[0]?.id ?? "");
  const [snapshot, setSnapshot] = useState(today.toISOString().slice(0, 10));
  const [horizonStart, setHorizonStart] = useState(`${yyyy}-${mm}-01`);
  const [horizonEnd, setHorizonEnd] = useState(new Date(Date.UTC(yyyy, today.getUTCMonth() + 5, 0)).toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!name.trim()) { onToast({ text: "Name is required", kind: "error" }); return; }
    if (!wholesaleId && !ecomId) {
      onToast({ text: "Pick at least one source run (wholesale or ecom)", kind: "error" });
      return;
    }
    if (horizonEnd < horizonStart) { onToast({ text: "Horizon end is before start", kind: "error" }); return; }
    setSaving(true);
    try {
      const r = await wholesaleRepo.createPlanningRun({
        name: name.trim(),
        planning_scope: "all",
        status: "draft",
        source_snapshot_date: snapshot,
        horizon_start: horizonStart,
        horizon_end: horizonEnd,
        forecast_method_preference: "ly_sales",
        wholesale_source_run_id: wholesaleId || null,
        ecom_source_run_id: ecomId || null,
        note: note.trim() || null,
        created_by: null,
      });
      await onCreated(r.id);
    } catch (e) {
      onToast({ text: "Couldn't create run — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={S.drawerOverlay} onClick={onClose}>
      <div style={S.drawer} onClick={(e) => e.stopPropagation()}>
        <div style={S.drawerHeader}>
          <h3 style={{ margin: 0, fontSize: 16 }}>New reconciliation run</h3>
          <button style={S.btnGhost} onClick={onClose}>✕</button>
        </div>
        <div style={S.drawerBody}>
          <div style={{ display: "grid", gap: 10 }}>
            <div>
              <label style={S.label}>Name</label>
              <input style={{ ...S.input, width: "100%" }} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <label style={S.label}>Wholesale source run</label>
              <select style={{ ...S.select, width: "100%" }} value={wholesaleId} onChange={(e) => setWholesaleId(e.target.value)}>
                <option value="">— none —</option>
                {wholesaleRuns.map((r) => (
                  <option key={r.id} value={r.id}>{r.name} · {r.status}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={S.label}>Ecom source run</label>
              <select style={{ ...S.select, width: "100%" }} value={ecomId} onChange={(e) => setEcomId(e.target.value)}>
                <option value="">— none —</option>
                {ecomRuns.map((r) => (
                  <option key={r.id} value={r.id}>{r.name} · {r.status}</option>
                ))}
              </select>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div>
                <label style={S.label}>Horizon start</label>
                <input type="date" style={{ ...S.input, width: "100%" }} value={horizonStart}
                       onChange={(e) => setHorizonStart(e.target.value)} />
              </div>
              <div>
                <label style={S.label}>Horizon end</label>
                <input type="date" style={{ ...S.input, width: "100%" }} value={horizonEnd}
                       onChange={(e) => setHorizonEnd(e.target.value)} />
              </div>
              <div>
                <label style={S.label}>Snapshot date</label>
                <input type="date" style={{ ...S.input, width: "100%" }} value={snapshot}
                       onChange={(e) => setSnapshot(e.target.value)} />
              </div>
            </div>
            <div>
              <label style={S.label}>Note</label>
              <input style={{ ...S.input, width: "100%" }} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
              <button style={S.btnSecondary} onClick={onClose}>Cancel</button>
              <button style={S.btnPrimary} onClick={save} disabled={saving}>
                {saving ? "Creating…" : "Create run"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
