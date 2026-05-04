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
  scenarioRepo,
  transitionScenario,
  isReadOnly,
  exportWholesaleBuyPlan,
  exportEcomBuyPlan,
  exportShortageReport,
  exportExcessReport,
  exportRecommendationsReport,
  exportScenarioComparison,
} from "../services";
import { S, PAL, formatDate, formatDateTime } from "../../components/styles";
import Toast, { type ToastMessage } from "../../components/Toast";
import ApprovalBar from "../components/ApprovalBar";
import ChangeAuditDrawer from "../components/ChangeAuditDrawer";
import ScenarioAssumptionsPanel from "./ScenarioAssumptionsPanel";
import ScenarioComparisonView from "./ScenarioComparisonView";

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

  async function handleApprovalAction(to: IpApprovalStatus, note: string | null) {
    if (!selected) return;
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
        note: "Duplicated from " + selected.id.slice(0, 8),
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

  async function doExport(kind: "wholesale" | "ecom" | "shortage" | "excess" | "recs" | "comparison") {
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
      setToast({ text: "Export ready", kind: "success" });
      await loadSelected();
    } catch (e) {
      setToast({ text: "Export failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    }
  }

  return (
    <div style={S.app}>
      <div style={S.nav}>
        <div style={S.navLeft}>
          <div style={S.navLogo}>IP</div>
          <div>
            <div style={S.navTitle}>Demand & Inventory Planning</div>
            <div style={S.navSub}>Scenarios, approvals & exports · Phase 4</div>
          </div>
        </div>
        <div style={S.navRight}>
          <a href="/planning/wholesale" style={{ ...S.btnSecondary, textDecoration: "none" }}>Wholesale</a>
          <a href="/planning/ecom" style={{ ...S.btnSecondary, textDecoration: "none" }}>Ecom</a>
          <a href="/planning/supply" style={{ ...S.btnSecondary, textDecoration: "none" }}>Supply</a>
          <a href="/planning/accuracy" style={{ ...S.btnSecondary, textDecoration: "none" }}>Accuracy</a>
          <a href="/planning/execution" style={{ ...S.btnSecondary, textDecoration: "none" }}>Execution →</a>
          <a href="/" style={{ ...S.btnSecondary, textDecoration: "none" }}>PLM</a>
        </div>
      </div>

      <div style={S.content}>
        {/* Scenario header card */}
        <div style={{ ...S.card, marginBottom: 12 }}>
          <div style={S.toolbar}>
            <strong style={{ color: PAL.text, fontSize: 14 }}>Scenario</strong>
            <select style={S.select} value={selectedId ?? ""} onChange={(e) => setSelectedId(e.target.value)}>
              <option value="">— pick —</option>
              {scenarios.map((s) => (
                <option key={s.id} value={s.id}>{s.scenario_name} · {s.scenario_type} · {s.status}</option>
              ))}
            </select>
            <button style={S.btnSecondary} onClick={() => setShowNew(true)}>+ New scenario</button>
            {selected && (
              <>
                <button style={S.btnSecondary} onClick={duplicate} disabled={busy}>Duplicate</button>
                <button style={S.btnSecondary} onClick={() => setShowAudit(true)}>History ({audit.length})</button>
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
              {selected.base_run_reference_id ? ` · base ${selected.base_run_reference_id.slice(0, 8)}` : ""}
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
            <div style={{ textAlign: "right", marginTop: 12 }}>
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
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
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
                    <th style={S.th}>Type</th>
                    <th style={S.th}>Status</th>
                    <th style={{ ...S.th, textAlign: "right" }}>Rows</th>
                    <th style={S.th}>File</th>
                    <th style={S.th}>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {exports.map((e) => (
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
  return (
    <div style={S.card}>
      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead>
            <tr>
              <th style={S.th}>Name</th>
              <th style={S.th}>Type</th>
              <th style={S.th}>Status</th>
              <th style={S.th}>Base run</th>
              <th style={S.th}>Created</th>
              <th style={S.th}>Note</th>
            </tr>
          </thead>
          <tbody>
            {scenarios.map((s) => (
              <tr key={s.id}
                  style={{ cursor: "pointer", background: s.id === selectedId ? PAL.panelAlt : undefined }}
                  onClick={() => onSelect(s.id)}>
                <td style={{ ...S.td, fontWeight: s.id === selectedId ? 700 : 400 }}>{s.scenario_name}</td>
                <td style={S.td}>{s.scenario_type}</td>
                <td style={S.td}>
                  <span style={{
                    ...S.chip,
                    background: STATUS_COLOR[s.status] + "33",
                    color: STATUS_COLOR[s.status],
                  }}>{s.status.replace(/_/g, " ")}</span>
                </td>
                <td style={{ ...S.td, color: PAL.textDim, fontSize: 11 }}>
                  {s.base_run_reference_id ? (runNameById.get(s.base_run_reference_id) ?? s.base_run_reference_id.slice(0, 8)) : "—"}
                </td>
                <td style={{ ...S.td, color: PAL.textDim, fontSize: 11 }}>{formatDate(s.created_at.slice(0, 10))}</td>
                <td style={{ ...S.td, color: PAL.textMuted, fontSize: 12 }}>{s.note ?? ""}</td>
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
              <select style={{ ...S.select, width: "100%" }} value={baseRunId} onChange={(e) => setBaseRunId(e.target.value)}>
                <option value="">— pick —</option>
                {runs.map((r) => (
                  <option key={r.id} value={r.id}>{r.name} · {r.planning_scope} · {r.status}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={S.label}>Scenario name</label>
              <input style={{ ...S.input, width: "100%" }} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <label style={S.label}>Type</label>
              <select style={{ ...S.select, width: "100%" }} value={type} onChange={(e) => setType(e.target.value as IpScenarioType)}>
                {(["what_if", "stretch", "conservative", "promo", "supply_delay", "override_review"] as const).map((t) => (
                  <option key={t} value={t}>{t.replace(/_/g, " ")}</option>
                ))}
              </select>
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
