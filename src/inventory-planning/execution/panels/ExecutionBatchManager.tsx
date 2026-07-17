// Parent at /planning/execution. List batches + create new + detail.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IpCategory, IpItem } from "../../types/entities";
import type { IpPlanningRun } from "../../types/wholesale";
import type {
  IpErpWritebackConfig,
  IpExecutionAction,
  IpExecutionAuditEntry,
  IpExecutionBatch,
  IpExecutionBatchType,
} from "../types/execution";
import { wholesaleRepo } from "../../services/wholesalePlanningRepository";
import {
  buildExecutionBatchFromRecommendations,
  executionRepo,
  transitionBatch,
  type ExecutionExportNameMaps,
} from "../services";
import { supplyRepo } from "../../supply/services/supplyReconciliationRepo";
import { scenarioRepo } from "../../scenarios/services/scenarioRepo";
import type { IpScenario } from "../../scenarios/types/scenarios";
import { confirmDialog } from "../../../shared/ui/warn";
import { S, PAL, formatDate } from "../../components/styles";
import { useTablePrefs, TablePrefsButton, type ColumnDef } from "../../../tanda/components/TablePrefs";
import { useSort } from "../../../tanda/hooks/useSort";
import SortableTh from "../../../tanda/components/SortableTh";
import SearchableSelect from "../../../tanda/components/SearchableSelect";
import Toast, { type ToastMessage } from "../../components/Toast";
import ExecutionBatchDetail from "./ExecutionBatchDetail";
import ExecutionAuditPanel from "./ExecutionAuditPanel";
import SystemHealthBanner from "../../shared/components/SystemHealthBanner";

const BATCH_STATUS_COLOR: Record<string, string> = {
  draft:              "#94A3B8",
  ready:              "#3B82F6",
  approved:           "#10B981",
  exported:           "#3B82F6",
  submitted:          "#8B5CF6",
  partially_executed: "#F59E0B",
  executed:           "#10B981",
  failed:             "#EF4444",
  archived:           "#6B7280",
};

const BATCH_TYPES: IpExecutionBatchType[] = [
  "buy_plan", "expedite_plan", "reduce_plan", "cancel_plan",
  "reserve_update", "protection_update", "reallocation_plan",
];

const TABLE_KEY = "ip.execution_batches";
const ALL_COLUMNS: ColumnDef[] = [
  { key: "name", label: "Name" },
  { key: "type", label: "Type" },
  { key: "status", label: "Status" },
  { key: "created", label: "Created" },
  { key: "approved", label: "Approved" },
  { key: "note", label: "Note" },
];

