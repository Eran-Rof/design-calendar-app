// Parent at /planning/execution. List batches + create new + detail.

import { useCallback, useEffect, useMemo, useState } from "react";
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
} from "../services";
import { S, PAL, formatDate } from "../../components/styles";
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

export default function ExecutionBatchManager() {
  const [batches, setBatches] = useState<IpExecutionBatch[]>([]);
  const [runs, setRuns] = useState<IpPlanningRun[]>([]);
  const [items, setItems] = useState<IpItem[]>([]);
  const [categories, setCategories] = useState<IpCategory[]>([]);
  const [writebackConfig, setWritebackConfig] = useState<IpErpWritebackConfig[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [actions, setActions] = useState<IpExecutionAction[]>([]);
  const [audit, setAudit] = useState<IpExecutionAuditEntry[]>([]);
  const [tab, setTab] = useState<"list" | "detail">("list");
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [showAudit, setShowAudit] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const selected = useMemo(() => batches.find((b) => b.id === selectedId) ?? null, [batches, selectedId]);
  const selectedRun = useMemo(() => runs.find((r) => r.id === selected?.planning_run_id) ?? null, [runs, selected]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [bs, rs, cfg, its, cats] = await Promise.all([
        executionRepo.listBatches(),
        wholesaleRepo.listPlanningRuns("all"),
        executionRepo.listWritebackConfig("xoro"),
        wholesaleRepo.listItems(),
        wholesaleRepo.listCategories(),
      ]);
      const ws = await wholesaleRepo.listPlanningRuns("wholesale");
      const ec = await wholesaleRepo.listPlanningRuns("ecom");
      setBatches(bs);
      setRuns(Array.from(new Map([...rs, ...ws, ...ec].map((r) => [r.id, r])).values()));
      setWritebackConfig(cfg);
      setItems(its);
      setCategories(cats);
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

  useEffect(() => { void refresh(); /* eslint-disable-line */ }, []);
  useEffect(() => { void loadSelected(); /* eslint-disable-line */ }, [selectedId]);

  return (
    <div style={S.app}>
      <div style={S.nav}>
        <div style={S.navLeft}>
          <div style={S.navLogo}>IP</div>
          <div>
            <div style={S.navTitle}>Demand & Inventory Planning</div>
            <div style={S.navSub}>Execution · Phase 6</div>
          </div>
        </div>
        <div style={S.navRight}>
          <a href="/planning/wholesale" style={{ ...S.btnSecondary, textDecoration: "none" }}>Wholesale</a>
          <a href="/planning/ecom" style={{ ...S.btnSecondary, textDecoration: "none" }}>Ecom</a>
          <a href="/planning/supply" style={{ ...S.btnSecondary, textDecoration: "none" }}>Supply</a>
          <a href="/planning/scenarios" style={{ ...S.btnSecondary, textDecoration: "none" }}>Scenarios</a>
          <a href="/planning/accuracy" style={{ ...S.btnSecondary, textDecoration: "none" }}>Accuracy</a>
          <a href="/" style={{ ...S.btnSecondary, textDecoration: "none" }}>PLM</a>
        </div>
      </div>

      <div style={S.content}>
        <SystemHealthBanner />
        <div style={{ ...S.card, marginBottom: 12 }}>
          <div style={S.toolbar}>
            <strong style={{ color: PAL.text, fontSize: 14 }}>Execution batch</strong>
            <select style={S.select} value={selectedId ?? ""} onChange={(e) => { setSelectedId(e.target.value); setTab("detail"); }}>
              <option value="">— pick —</option>
              {batches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.batch_name} · {b.batch_type} · {b.status}
                </option>
              ))}
            </select>
            <button style={S.btnSecondary} onClick={() => setShowNew(true)}>+ New batch</button>
            {selected && (
              <button style={S.btnSecondary} onClick={() => setShowAudit(true)}>
                Audit ({audit.length})
              </button>
            )}
          </div>
          <div style={{ color: PAL.textMuted, fontSize: 12 }}>
            Export-first by default. Writeback is per-action and only hits enabled config rows (currently{" "}
            <span style={{ color: writebackConfig.some((c) => c.enabled) ? PAL.green : PAL.textDim }}>
              {writebackConfig.some((c) => c.enabled) ? "live endpoints enabled" : "all endpoints disabled — dry-run only"}
            </span>
            ).
          </div>
        </div>

        <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
          <TabBtn active={tab === "list"} onClick={() => setTab("list")}>Batches ({batches.length})</TabBtn>
          <TabBtn active={tab === "detail"} onClick={() => setTab("detail")} disabled={!selected}>Detail</TabBtn>
        </div>

        {tab === "list" && (
          <div style={S.card}>
            <div style={S.tableWrap}>
              <table style={S.table}>
                <thead>
                  <tr>
                    <th style={S.th}>Name</th>
                    <th style={S.th}>Type</th>
                    <th style={S.th}>Status</th>
                    <th style={S.th}>Created</th>
                    <th style={S.th}>Approved</th>
                    <th style={S.th}>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {batches.map((b) => (
                    <tr key={b.id} style={{ cursor: "pointer", background: b.id === selectedId ? PAL.panelAlt : undefined }}
                        onClick={() => { setSelectedId(b.id); setTab("detail"); }}>
                      <td style={{ ...S.td, fontWeight: b.id === selectedId ? 700 : 400 }}>{b.batch_name}</td>
                      <td style={S.td}>{b.batch_type}</td>
                      <td style={S.td}>
                        <span style={{ ...S.chip, background: BATCH_STATUS_COLOR[b.status] + "33", color: BATCH_STATUS_COLOR[b.status] }}>
                          {b.status.replace(/_/g, " ")}
                        </span>
                      </td>
                      <td style={{ ...S.td, fontSize: 11, color: PAL.textDim }}>{formatDate(b.created_at.slice(0, 10))}</td>
                      <td style={{ ...S.td, fontSize: 11, color: PAL.textDim }}>{b.approved_at ? formatDate(b.approved_at.slice(0, 10)) : "—"}</td>
                      <td style={{ ...S.td, fontSize: 12, color: PAL.textMuted }}>{b.note ?? ""}</td>
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
          onClose={() => setShowNew(false)}
          onCreated={async (id) => {
            setShowNew(false);
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

function NewBatchModal({ runs, onClose, onCreated, onToast }: {
  runs: IpPlanningRun[];
  onClose: () => void;
  onCreated: (id: string) => Promise<void>;
  onToast: (t: ToastMessage) => void;
}) {
  const [runId, setRunId] = useState(runs[0]?.id ?? "");
  const [batchType, setBatchType] = useState<IpExecutionBatchType>("buy_plan");
  const [name, setName] = useState(`Buy plan ${new Date().toISOString().slice(0, 10)}`);
  const [note, setNote] = useState("");
  const [allowUnapproved, setAllowUnapproved] = useState(false);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!runId) { onToast({ text: "Pick a planning run", kind: "error" }); return; }
    setSaving(true);
    try {
      const b = await buildExecutionBatchFromRecommendations({
        planning_run_id: runId,
        batch_name: name.trim(),
        batch_type: batchType,
        note: note.trim() || null,
        allowUnapproved,
      });
      await onCreated(b.id);
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
          <h3 style={{ margin: 0, fontSize: 16 }}>New execution batch</h3>
          <button style={S.btnGhost} onClick={onClose}>✕</button>
        </div>
        <div style={S.drawerBody}>
          <div style={{ display: "grid", gap: 10 }}>
            <div>
              <label style={S.label}>Planning run</label>
              <select style={{ ...S.select, width: "100%" }} value={runId} onChange={(e) => setRunId(e.target.value)}>
                {runs.map((r) => <option key={r.id} value={r.id}>{r.name} · {r.planning_scope} · {r.status}</option>)}
              </select>
            </div>
            <div>
              <label style={S.label}>Batch type</label>
              <select style={{ ...S.select, width: "100%" }} value={batchType} onChange={(e) => setBatchType(e.target.value as IpExecutionBatchType)}>
                {BATCH_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
              </select>
            </div>
            <div>
              <label style={S.label}>Batch name</label>
              <input style={{ ...S.input, width: "100%" }} value={name} onChange={(e) => setName(e.target.value)} />
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
