// Parent workbench at /planning/scenarios.
//
// Tabs:
//   Scenarios list (create / duplicate / open)
//   Assumptions (for the selected scenario)
//   Comparison (base vs selected scenario)
//   Exports (buttons + export history)

import { useCallback, useEffect, useMemo, useState } from "react";
import type { IpCategory, IpChannel, IpCustomer, IpItem } from "../../types/entities";
import type { IpPlanningRun } from "../../types/wholesale";
import type {
  IpApprovalStatus,
  IpChangeAuditLog,
  IpExportJob,
  IpScenario,
  IpScenarioAssumption,
  IpScenarioType,
  ScenarioComparisonRow,
  ScenarioComparisonTotals,
} from "../types/scenarios";
import { wholesaleRepo } from "../../services/wholesalePlanningRepository";
import { ecomRepo } from "../../ecom/services/ecomForecastRepo";
import {
  applyScenarioAssumptions,
  cloneBaseIntoScenario,
  loadScenarioComparison,
  recomputeScenarioOutputs,
  generatePlannerBuyRecommendations,
  scenarioRepo,
  transitionScenario,
  isReadOnly,
  exportWholesaleBuyPlan,
  exportEcomBuyPlan,
  exportShortageReport,
  exportExcessReport,
  exportRecommendationsReport,
  exportScenarioComparison,
  exportConsolidatedWorkbook,
} from "../services";
import { supplyRepo } from "../../supply/services/supplyReconciliationRepo";
import { S, PAL, formatDate, formatDateTime } from "../../components/styles";
import { confirmDialog } from "../../../shared/ui/warn";
import Toast, { type ToastMessage } from "../../components/Toast";
import ApprovalBar from "../components/ApprovalBar";
import ChangeAuditDrawer from "../components/ChangeAuditDrawer";
import ScenarioAssumptionsPanel from "./ScenarioAssumptionsPanel";
import ScenarioComparisonView from "./ScenarioComparisonView";
import SystemHealthBanner from "../../shared/components/SystemHealthBanner";
import { useTablePrefs, TablePrefsButton, type ColumnDef } from "../../../tanda/components/TablePrefs";
import SearchableSelect from "../../../tanda/components/SearchableSelect";
import { useSort } from "../../../tanda/hooks/useSort";
import SortableTh from "../../../tanda/components/SortableTh";

const SCENARIO_LIST_TABLE_KEY = "ip.scenario_manager";
const SCENARIO_LIST_COLUMNS: ColumnDef[] = [
  { key: "name", label: "Name" },
  { key: "type", label: "Type" },
  { key: "status", label: "Status" },
  { key: "base_run", label: "Base run" },
  { key: "created", label: "Created" },
  { key: "note", label: "Note" },
];

type TabKey = "list" | "assumptions" | "comparison" | "exports";

const STATUS_COLOR: Record<IpApprovalStatus, string> = {
  draft:     "#94A3B8",
  in_review: "#3B82F6",
  approved:  "#10B981",
  rejected:  "#EF4444",
  archived:  "#6B7280",
};

