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
import type { IpPlanningRun, IpSupplySource } from "../../types/wholesale";
import type {
  IpAllocationRule,
  IpInventoryRecommendation,
  IpReconciliationGridRow,
  IpSupplyException,
} from "../types/supply";
import { wholesaleRepo } from "../../services/wholesalePlanningRepository";
import { supplyRepo, buildReconciliationGrid, runReconciliationPass, syncTangerineSupply } from "../services";
import { can } from "../../governance/services/permissionService";
import { useCurrentUser } from "../../shared/hooks/useCurrentUser";
import { S, PAL, formatDate } from "../../components/styles";
import { TabButton } from "../../components/TabButton";
import Toast, { type ToastMessage } from "../../components/Toast";
import { AppDatePicker } from "../../../shared/components/AppDatePicker";
import SystemHealthBanner from "../../shared/components/SystemHealthBanner";
import SearchableSelect from "../../../tanda/components/SearchableSelect";
import { confirmDialog } from "../../../shared/ui/warn";
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
  const [syncing, setSyncing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const user = useCurrentUser();
  const canSync = user ? can(user, "manage_integrations") : false;

  const selectedRun = useMemo(() => runs.find((r) => r.id === selectedRunId) ?? null, [runs, selectedRunId]);

  const skuCodeById = useMemo(() => new Map(items.map((i) => [i.id, i.sku_code])), [items]);

  // Deep-link from the Forecast page's "Reconcile against supply first →"
  // button: /planning/supply?fromRunId=<wholesale demand run>. The demand run
  // is a scope='wholesale' run, not a reconciliation run, so it can't be
  // *selected* in the recon picker (which lists scope='all' runs). Instead we
  // surface a guidance banner and pre-open the new-run form with this run
  // pre-picked as the wholesale source.
  const fromRunId = useMemo(() => {
    try { return new URLSearchParams(window.location.search).get("fromRunId"); } catch { return null; }
  }, []);
  const fromRun = useMemo(() => wholesaleRuns.find((r) => r.id === fromRunId) ?? null, [wholesaleRuns, fromRunId]);
  const [autoOpenedFromLink, setAutoOpenedFromLink] = useState(false);
  useEffect(() => {
    if (fromRunId && fromRun && !autoOpenedFromLink) {
      setShowNewRun(true);
      setAutoOpenedFromLink(true);
    }
  }, [fromRunId, fromRun, autoOpenedFromLink]);

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

  // Permanently delete the selected reconciliation run. CASCADE wipes only
  // THIS run's data — its projected inventory, buy recommendations and supply
  // exceptions. The wholesale / ecom demand runs it sources from are separate
  // ip_planning_runs rows and are NOT touched. A run that already has
  // execution batches is RESTRICTed by the DB, which we surface plainly.
  async function deleteRun() {
    if (!selectedRun) return;
    const ok = await confirmDialog(
      `Permanently DELETE reconciliation run "${selectedRun.name}"?\n\n` +
      `This removes this run and its reconciliation output — projected inventory, ` +
      `buy recommendations and supply exceptions. It cannot be undone.\n\n` +
      `Your wholesale / ecom demand plans are separate runs and are NOT affected — ` +
      `only this reconciliation is deleted.\n\n` +
      `(A run that already has execution batches can't be deleted — remove those in the Execution screen first.)`,
      { title: "Delete reconciliation run", confirmText: "Delete run" },
    );
    if (!ok) return;
    setDeleting(true);
    try {
      await wholesaleRepo.deletePlanningRun(selectedRun.id);
      setToast({ text: `Deleted reconciliation run "${selectedRun.name}"`, kind: "info" });
      setSelectedRunId(null);
      setRows([]);
      setExceptions([]);
      setRecs([]);
      setSelectedRow(null);
      await loadRuns();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setToast({
        text: /23503|foreign key|violates/i.test(msg)
          ? "Can't delete — this run has execution batches. Delete them in the Execution screen first."
          : "Delete failed — " + msg,
        kind: "error",
      });
    } finally {
      setDeleting(false);
    }
  }

  // M31 dir-B: pull native Tangerine on-hand + open POs into the planning
  // supply tables (source='tangerine'). A run with supply_source='tangerine'
  // then reconciles against this. Global sync (not per-run); re-run
  // reconciliation afterward to apply.
  async function syncTangerine() {
    setSyncing(true);
    try {
      const r = await syncTangerineSupply("all");
      setToast({ text: r.message || "Tangerine supply synced", kind: "success" });
    } catch (e) {
      setToast({ text: "Tangerine sync failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally {
      setSyncing(false);
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
      <div style={S.content}>
        <SystemHealthBanner />
        <div style={{ ...S.card, marginBottom: 12 }}>
          <div style={S.toolbar}>
            <strong style={{ color: PAL.text, fontSize: 14 }}>Reconciliation run</strong>
            <SearchableSelect value={selectedRunId || null} onChange={(v) => setSelectedRunId(v)} inputStyle={S.select}
              options={[{ value: "", label: "— pick —" }, ...runs.map((r) => ({ value: r.id, label: `${r.name} · ${r.status} · ${formatDate(r.horizon_start)}–${formatDate(r.horizon_end)}` }))]} />
            <button style={S.btnSecondary} onClick={() => setShowNewRun((v) => !v)}>
              {showNewRun ? "Cancel new run" : "+ New reconciliation run"}
            </button>
            <button style={S.btnPrimary} onClick={runPass} disabled={building || !selectedRun}>
              {building ? "Reconciling…" : "Run reconciliation"}
            </button>
            <button style={{ ...S.btnSecondary, background: "#EA580C22", color: "#EA580C", borderColor: "#EA580C" }}
                    onClick={syncTangerine} disabled={syncing || !canSync}
                    title={canSync ? "Pull native Tangerine on-hand + open POs into the planning supply tables (for 'Tangerine ERP' runs)" : "Missing permission: manage_integrations"}>
              {syncing ? "Syncing…" : "Sync Tangerine supply"}
            </button>
            {selectedRun && (
              <button style={{ ...S.btnSecondary, color: PAL.red, borderColor: PAL.red }}
                      onClick={deleteRun} disabled={deleting || building}
                      title="Permanently delete this reconciliation run and its output. Your demand plans are not affected.">
                {deleting ? "Deleting…" : "Delete run"}
              </button>
            )}
          </div>
          {/* Inline create-run form. Same place the request panel
              opens its "+ New request" form — no overlay/drawer. */}
          {showNewRun && (
            <NewReconciliationRunForm
              wholesaleRuns={wholesaleRuns}
              ecomRuns={ecomRuns}
              initialWholesaleId={fromRun?.id}
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
              <div style={{ color: PAL.textMuted, fontSize: 12, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span>Snapshot {formatDate(selectedRun.source_snapshot_date)} ·
                wholesale source {selectedRun.wholesale_source_run_id ? (wholesaleRuns.find((r) => r.id === selectedRun.wholesale_source_run_id)?.name ?? "—") : "—"} ·
                ecom source {selectedRun.ecom_source_run_id ? (ecomRuns.find((r) => r.id === selectedRun.ecom_source_run_id)?.name ?? "—") : "—"}</span>
                <span style={{ ...S.chip,
                  background: (selectedRun.supply_source === "tangerine" ? "#EA580C" : PAL.accent) + "22",
                  color: selectedRun.supply_source === "tangerine" ? "#EA580C" : PAL.accent }}>
                  supply: {selectedRun.supply_source === "tangerine" ? "Tangerine ERP" : "Xoro / ATS mirror"}
                </span>
                {selectedRun.supply_source === "tangerine" && (
                  <span style={{ color: PAL.textMuted, fontSize: 11 }}>(run Sync Tangerine supply, then reconcile)</span>
                )}
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

        {fromRunId && (
          <div style={{
            ...S.card, marginBottom: 12, padding: "10px 14px",
            border: `1px solid ${PAL.accent}`, background: `${PAL.accent}14`,
            color: PAL.text, fontSize: 13, lineHeight: 1.5,
          }}>
            Reconciling demand run <strong>{fromRun?.name ?? fromRunId}</strong> against supply.
            When you&apos;re done, <strong>Run reconciliation</strong> writes buy recommendations you can take to the Buy plan.
          </div>
        )}

        <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
          <TabButton active={tab === "grid"} onClick={() => setTab("grid")}>Reconciliation grid</TabButton>
          <TabButton active={tab === "exceptions"} onClick={() => setTab("exceptions")}>
            Exceptions ({exceptions.length})
          </TabButton>
        </div>

        {tab === "grid" && (
          <>
            {!loading && rows.length === 0 ? (
              <ReconciliationEmptyState />
            ) : (
              <ReconciliationGrid rows={rows} loading={loading} onSelectRow={setSelectedRow} />
            )}
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
  wholesaleRuns, ecomRuns, initialWholesaleId, onCancel, onCreated, onToast,
}: {
  wholesaleRuns: IpPlanningRun[];
  ecomRuns: IpPlanningRun[];
  // When arriving via the Forecast deep-link, pre-pick this run as the
  // wholesale source so the planner doesn't have to hunt for it.
  initialWholesaleId?: string;
  onCancel: () => void;
  onCreated: (id: string) => Promise<void>;
  onToast: (t: ToastMessage) => void;
}) {
  const today = new Date();
  const yyyy = today.getUTCFullYear();
  const mm = String(today.getUTCMonth() + 1).padStart(2, "0");
  const [name, setName] = useState(`Recon — ${yyyy}-${mm}`);
  const [wholesaleId, setWholesaleId] = useState<string>(
    (initialWholesaleId && wholesaleRuns.some((r) => r.id === initialWholesaleId) ? initialWholesaleId : null)
    ?? wholesaleRuns.find((r) => r.status === "active")?.id ?? wholesaleRuns[0]?.id ?? "");
  const [ecomId, setEcomId] = useState<string>(ecomRuns.find((r) => r.status === "active")?.id ?? ecomRuns[0]?.id ?? "");
  const [snapshot, setSnapshot] = useState(today.toISOString().slice(0, 10));
  const [supplySource, setSupplySource] = useState<IpSupplySource>("xoro");
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
        supply_source: supplySource,
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
      <SearchableSelect value={wholesaleId || null} onChange={(v) => setWholesaleId(v)} inputStyle={{ ...S.select, fontSize: 12, padding: "4px 8px" }}
        options={[{ value: "", label: "— none —" }, ...wholesaleRuns.map((r) => ({ value: r.id, label: `${r.name} · ${r.status}` }))]} />

      <span style={{ color: PAL.textMuted, fontSize: 11 }}>Ecom source:</span>
      <SearchableSelect value={ecomId || null} onChange={(v) => setEcomId(v)} inputStyle={{ ...S.select, fontSize: 12, padding: "4px 8px" }}
        options={[{ value: "", label: "— none —" }, ...ecomRuns.map((r) => ({ value: r.id, label: `${r.name} · ${r.status}` }))]} />

      <span style={{ color: PAL.textMuted, fontSize: 11 }}>Horizon:</span>
      <AppDatePicker style={{ ...S.input, width: 130, fontSize: 12, padding: "4px 8px" }} value={horizonStart} onCommit={setHorizonStart} />
      <span style={{ color: PAL.textMuted, fontSize: 11 }}>→</span>
      <AppDatePicker style={{ ...S.input, width: 130, fontSize: 12, padding: "4px 8px" }} value={horizonEnd} onCommit={setHorizonEnd} />

      <span style={{ color: PAL.textMuted, fontSize: 11 }}>Snapshot:</span>
      <AppDatePicker style={{ ...S.input, width: 130, fontSize: 12, padding: "4px 8px" }} value={snapshot} onCommit={setSnapshot} />

      <span style={{ color: PAL.textMuted, fontSize: 11 }}>Supply source:</span>
      <div title="Where on-hand + open POs come from: the Xoro/ATS mirror (default) or native Tangerine ERP">
        <SearchableSelect value={supplySource} onChange={(v) => setSupplySource(v as IpSupplySource)} inputStyle={{ ...S.select, fontSize: 12, padding: "4px 8px" }} options={[
          { value: "xoro", label: "Xoro / ATS mirror" },
          { value: "tangerine", label: "Tangerine ERP" },
        ]} />
      </div>

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

// ── Empty-state explainer ──────────────────────────────────────────────────
// Shown in the grid tab when a run has produced no reconciliation output yet
// (or no run is selected). Explains what this screen does + the 3 actions, and
// tells planners who already finalized via "Finalize with my buys" that they
// can skip this screen entirely — their buy plan is already on Execution.
function ReconciliationEmptyState() {
  return (
    <div style={{ ...S.card, padding: 20, maxWidth: 720 }}>
      <div style={{ color: PAL.text, fontSize: 15, fontWeight: 700, marginBottom: 8 }}>
        Reconcile demand against supply
      </div>
      <div style={{ color: PAL.textDim, fontSize: 13, lineHeight: 1.6, marginBottom: 14 }}>
        This screen nets your demand plan against on-hand + inbound supply
        (open POs and receipts) and computes the recommended buys to cover the gap.
      </div>
      <ol style={{ margin: "0 0 14px 18px", padding: 0, color: PAL.textDim, fontSize: 13, lineHeight: 1.7 }}>
        <li>Create a reconciliation run — pick the wholesale / ecom demand runs to source from.</li>
        <li>Click <strong style={{ color: PAL.text }}>Run reconciliation</strong> to compute projected inventory and buy recommendations.</li>
        <li>Continue to the <strong style={{ color: PAL.text }}>Buy plan</strong> on the Execution screen.</li>
      </ol>
      <div style={{
        padding: "10px 12px", borderRadius: 8,
        background: `${PAL.yellow}12`, border: `1px solid ${PAL.yellow}44`,
        color: PAL.textDim, fontSize: 12.5, lineHeight: 1.6,
      }}>
        Already finalized your plan with <strong style={{ color: PAL.text }}>&quot;Finalize with my buys&quot;</strong> on
        the Forecast page? Skip this screen — your buy plan is ready on the{" "}
        <a href="/planning/execution" style={{ color: PAL.accent, textDecoration: "none", fontWeight: 600 }}>Execution screen</a>.
      </div>
    </div>
  );
}