export default function ExecutionBatchManager() {
  const [batches, setBatches] = useState<IpExecutionBatch[]>([]);
  const [runs, setRuns] = useState<IpPlanningRun[]>([]);
  const [items, setItems] = useState<IpItem[]>([]);
  const [categories, setCategories] = useState<IpCategory[]>([]);
  const [writebackConfig, setWritebackConfig] = useState<IpErpWritebackConfig[]>([]);
  const [nameMaps, setNameMaps] = useState<ExecutionExportNameMaps | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [actions, setActions] = useState<IpExecutionAction[]>([]);
  const [audit, setAudit] = useState<IpExecutionAuditEntry[]>([]);
  const [tab, setTab] = useState<"list" | "detail">("list");
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [newPrefillRunId, setNewPrefillRunId] = useState<string | null>(null);
  const [showAudit, setShowAudit] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const { visibleColumns, toggleColumn, setAllVisible, resetToDefault } = useTablePrefs(TABLE_KEY, ALL_COLUMNS);

  // Deep-link from WP1's "push planner buys": after a run is auto-approved the
  // wholesale workbench navigates here as
  //   /planning/execution?fromRunId=<uuid>&autoCreate=buy_plan
  // We receive that, build (or re-open) the buy-plan batch with no modal, move
  // it to 'ready', and land the planner on the Detail tab. Parsed once on mount.
  const [autoReq] = useState<{ fromRunId: string; autoCreate: string } | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const sp = new URLSearchParams(window.location.search);
      const fromRunId = sp.get("fromRunId");
      const autoCreate = sp.get("autoCreate");
      if (fromRunId && autoCreate === "buy_plan") return { fromRunId, autoCreate };
    } catch { /* ignore */ }
    return null;
  });
  const autoHandledRef = useRef(false);

  const selected = useMemo(() => batches.find((b) => b.id === selectedId) ?? null, [batches, selectedId]);
  const selectedRun = useMemo(() => runs.find((r) => r.id === selected?.planning_run_id) ?? null, [runs, selected]);

  // Additive per-column sort over the batch list (selection is keyed on id, so
  // re-ordering never disturbs the selected row).
  const { sorted: sortedBatches, sortKey, sortDir, onHeaderClick } = useSort(batches, {
    persistKey: "ip:execution_batches:sort",
    accessors: {
      name: (b) => b.batch_name,
      type: (b) => b.batch_type,
      status: (b) => b.status,
      created: (b) => b.created_at ?? "",
      approved: (b) => b.approved_at ?? "",
      note: (b) => b.note ?? "",
    },
  });

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [bs, rs, cfg, its, cats, nm] = await Promise.all([
        executionRepo.listBatches(),
        wholesaleRepo.listPlanningRuns("all"),
        executionRepo.listWritebackConfig("xoro"),
        wholesaleRepo.listItems(),
        wholesaleRepo.listCategories(),
        executionRepo.listNameMaps(),
      ]);
      const ws = await wholesaleRepo.listPlanningRuns("wholesale");
      const ec = await wholesaleRepo.listPlanningRuns("ecom");
      setBatches(bs);
      setRuns(Array.from(new Map([...rs, ...ws, ...ec].map((r) => [r.id, r])).values()));
      setWritebackConfig(cfg);
      setItems(its);
      setCategories(cats);
      setNameMaps(nm);
    } catch (e) {
      setToast({ text: "Load failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSelected = useCallback(async () => {
    if (!selected) { setActions([]); setAudit([]); return; }
    const [as, au] = await Promise.all([
      executionRepo.listActions(selected.id),
      executionRepo.listAudit(selected.id),
    ]);
    setActions(as);
    setAudit(au);
  }, [selected]);

  async function deleteSelectedBatch() {
    if (!selected) return;
    const ok = await confirmDialog(
      `Permanently DELETE execution batch "${selected.batch_name}" (${selected.status})?\n\n` +
      `This removes the batch and all its actions. It cannot be undone. ` +
      `Any Tangerine POs already created from it are NOT affected.`,
      { title: "Delete batch", confirmText: "Delete" },
    );
    if (!ok) return;
    try {
      await executionRepo.deleteBatch(selected.id);
      setSelectedId(null);
      setTab("list");
      setToast({ text: "Batch deleted", kind: "success" });
      await refresh();
    } catch (e) {
      setToast({ text: "Delete failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    }
  }

  // Strip the auto-create params so a refresh never re-triggers the build.
  function stripAutoParams() {
    if (typeof window === "undefined" || !window.history?.replaceState) return;
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("fromRunId");
      url.searchParams.delete("autoCreate");
      window.history.replaceState({}, "", url.toString());
    } catch { /* ignore */ }
  }

  const runAutoCreate = useCallback(async (fromRunId: string) => {
    stripAutoParams();

    // Idempotency: reuse a live buy-plan batch for this run instead of duplicating.
    const existing = batches.find(
      (b) => b.planning_run_id === fromRunId && b.batch_type === "buy_plan" && b.status !== "archived",
    );
    if (existing) {
      setSelectedId(existing.id);
      setTab("detail");
      setToast({ text: "Opened existing buy-plan batch for this run", kind: "success" });
      return;
    }

    // Nothing to build when the run carries no buy recommendations.
    try {
      const recs = await supplyRepo.listRecommendations(fromRunId);
      if (recs.length === 0) {
        setToast({ text: "Nothing to build — this run has no buy recommendations. Push planner buys first.", kind: "error" });
        return;
      }
    } catch { /* if the check fails, fall through and let the build surface the real error */ }

    const today = new Date().toISOString().slice(0, 10);
    try {
      const b = await buildExecutionBatchFromRecommendations({
        planning_run_id: fromRunId,
        batch_type: "buy_plan",
        batch_name: `Buy plan ${today}`,
        allowUnapproved: false,
      });
      try {
        await transitionBatch({ batch: b, to: "ready", message: "Auto-created from push planner buys" });
      } catch { /* leave in draft — the NextStep banner will prompt Move to ready */ }
      await refresh();
      setSelectedId(b.id);
      setTab("detail");
      setToast({ text: "Buy plan batch ready — next: approve it below.", kind: "success" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/approv/i.test(msg)) {
        // Approval gate tripped — open the modal prefilled with this run so the
        // planner can approve the plan (or use the admin override) explicitly.
        setNewPrefillRunId(fromRunId);
        setShowNew(true);
        setToast({ text: "This run isn't approved yet — approve it first, or use the admin override in the form.", kind: "error" });
      } else {
        setToast({ text: "Auto-create failed — " + msg, kind: "error" });
      }
    }
  }, [batches, refresh]);

  useEffect(() => { void refresh(); /* eslint-disable-line */ }, []);
  useEffect(() => { void loadSelected(); /* eslint-disable-line */ }, [selectedId]);

  // Fire the deep-link auto-create once the initial load has settled (so the
  // idempotency check sees the current batch list and runs are available).
  useEffect(() => {
    if (!autoReq || loading || autoHandledRef.current) return;
    autoHandledRef.current = true;
    void runAutoCreate(autoReq.fromRunId);
  }, [autoReq, loading, runAutoCreate]);

  return (
    <div style={S.app}>
      <div style={S.content}>
        <SystemHealthBanner />
        <div style={{ ...S.card, marginBottom: 12 }}>
          <div style={S.toolbar}>
            <strong style={{ color: PAL.text, fontSize: 14 }}>Execution batch</strong>
            <SearchableSelect value={selectedId || null} onChange={(v) => { setSelectedId(v); setTab("detail"); }} inputStyle={S.select}
              options={[{ value: "", label: "— pick —" }, ...batches.map((b) => ({ value: b.id, label: `${b.batch_name} · ${b.batch_type} · ${b.status}` }))]} />
            <button style={S.btnSecondary} onClick={() => setShowNew(true)}>+ New batch</button>
            {selected && (
              <button style={S.btnSecondary} onClick={() => setShowAudit(true)}>
                Audit ({audit.length})
              </button>
            )}
            {selected && (
              <button
                style={{ ...S.btnSecondary, color: PAL.red, borderColor: PAL.red }}
                onClick={deleteSelectedBatch}
                title="Permanently delete this batch and its actions"
              >Delete</button>
            )}
          </div>
          <div style={{ color: PAL.textMuted, fontSize: 12 }}>
            {writebackConfig.some((c) => c.enabled) ? (
              <span style={{ color: PAL.yellow }}>
                Xoro writeback partially enabled — some legacy endpoints are live. (Separate from Tangerine POs.)
              </span>
            ) : (
              <span>Legacy Xoro writeback: disabled. (Does not affect Tangerine POs — those are live.)</span>
            )}
          </div>
        </div>

        <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
          <TabBtn active={tab === "list"} onClick={() => setTab("list")}>Batches ({batches.length})</TabBtn>
          <TabBtn active={tab === "detail"} onClick={() => setTab("detail")} disabled={!selected}>Detail</TabBtn>
          {tab === "list" && (
            <div style={{ marginLeft: "auto" }}>
              <TablePrefsButton tableKey={TABLE_KEY} columns={ALL_COLUMNS} visibleColumns={visibleColumns}
                                onToggle={toggleColumn} onReset={resetToDefault} onSetAll={setAllVisible} />
            </div>
          )}
        </div>

        {tab === "list" && (
          <div style={S.card}>
            <div style={S.tableWrap}>
              <table style={S.table}>
                <thead>
                  <tr>
                    <SortableTh label="Name" sortKey="name" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} hidden={!visibleColumns.has("name")} />
                    <SortableTh label="Type" sortKey="type" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} hidden={!visibleColumns.has("type")} />
                    <SortableTh label="Status" sortKey="status" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} hidden={!visibleColumns.has("status")} />
                    <SortableTh label="Created" sortKey="created" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} hidden={!visibleColumns.has("created")} />
                    <SortableTh label="Approved" sortKey="approved" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} hidden={!visibleColumns.has("approved")} />
                    <SortableTh label="Note" sortKey="note" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} hidden={!visibleColumns.has("note")} />
                  </tr>
                </thead>
                <tbody>
                  {sortedBatches.map((b) => (
                    <tr key={b.id} style={{ cursor: "pointer", background: b.id === selectedId ? PAL.panelAlt : undefined }}
                        onClick={() => { setSelectedId(b.id); setTab("detail"); }}>
                      <td hidden={!visibleColumns.has("name")} style={{ ...S.td, fontWeight: b.id === selectedId ? 700 : 400 }}>{b.batch_name}</td>
                      <td hidden={!visibleColumns.has("type")} style={S.td}>{b.batch_type}</td>
                      <td hidden={!visibleColumns.has("status")} style={S.td}>
                        <span style={{ ...S.chip, background: BATCH_STATUS_COLOR[b.status] + "33", color: BATCH_STATUS_COLOR[b.status] }}>
                          {b.status.replace(/_/g, " ")}
                        </span>
                      </td>
                      <td hidden={!visibleColumns.has("created")} style={{ ...S.td, fontSize: 11, color: PAL.textDim }}>{formatDate(b.created_at.slice(0, 10))}</td>
                      <td hidden={!visibleColumns.has("approved")} style={{ ...S.td, fontSize: 11, color: PAL.textDim }}>{b.approved_at ? formatDate(b.approved_at.slice(0, 10)) : "—"}</td>
                      <td hidden={!visibleColumns.has("note")} style={{ ...S.td, fontSize: 12, color: PAL.textMuted }}>{b.note ?? ""}</td>
                    </tr>
                  ))}
                  {!loading && batches.length === 0 && (
                    <tr><td colSpan={6} style={{ ...S.td, textAlign: "center", color: PAL.textMuted, padding: 40 }}>
                      No execution batches yet. Click "New batch" — you'll need an approved scenario to build from.
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === "detail" && selected && (
          <ExecutionBatchDetail
            batch={selected}
            actions={actions}
            writebackConfig={writebackConfig}
            run={selectedRun}
            items={items}
            categories={categories}
            nameMaps={nameMaps}
            onChange={async () => { await refresh(); await loadSelected(); }}
            onToast={(t) => setToast(t)}
          />
        )}
        {tab === "detail" && !selected && (
          <div style={{ ...S.card, padding: 32, textAlign: "center", color: PAL.textMuted }}>
            Pick a batch from the dropdown or list.
          </div>
        )}
      </div>

      {showNew && (
        <NewBatchModal
          runs={runs}
          prefillRunId={newPrefillRunId}
          onClose={() => { setShowNew(false); setNewPrefillRunId(null); }}
          onCreated={async (id) => {
            setShowNew(false);
            setNewPrefillRunId(null);
            setSelectedId(id);
            setTab("detail");
            setToast({ text: "Batch created", kind: "success" });
            await refresh();
          }}
          onToast={(t) => setToast(t)}
        />
      )}

      {showAudit && selected && (
        <ExecutionAuditPanel entries={audit} onClose={() => setShowAudit(false)} />
      )}

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}

function TabBtn({ active, onClick, disabled, children }: { active: boolean; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button onClick={onClick} disabled={disabled}
            style={{
              background: active ? PAL.panel : "transparent",
              border: `1px solid ${active ? PAL.accent : PAL.border}`,
              color: disabled ? PAL.textMuted : active ? PAL.text : PAL.textDim,
              borderRadius: 8,
              padding: "8px 14px",
              fontSize: 13,
              fontWeight: 600,
              cursor: disabled ? "not-allowed" : "pointer",
              opacity: disabled ? 0.6 : 1,
            }}>{children}</button>
  );
}

type BuildSource = "scenario" | "run";

function NewBatchModal({ runs, prefillRunId, onClose, onCreated, onToast }: {
  runs: IpPlanningRun[];
  // When set (deep-link approval fallback), force the run source + preselect it.
  prefillRunId?: string | null;
  onClose: () => void;
  onCreated: (id: string) => Promise<void>;
  onToast: (t: ToastMessage) => void;
}) {
  // Approved scenarios are the normal build source — the Scenarios screen is
  // where a plan gets approved, and that approval is recorded on the SCENARIO
  // (status='approved'), NOT on the underlying planning run. The old form only
  // offered a run picker, so an approved scenario was invisible here and the
  // run-level approval gate rejected the build. We now load approved scenarios
  // and let the planner build straight from one (passing scenario_id, which
  // the service uses to derive the run + satisfy the approval gate).
  const [scenarios, setScenarios] = useState<IpScenario[]>([]);
  const [scenariosLoaded, setScenariosLoaded] = useState(false);
  const approvedScenarios = useMemo(
    () => scenarios.filter((s) => s.status === "approved"),
    [scenarios],
  );

  const [source, setSource] = useState<BuildSource>("run");
  const [scenarioId, setScenarioId] = useState("");
  const [runId, setRunId] = useState(prefillRunId ?? runs[0]?.id ?? "");
  const [batchType, setBatchType] = useState<IpExecutionBatchType>("buy_plan");
  const [name, setName] = useState("");
  // Once the planner types a name we stop auto-rewriting it.
  const [nameEdited, setNameEdited] = useState(false);
  const [note, setNote] = useState("");
  const [allowUnapproved, setAllowUnapproved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    scenarioRepo.listScenarios()
      .then((list) => {
        if (!alive) return;
        setScenarios(list);
        const firstApproved = list.find((s) => s.status === "approved");
        // Default to building from an approved scenario when one exists —
        // that's what the planner expects after approving in Scenarios. BUT when
        // we were opened via the deep-link approval fallback (prefillRunId), keep
        // the run source + preselected run the planner was sent here to fix.
        if (firstApproved && !prefillRunId) { setSource("scenario"); setScenarioId(firstApproved.id); }
        setScenariosLoaded(true);
      })
      .catch(() => { if (alive) setScenariosLoaded(true); });
    return () => { alive = false; };
  }, []);

  const runById = useMemo(() => new Map(runs.map((r) => [r.id, r])), [runs]);

  // Auto-name: include the scenario name when building from a scenario, e.g.
  // "0412 june 2026 — Buy plan 2026-06-04". Stops once the planner edits it.
  useEffect(() => {
    if (nameEdited) return;
    const today = new Date().toISOString().slice(0, 10);
    const label = batchType.replace(/_/g, " ");
    const base = label.charAt(0).toUpperCase() + label.slice(1);
    const scen = source === "scenario"
      ? scenarios.find((s) => s.id === scenarioId && s.status === "approved")
      : undefined;
    setName(scen ? `${scen.scenario_name} — ${base} ${today}` : `${base} ${today}`);
  }, [source, scenarioId, batchType, scenarios, nameEdited]);

  async function save() {
    setSaving(true);
    try {
      let input;
      if (source === "scenario") {
        const scen = approvedScenarios.find((s) => s.id === scenarioId);
        if (!scen) { onToast({ text: "Pick an approved scenario", kind: "error" }); setSaving(false); return; }
        input = {
          planning_run_id: scen.planning_run_id,
          scenario_id: scen.id,
          batch_name: name.trim(),
          batch_type: batchType,
          note: note.trim() || null,
          allowUnapproved,
        };
      } else {
        if (!runId) { onToast({ text: "Pick a planning run", kind: "error" }); setSaving(false); return; }
        input = {
          planning_run_id: runId,
          batch_name: name.trim(),
          batch_type: batchType,
          note: note.trim() || null,
          allowUnapproved,
        };
      }
      const b = await buildExecutionBatchFromRecommendations(input);
      await onCreated(b.id);
    } catch (e) {
      onToast({ text: "Create failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally {
      setSaving(false);
    }
  }

  const selectedScenario = approvedScenarios.find((s) => s.id === scenarioId);
  const derivedRun = selectedScenario ? runById.get(selectedScenario.planning_run_id) : undefined;

  return (
    <div style={S.drawerOverlay} onClick={onClose}>
      <div style={S.drawer} onClick={(e) => e.stopPropagation()}>
        <div style={S.drawerHeader}>
          <h3 style={{ margin: 0, fontSize: 16 }}>New execution batch</h3>
          <button style={S.btnGhost} onClick={onClose}>✕</button>
        </div>
        <div style={S.drawerBody}>
          <div style={{ display: "grid", gap: 10 }}>
            <div>
              <label style={S.label}>Build from</label>
              <SearchableSelect value={source} onChange={(v) => setSource(v as BuildSource)} inputStyle={{ ...S.select, width: "100%" }} options={[
                { value: "scenario", label: `Approved scenario${scenariosLoaded ? ` (${approvedScenarios.length})` : "…"}` },
                { value: "run", label: "Planning run (direct)" },
              ]} />
            </div>

            {source === "scenario" ? (
              <div>
                <label style={S.label}>Approved scenario</label>
                {approvedScenarios.length > 0 ? (
                  <SearchableSelect value={scenarioId || null} onChange={(v) => setScenarioId(v)} inputStyle={{ ...S.select, width: "100%" }}
                    options={[{ value: "", label: "— pick —" }, ...approvedScenarios.map((s) => ({ value: s.id, label: `${s.scenario_name} · ${s.scenario_type} · approved` }))]} />
                ) : (
                  <div style={{ color: PAL.textMuted, fontSize: 12 }}>
                    {scenariosLoaded
                      ? "No approved scenarios yet. Approve one in Scenarios, or build from a planning run."
                      : "Loading scenarios…"}
                  </div>
                )}
                {derivedRun && (
                  <div style={{ color: PAL.textMuted, fontSize: 11, marginTop: 4 }}>
                    Pulls recommendations from run: {derivedRun.name} · {derivedRun.planning_scope}
                  </div>
                )}
              </div>
            ) : (
              <div>
                <label style={S.label}>Planning run</label>
                <SearchableSelect value={runId || null} onChange={(v) => setRunId(v)} inputStyle={{ ...S.select, width: "100%" }}
                  options={runs.map((r) => ({ value: r.id, label: `${r.name} · ${r.planning_scope} · ${r.status}` }))} />
                <div style={{ color: PAL.textMuted, fontSize: 11, marginTop: 4 }}>
                  Requires a run-level approval (or the override below).
                </div>
              </div>
            )}

            <div>
              <label style={S.label}>Batch type</label>
              <SearchableSelect value={batchType} onChange={(v) => setBatchType(v as IpExecutionBatchType)} inputStyle={{ ...S.select, width: "100%" }}
                options={BATCH_TYPES.map((t) => ({ value: t, label: t.replace(/_/g, " ") }))} />
            </div>
            <div>
              <label style={S.label}>Batch name</label>
              <input style={{ ...S.input, width: "100%" }} value={name}
                     onChange={(e) => { setName(e.target.value); setNameEdited(true); }} />
            </div>
            <div>
              <label style={S.label}>Note</label>
              <input style={{ ...S.input, width: "100%" }} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <label style={{ display: "flex", gap: 6, color: PAL.textDim, fontSize: 12, alignItems: "center" }}>
              <input type="checkbox" checked={allowUnapproved} onChange={(e) => setAllowUnapproved(e.target.checked)} />
              Allow from unapproved plan (admin override — logs as unsafe)
            </label>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
              <button style={S.btnSecondary} onClick={onClose}>Cancel</button>
              <button style={S.btnPrimary} onClick={save} disabled={saving}>
                {saving ? "Creating…" : "Create batch"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
