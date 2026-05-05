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
import { TabButton } from "../../components/TabButton";
import Toast, { type ToastMessage } from "../../components/Toast";
import StaleDataBanner from "../../shared/components/StaleDataBanner";
import SystemHealthBanner from "../../shared/components/SystemHealthBanner";
import ReconciliationGrid from "./ReconciliationGrid";
import SupplyExceptionPanel from "./SupplyExceptionPanel";
import AllocationDetailPanel from "../components/AllocationDetailPanel";

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

  // Initial mount: masters + runs only. Don't call refresh — its
  // trailing loadRunData() races the [selectedRunId] effect's
  // loadRunData() once setSelectedRunId propagates. Same fix pattern
  // as WholesalePlanningWorkbench.
  useEffect(() => {
    setLoading(true);
    (async () => {
      try {
        const [its, rs] = await Promise.all([wholesaleRepo.listItems(), supplyRepo.listAllRules()]);
        setItems(its);
        setRules(rs);
        await loadRuns();
      } catch (e) {
        setToast({ text: "Load failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!selectedRun) return;
    setLoading(true);
    loadRunData()
      .catch((e) => setToast({ text: "Load failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" }))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRunId]);

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

  // Inline toggle for the planned-buys flag — kept here on the
  // header card (not buried inside a modal) so the planner can flip
  // it on an existing run and re-reconcile without spinning up a
  // new run. Persists via wholesaleRepo.updatePlanningRun.
  async function toggleIncludePlannedBuys(next: boolean) {
    if (!selectedRun) return;
    try {
      const updated = await wholesaleRepo.updatePlanningRun(selectedRun.id, {
        recon_include_planned_buys: next,
      });
      setRuns((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
      setToast({
        text: next
          ? "Planned buys will now count as inbound supply on the next recon."
          : "Planned buys will be excluded from supply on the next recon.",
        kind: "success",
      });
    } catch (e) {
      setToast({ text: "Toggle failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
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
        <SystemHealthBanner />
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
            <button style={S.btnSecondary} onClick={() => setShowNewRun((v) => !v)}>
              {showNewRun ? "Cancel new run" : "+ New reconciliation run"}
            </button>
            <button style={S.btnPrimary} onClick={runPass} disabled={building || !selectedRun}>
              {building ? "Reconciling…" : "Run reconciliation"}
            </button>
          </div>
          {/* Inline create-run form. Same place the request panel
              opens its "+ New request" form — no overlay/drawer. */}
          {showNewRun && (
            <NewReconciliationRunForm
              wholesaleRuns={wholesaleRuns}
              ecomRuns={ecomRuns}
              onCancel={() => setShowNewRun(false)}
              onCreated={async (id) => {
                setShowNewRun(false);
                setSelectedRunId(id);
                setToast({ text: "Reconciliation run created", kind: "success" });
                await refresh();
              }}
              onToast={(t) => setToast(t)}
            />
          )}
          {selectedRun && (
            <>
              <div style={{ color: PAL.textMuted, fontSize: 12 }}>
                Snapshot {formatDate(selectedRun.source_snapshot_date)} ·
                wholesale source {selectedRun.wholesale_source_run_id ? selectedRun.wholesale_source_run_id.slice(0, 8) : "—"} ·
                ecom source {selectedRun.ecom_source_run_id ? selectedRun.ecom_source_run_id.slice(0, 8) : "—"}
              </div>
              {/* Inline toggle: count Phase 1 planned_buy_qty as
                  inbound supply on the next recon. Editable here on the
                  active run instead of a separate dialog so the planner
                  can flip + re-reconcile in two clicks. */}
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 8, fontSize: 12, color: PAL.text, cursor: "pointer", userSelect: "none" }}>
                <input
                  type="checkbox"
                  checked={!!selectedRun.recon_include_planned_buys}
                  onChange={(e) => void toggleIncludePlannedBuys(e.target.checked)}
                />
                <span>Count planned wholesale buys as inbound supply</span>
                <span style={{ color: PAL.textMuted, fontSize: 11 }}>
                  (treats Phase 1 typed Buy qty as committed for this run; re-run reconciliation to apply)
                </span>
              </label>
            </>
          )}
        </div>

        <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
          <TabButton active={tab === "grid"} onClick={() => setTab("grid")}>Reconciliation grid</TabButton>
          <TabButton active={tab === "exceptions"} onClick={() => setTab("exceptions")}>
            Exceptions ({exceptions.length})
          </TabButton>
        </div>

        {tab === "grid" && (
          <>
            <ReconciliationGrid rows={rows} loading={loading} onSelectRow={setSelectedRow} />
            {/* Inline detail panel — renders below the grid when a
                row is selected. Replaces the previous side drawer
                so the planner keeps grid context visible while
                reading the breakdown (matches the request panel's
                no-drawer convention). */}
            {selectedRow && (
              <AllocationDetailPanel
                row={selectedRow}
                rules={rules}
                recommendations={recs}
                demand={demandForSelected}
                onClose={() => setSelectedRow(null)}
              />
            )}
          </>
        )}
        {tab === "exceptions" && (
          <SupplyExceptionPanel exceptions={exceptions} skuCodeById={skuCodeById} />
        )}
      </div>

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}


// ── Inline new-reconciliation-run form ─────────────────────────────────────
// Inline-form layout, matching the request panel's "+ New request"
// pattern. Renders inside the run-picker card; no overlay or drawer.

function NewReconciliationRunForm({
  wholesaleRuns, ecomRuns, onCancel, onCreated, onToast,
}: {
  wholesaleRuns: IpPlanningRun[];
  ecomRuns: IpPlanningRun[];
  onCancel: () => void;
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
        // Default off; planner can flip the inline toggle on the
        // workbench header before running reconciliation.
        recon_include_planned_buys: false,
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
    <div style={{
      marginTop: 12,
      padding: 12,
      background: PAL.panelAlt ?? PAL.panel,
      border: `1px solid ${PAL.accent}`,
      borderRadius: 8,
      display: "flex",
      flexWrap: "wrap" as const,
      alignItems: "center",
      gap: 10,
      fontSize: 12,
    }}>
      <span style={{ fontWeight: 600, color: PAL.accent }}>+ New run</span>

      <span style={{ color: PAL.textMuted, fontSize: 11 }}>Name:</span>
      <input style={{ ...S.input, width: 220, fontSize: 12, padding: "4px 8px" }}
             value={name} onChange={(e) => setName(e.target.value)} />

      <span style={{ color: PAL.textMuted, fontSize: 11 }}>Wholesale source:</span>
      <select style={{ ...S.select, fontSize: 12, padding: "4px 8px" }}
              value={wholesaleId} onChange={(e) => setWholesaleId(e.target.value)}>
        <option value="">— none —</option>
        {wholesaleRuns.map((r) => (
          <option key={r.id} value={r.id}>{r.name} · {r.status}</option>
        ))}
      </select>

      <span style={{ color: PAL.textMuted, fontSize: 11 }}>Ecom source:</span>
      <select style={{ ...S.select, fontSize: 12, padding: "4px 8px" }}
              value={ecomId} onChange={(e) => setEcomId(e.target.value)}>
        <option value="">— none —</option>
        {ecomRuns.map((r) => (
          <option key={r.id} value={r.id}>{r.name} · {r.status}</option>
        ))}
      </select>

      <span style={{ color: PAL.textMuted, fontSize: 11 }}>Horizon:</span>
      <input type="date" style={{ ...S.input, width: 130, fontSize: 12, padding: "4px 8px" }}
             value={horizonStart} onChange={(e) => setHorizonStart(e.target.value)} />
      <span style={{ color: PAL.textMuted, fontSize: 11 }}>→</span>
      <input type="date" style={{ ...S.input, width: 130, fontSize: 12, padding: "4px 8px" }}
             value={horizonEnd} onChange={(e) => setHorizonEnd(e.target.value)} />

      <span style={{ color: PAL.textMuted, fontSize: 11 }}>Snapshot:</span>
      <input type="date" style={{ ...S.input, width: 130, fontSize: 12, padding: "4px 8px" }}
             value={snapshot} onChange={(e) => setSnapshot(e.target.value)} />

      <input style={{ ...S.input, minWidth: 160, fontSize: 12, padding: "4px 8px" }}
             value={note} placeholder="Note (optional)"
             onChange={(e) => setNote(e.target.value)} />

      <button
        type="button"
        onClick={save}
        disabled={saving}
        style={{
          ...S.btnPrimary,
          padding: "5px 14px",
          fontSize: 12,
          opacity: saving ? 0.5 : 1,
          cursor: saving ? "not-allowed" : "pointer",
        }}
      >
        {saving ? "Creating…" : "Create run"}
      </button>
      <button type="button" onClick={onCancel} style={{ ...S.btnSecondary, padding: "5px 10px", fontSize: 12 }}>
        Cancel
      </button>
    </div>
  );
}