export default function ScenarioManager() {
  const [runs, setRuns] = useState<IpPlanningRun[]>([]);
  const [scenarios, setScenarios] = useState<IpScenario[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [assumptions, setAssumptions] = useState<IpScenarioAssumption[]>([]);
  const [comparison, setComparison] = useState<{ rows: ScenarioComparisonRow[]; totals: ScenarioComparisonTotals } | null>(null);
  const [items, setItems] = useState<IpItem[]>([]);
  const [customers, setCustomers] = useState<IpCustomer[]>([]);
  const [categories, setCategories] = useState<IpCategory[]>([]);
  const [channels, setChannels] = useState<IpChannel[]>([]);
  const [exports, setExports] = useState<IpExportJob[]>([]);
  const [audit, setAudit] = useState<IpChangeAuditLog[]>([]);
  const [tab, setTab] = useState<TabKey>("list");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showAudit, setShowAudit] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  // Optional ?baseRunId=… deep-link from the wholesale workbench's
  // "What-if →" button. When present, auto-open the new-scenario
  // modal with the run pre-selected so the planner lands inside the
  // form they wanted, not on the empty scenarios list.
  const [initialBaseRunId, setInitialBaseRunId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const sp = new URLSearchParams(window.location.search);
      return sp.get("baseRunId");
    } catch { return null; }
  });

  const selected = useMemo(() => scenarios.find((s) => s.id === selectedId) ?? null, [scenarios, selectedId]);
  const readOnly = selected ? isReadOnly(selected) : false;

  // Additive per-column sort over the export history rows.
  const { sorted: exportsSorted, sortKey: exportsSortKey, sortDir: exportsSortDir, onHeaderClick: exportsOnHeaderClick } = useSort(exports, {
    persistKey: "ip:scenario_manager_exports:sort",
    accessors: {
      type: (e) => e.export_type,
      status: (e) => e.export_status,
      rows: (e) => e.row_count ?? 0,
      file: (e) => e.file_name ?? "",
      created: (e) => e.created_at,
    },
  });

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [r, wsRuns, ecRuns, s, its, cs, cats, chs] = await Promise.all([
        wholesaleRepo.listPlanningRuns("all"),
        wholesaleRepo.listPlanningRuns("wholesale"),
        wholesaleRepo.listPlanningRuns("ecom"),
        scenarioRepo.listScenarios(),
        wholesaleRepo.listItems(),
        wholesaleRepo.listCustomers(),
        wholesaleRepo.listCategories(),
        ecomRepo.listChannels(),
      ]);
      setRuns(Array.from(new Map([...r, ...wsRuns, ...ecRuns].map((x) => [x.id, x])).values()));
      setScenarios(s);
      setItems(its);
      setCustomers(cs);
      setCategories(cats);
      setChannels(chs);
      if (!selectedId && s.length > 0) setSelectedId(s[0].id);
    } catch (e) {
      setToast({ text: "Load failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally {
      setLoading(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadSelected = useCallback(async () => {
    if (!selected) { setAssumptions([]); setComparison(null); setExports([]); setAudit([]); return; }
    const [a, ex, au] = await Promise.all([
      scenarioRepo.listAssumptions(selected.id),
      scenarioRepo.listExports({ scenario_id: selected.id }),
      scenarioRepo.listAudit({ scenario_id: selected.id }),
    ]);
    setAssumptions(a);
    setExports(ex);
    setAudit(au);
    if (tab === "comparison") {
      try {
        const c = await loadScenarioComparison(selected);
        setComparison(c);
      } catch (e) {
        setToast({ text: String(e instanceof Error ? e.message : e), kind: "error" });
      }
    }
  }, [selected, tab]);

  useEffect(() => { void refresh(); /* eslint-disable-line */ }, []);
  useEffect(() => { void loadSelected(); /* eslint-disable-line */ }, [selectedId, tab]);

  // Once runs have loaded and the deep-link's baseRunId matches an
  // existing run, pop the New Scenario modal automatically. Strip the
  // query param afterwards so a refresh doesn't re-open the modal.
  useEffect(() => {
    if (!initialBaseRunId) return;
    if (runs.length === 0) return;
    if (!runs.some((r) => r.id === initialBaseRunId)) return;
    setShowNew(true);
    if (typeof window !== "undefined" && window.history?.replaceState) {
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete("baseRunId");
        window.history.replaceState({}, "", url.toString());
      } catch { /* ignore */ }
    }
  }, [runs, initialBaseRunId]);

  async function applyAndRecompute() {
    if (!selected) return;
    setBusy(true);
    try {
      await applyScenarioAssumptions(selected.id);
      const r = await recomputeScenarioOutputs(selected.id);
      setToast({
        text: `Scenario recomputed — ${r.projected_rows} projected · ${r.recommendations} recs · ${r.exceptions} exceptions`,
        kind: "success",
      });
      await loadSelected();
    } catch (e) {
      setToast({ text: "Recompute failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  // Push the planner's own typed buys (planned_buy_qty) as the buy plan instead
  // of letting supply reconciliation compute it. Writes `buy` recommendations
  // directly, which the execution batch + buy-plan export then read.
  async function pushPlannerBuys() {
    if (!selected) return;
    const ok = await confirmDialog(
      "Use the planner-typed buy quantities (planned_buy_qty) as the buy plan?\n\n" +
      "This REPLACES any computed recommendations for this scenario with your typed buys — " +
      "supply netting is skipped. The execution batch and buy-plan export then reflect your numbers.",
      { title: "Push planner buys → plan", confirmText: "Use my buys" },
    );
    if (!ok) return;
    setBusy(true);
    try {
      const r = await generatePlannerBuyRecommendations(selected.id);
      setToast({
        text: r.recommendations > 0
          ? `Buy plan set from planner buys — ${r.recommendations} lines · ${r.units.toLocaleString()} units`
          : "No planner buys found (planned_buy_qty is 0 for every line).",
        kind: r.recommendations > 0 ? "success" : "error",
      });
      await loadSelected();
    } catch (e) {
      setToast({ text: "Push failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function handleApprovalAction(to: IpApprovalStatus, note: string | null) {
    if (!selected) return;
    // Guard: don't let a scenario be approved with no computed buy plan — that
    // yields an empty execution batch + 0-row exports (the execution layer + the
    // buy-plan export read ip_inventory_recommendations, NOT the typed forecast).
    if (to === "approved") {
      const recs = await supplyRepo.listRecommendations(selected.planning_run_id);
      if (recs.length === 0) {
        const proceed = await confirmDialog(
          "This scenario has NO computed buy plan (0 recommendations), so approving it now will produce an empty execution batch and 0-row exports.\n\n" +
          "Run \"Apply assumptions + recompute\" (supply-netted plan) or \"Push planner buys → plan\" (your typed quantities) first.\n\nApprove anyway?",
          { title: "No buy plan computed", confirmText: "Approve anyway", danger: true },
        );
        if (!proceed) return;
      }
    }
    setBusy(true);
    try {
      const updated = await transitionScenario({ scenario: selected, to, note, approved_by: null });
      setScenarios((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      setToast({ text: `Moved to ${to.replace(/_/g, " ")}`, kind: "success" });
      await loadSelected();
    } catch (e) {
      setToast({ text: String(e instanceof Error ? e.message : e), kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function duplicate() {
    if (!selected || !selected.base_run_reference_id) {
      setToast({ text: "No base reference — can't duplicate", kind: "error" });
      return;
    }
    setBusy(true);
    try {
      const copy = await cloneBaseIntoScenario({
        baseRunId: selected.base_run_reference_id,
        scenarioName: `${selected.scenario_name} (copy)`,
        scenarioType: selected.scenario_type,
        note: "Duplicated from " + selected.scenario_name,
      });
      await refresh();
      setSelectedId(copy.id);
      setToast({ text: "Scenario duplicated", kind: "success" });
    } catch (e) {
      setToast({ text: "Duplicate failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function deleteSelected() {
    if (!selected) return;
    const ok = await confirmDialog(
      `Permanently DELETE scenario "${selected.scenario_name}" (${selected.status})?\n\n` +
      `This removes the scenario and its assumptions/approvals/exports. ` +
      `It cannot be undone. To keep a record instead, use Archive (close).`,
      { title: "Delete scenario", confirmText: "Delete" },
    );
    if (!ok) return;
    setBusy(true);
    try {
      await scenarioRepo.deleteScenario(selected.id);
      // Children cascade (assumptions/approvals/exports); audit + execution
      // batches keep the row with scenario_id set null (FK ON DELETE SET NULL).
      setSelectedId(null);
      setToast({ text: "Scenario deleted", kind: "success" });
      await refresh();
    } catch (e) {
      setToast({ text: "Delete failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function doExport(kind: "wholesale" | "ecom" | "shortage" | "excess" | "recs" | "comparison" | "consolidated") {
    if (!selected) return;
    const run = runs.find((r) => r.id === selected.planning_run_id);
    if (!run) { setToast({ text: "Run not found", kind: "error" }); return; }
    const ctx = { run, scenarioId: selected.id, items, categories, createdBy: null };
    try {
      if (kind === "wholesale") await exportWholesaleBuyPlan(ctx);
      if (kind === "ecom")      await exportEcomBuyPlan(ctx);
      if (kind === "shortage")  await exportShortageReport(ctx);
      if (kind === "excess")    await exportExcessReport(ctx);
      if (kind === "recs")      await exportRecommendationsReport(ctx);
      if (kind === "comparison") {
        const c = comparison ?? await loadScenarioComparison(selected);
        await exportScenarioComparison(ctx, c);
      }
      if (kind === "consolidated") {
        // Try to bundle the comparison sheet too — but only when the
        // scenario has a base run to diff against. Falls back to the
        // base tabs when no comparison is available.
        let comp: { rows: ScenarioComparisonRow[]; totals: ScenarioComparisonTotals } | undefined;
        if (selected.base_run_reference_id) {
          comp = comparison ?? await loadScenarioComparison(selected);
        }
        await exportConsolidatedWorkbook(ctx, { comparison: comp });
      }
      setToast({ text: "Export ready", kind: "success" });
      await loadSelected();
    } catch (e) {
      setToast({ text: "Export failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    }
  }

  return (
    <div style={S.app}>
      <div style={S.content}>
        <SystemHealthBanner />
        {/* Scenario header card */}
        <div style={{ ...S.card, marginBottom: 12 }}>
          <div style={S.toolbar}>
            <strong style={{ color: PAL.text, fontSize: 14 }}>Scenario</strong>
            <SearchableSelect
              inputStyle={S.select}
              value={selectedId}
              onChange={(v) => setSelectedId(v)}
              placeholder="— pick —"
              options={scenarios.map((s) => ({ value: s.id, label: `${s.scenario_name} · ${s.scenario_type} · ${s.status}` }))}
            />
            <button style={S.btnSecondary} onClick={() => setShowNew(true)}>+ New scenario</button>
            {selected && (
              <>
                <button style={S.btnSecondary} onClick={duplicate} disabled={busy}>Duplicate</button>
                <button style={S.btnSecondary} onClick={() => setShowAudit(true)}>History ({audit.length})</button>
                <button
                  style={{ ...S.btnSecondary, color: PAL.red, borderColor: PAL.red }}
                  onClick={deleteSelected}
                  disabled={busy}
                  title="Permanently delete this scenario (or use Archive to close it without deleting)"
                >Delete</button>
              </>
            )}
            {selected && (
              <div style={{ marginLeft: "auto" }}>
                <ApprovalBar scenario={selected} onAction={handleApprovalAction} busy={busy} />
              </div>
            )}
          </div>
          {selected && (
            <div style={{ color: PAL.textMuted, fontSize: 12, marginTop: 6 }}>
              {selected.note ?? ""}
              {selected.base_run_reference_id ? ` · base ${runs.find((r) => r.id === selected.base_run_reference_id)?.name ?? "—"}` : ""}
              {" · created "}{formatDateTime(selected.created_at)}
              {readOnly && <span style={{ color: PAL.green, marginLeft: 8 }}>· read-only (approved/archived)</span>}
            </div>
          )}
        </div>

        <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
          <TabBtn active={tab === "list"} onClick={() => setTab("list")}>Scenarios ({scenarios.length})</TabBtn>
          <TabBtn active={tab === "assumptions"} onClick={() => setTab("assumptions")}>Assumptions ({assumptions.length})</TabBtn>
          <TabBtn active={tab === "comparison"} onClick={() => setTab("comparison")}>Comparison</TabBtn>
          <TabBtn active={tab === "exports"} onClick={() => setTab("exports")}>Exports ({exports.length})</TabBtn>
        </div>

        {tab === "list" && (
          <ScenarioList
            scenarios={scenarios}
            runs={runs}
            selectedId={selectedId}
            onSelect={(id) => setSelectedId(id)}
            loading={loading}
          />
        )}

        {tab === "assumptions" && selected && (
          <>
            <ScenarioAssumptionsPanel
              scenario={selected}
              assumptions={assumptions}
              items={items}
              customers={customers}
              channels={channels}
              categories={categories}
              readOnly={readOnly}
              onChange={loadSelected}
              onToast={(t) => setToast(t)}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
              <button style={S.btnSecondary} onClick={pushPlannerBuys} disabled={busy || readOnly}
                      title="Use your typed planned-buy quantities as the buy plan (skips supply netting)">
                {busy ? "Working…" : "Push planner buys → plan"}
              </button>
              <button style={S.btnPrimary} onClick={applyAndRecompute} disabled={busy || readOnly}>
                {busy ? "Applying…" : "Apply assumptions + recompute"}
              </button>
            </div>
          </>
        )}

        {tab === "comparison" && (
          comparison ? (
            <>
              <ScenarioComparisonView rows={comparison.rows} totals={comparison.totals} loading={loading} />
              <div style={{ textAlign: "right", marginTop: 12 }}>
                <button style={S.btnSecondary} onClick={() => doExport("comparison")}>Export comparison → xlsx</button>
              </div>
            </>
          ) : (
            <div style={{ ...S.card, padding: 32, textAlign: "center", color: PAL.textMuted }}>
              {selected ? "No comparison loaded yet — ensure the scenario has been recomputed and its base run also has projected inventory." : "Select a scenario."}
            </div>
          )
        )}

        {tab === "exports" && selected && (
          <div style={S.card}>
            <h3 style={S.cardTitle}>Exports for this scenario</h3>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16, alignItems: "center" }}>
              {/* Phase 4 spec: ONE workbook with all the planner-facing
                  tabs. Highlighted as the primary action since it's
                  what most planners actually want for a stakeholder
                  review. The individual exports stay below for
                  one-tab downloads. */}
              <button style={S.btnPrimary} onClick={() => doExport("consolidated")} title="One workbook with Metadata, Summary, Buy Plans, Shortages, Excess, Recommendations, Comparison, Assumptions">
                Export full plan → xlsx
              </button>
              <span style={{ color: PAL.textMuted, fontSize: 12 }}>or single sheet:</span>
              <button style={S.btnSecondary} onClick={() => doExport("wholesale")}>Wholesale buy plan</button>
              <button style={S.btnSecondary} onClick={() => doExport("ecom")}>Ecom buy plan</button>
              <button style={S.btnSecondary} onClick={() => doExport("shortage")}>Shortage report</button>
              <button style={S.btnSecondary} onClick={() => doExport("excess")}>Excess report</button>
              <button style={S.btnSecondary} onClick={() => doExport("recs")}>Recommendations</button>
              <button style={S.btnSecondary} onClick={() => doExport("comparison")}>Scenario comparison</button>
            </div>
            <div style={S.tableWrap}>
              <table style={S.table}>
                <thead>
                  <tr>
                    <SortableTh label="Type" sortKey="type" activeKey={exportsSortKey} dir={exportsSortDir} onSort={exportsOnHeaderClick} style={S.th} />
                    <SortableTh label="Status" sortKey="status" activeKey={exportsSortKey} dir={exportsSortDir} onSort={exportsOnHeaderClick} style={S.th} />
                    <SortableTh label="Rows" sortKey="rows" activeKey={exportsSortKey} dir={exportsSortDir} onSort={exportsOnHeaderClick} style={S.th} cellStyle={{ textAlign: "right" }} />
                    <SortableTh label="File" sortKey="file" activeKey={exportsSortKey} dir={exportsSortDir} onSort={exportsOnHeaderClick} style={S.th} />
                    <SortableTh label="Created" sortKey="created" activeKey={exportsSortKey} dir={exportsSortDir} onSort={exportsOnHeaderClick} style={S.th} />
                  </tr>
                </thead>
                <tbody>
                  {exportsSorted.map((e) => (
                    <tr key={e.id}>
                      <td style={S.td}>{e.export_type}</td>
                      <td style={S.td}>{e.export_status}</td>
                      <td style={S.tdNum}>{e.row_count ?? 0}</td>
                      <td style={{ ...S.td, fontFamily: "monospace", fontSize: 11 }}>{e.file_name ?? "–"}</td>
                      <td style={{ ...S.td, fontSize: 11, color: PAL.textDim }}>{formatDateTime(e.created_at)}</td>
                    </tr>
                  ))}
                  {exports.length === 0 && (
                    <tr><td colSpan={5} style={{ ...S.td, textAlign: "center", color: PAL.textMuted, padding: 24 }}>
                      No exports yet.
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {showNew && (
        <NewScenarioModal
          runs={runs}
          initialBaseRunId={initialBaseRunId}
          onClose={() => { setShowNew(false); setInitialBaseRunId(null); }}
          onCreated={async (id) => {
            setShowNew(false);
            setInitialBaseRunId(null);
            setSelectedId(id);
            await refresh();
            setToast({ text: "Scenario created", kind: "success" });
          }}
          onToast={(t) => setToast(t)}
        />
      )}

      {showAudit && (
        <ChangeAuditDrawer
          entries={audit}
          title={selected ? `Audit — ${selected.scenario_name}` : "Audit"}
          onClose={() => setShowAudit(false)}
        />
      )}

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}

// ── Scenario list ─────────────────────────────────────────────────────────
function ScenarioList({
  scenarios, runs, selectedId, onSelect, loading,
}: {
  scenarios: IpScenario[]; runs: IpPlanningRun[];
  selectedId: string | null; onSelect: (id: string) => void; loading?: boolean;
}) {
  const runNameById = new Map(runs.map((r) => [r.id, r.name]));
  const { visibleColumns, toggleColumn, setAllVisible, resetToDefault } = useTablePrefs(SCENARIO_LIST_TABLE_KEY, SCENARIO_LIST_COLUMNS);
  // Additive per-column sort over the scenario rows. Status/base_run/created
  // cells render looked-up or formatted values, so supply matching accessors.
  const { sorted, sortKey, sortDir, onHeaderClick } = useSort(scenarios, {
    persistKey: "ip:scenario_manager:sort",
    accessors: {
      name: (s) => s.scenario_name,
      type: (s) => s.scenario_type,
      status: (s) => s.status,
      base_run: (s) => (s.base_run_reference_id ? runNameById.get(s.base_run_reference_id) ?? "" : ""),
      created: (s) => s.created_at,
      note: (s) => s.note ?? "",
    },
  });
  return (
    <div style={S.card}>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
        <TablePrefsButton
          tableKey={SCENARIO_LIST_TABLE_KEY}
          columns={SCENARIO_LIST_COLUMNS}
          visibleColumns={visibleColumns}
          onToggle={toggleColumn}
          onReset={resetToDefault}
          onSetAll={setAllVisible}
        />
      </div>
      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead>
            <tr>
              <SortableTh label="Name" sortKey="name" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} hidden={!visibleColumns.has("name")} />
              <SortableTh label="Type" sortKey="type" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} hidden={!visibleColumns.has("type")} />
              <SortableTh label="Status" sortKey="status" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} hidden={!visibleColumns.has("status")} />
              <SortableTh label="Base run" sortKey="base_run" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} hidden={!visibleColumns.has("base_run")} />
              <SortableTh label="Created" sortKey="created" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} hidden={!visibleColumns.has("created")} />
              <SortableTh label="Note" sortKey="note" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} hidden={!visibleColumns.has("note")} />
            </tr>
          </thead>
          <tbody>
            {sorted.map((s) => (
              <tr key={s.id}
                  style={{ cursor: "pointer", background: s.id === selectedId ? PAL.panelAlt : undefined }}
                  onClick={() => onSelect(s.id)}>
                <td style={{ ...S.td, fontWeight: s.id === selectedId ? 700 : 400 }} hidden={!visibleColumns.has("name")}>{s.scenario_name}</td>
                <td style={S.td} hidden={!visibleColumns.has("type")}>{s.scenario_type}</td>
                <td style={S.td} hidden={!visibleColumns.has("status")}>
                  <span style={{
                    ...S.chip,
                    background: STATUS_COLOR[s.status] + "33",
                    color: STATUS_COLOR[s.status],
                  }}>{s.status.replace(/_/g, " ")}</span>
                </td>
                <td style={{ ...S.td, color: PAL.textDim, fontSize: 11 }} hidden={!visibleColumns.has("base_run")}>
                  {s.base_run_reference_id ? (runNameById.get(s.base_run_reference_id) ?? "—") : "—"}
                </td>
                <td style={{ ...S.td, color: PAL.textDim, fontSize: 11 }} hidden={!visibleColumns.has("created")}>{formatDate(s.created_at.slice(0, 10))}</td>
                <td style={{ ...S.td, color: PAL.textMuted, fontSize: 12 }} hidden={!visibleColumns.has("note")}>{s.note ?? ""}</td>
              </tr>
            ))}
            {!loading && scenarios.length === 0 && (
              <tr><td colSpan={6} style={{ ...S.td, textAlign: "center", color: PAL.textMuted, padding: 40 }}>
                No scenarios yet. Click "New scenario" above.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── New scenario modal ────────────────────────────────────────────────────
function NewScenarioModal({
  runs, initialBaseRunId, onClose, onCreated, onToast,
}: {
  runs: IpPlanningRun[];
  initialBaseRunId?: string | null;
  onClose: () => void;
  onCreated: (id: string) => Promise<void>;
  onToast: (t: ToastMessage) => void;
}) {
  const [baseRunId, setBaseRunId] = useState(() => {
    if (initialBaseRunId && runs.some((r) => r.id === initialBaseRunId)) return initialBaseRunId;
    return runs[0]?.id ?? "";
  });
  const [name, setName] = useState(`Scenario ${new Date().toISOString().slice(0, 10)}`);
  const [type, setType] = useState<IpScenarioType>("what_if");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!baseRunId) { onToast({ text: "Pick a base planning run", kind: "error" }); return; }
    if (!name.trim()) { onToast({ text: "Name is required", kind: "error" }); return; }
    setSaving(true);
    try {
      const scen = await cloneBaseIntoScenario({
        baseRunId, scenarioName: name.trim(), scenarioType: type,
        note: note.trim() || null,
      });
      await onCreated(scen.id);
    } catch (e) {
      onToast({ text: "Create failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={S.drawerOverlay} onClick={onClose}>
      <div style={S.drawer} onClick={(e) => e.stopPropagation()}>
        <div style={S.drawerHeader}>
          <h3 style={{ margin: 0, fontSize: 16 }}>New scenario</h3>
          <button style={S.btnGhost} onClick={onClose}>✕</button>
        </div>
        <div style={S.drawerBody}>
          <div style={{ display: "grid", gap: 10 }}>
            <div>
              <label style={S.label}>Base planning run</label>
              <SearchableSelect
                inputStyle={{ ...S.select, width: "100%" }}
                value={baseRunId || null}
                onChange={(v) => setBaseRunId(v)}
                placeholder="— pick —"
                options={runs.map((r) => ({ value: r.id, label: `${r.name} · ${r.planning_scope} · ${r.status}` }))}
              />
            </div>
            <div>
              <label style={S.label}>Scenario name</label>
              <input style={{ ...S.input, width: "100%" }} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <label style={S.label}>Type</label>
              <SearchableSelect
                inputStyle={{ ...S.select, width: "100%" }}
                value={type}
                onChange={(v) => setType(v as IpScenarioType)}
                options={(["what_if", "stretch", "conservative", "promo", "supply_delay", "override_review"] as const).map((t) => ({ value: t, label: t.replace(/_/g, " ") }))}
              />
            </div>
            <div>
              <label style={S.label}>Note</label>
              <input style={{ ...S.input, width: "100%" }} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
              <button style={S.btnSecondary} onClick={onClose}>Cancel</button>
              <button style={S.btnPrimary} onClick={save} disabled={saving}>
                {saving ? "Cloning…" : "Clone + create"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
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
