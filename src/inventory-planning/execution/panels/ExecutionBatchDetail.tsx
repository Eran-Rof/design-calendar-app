// Batch detail: actions table + export/submit panel + validation.

import { useMemo, useState } from "react";
import type { IpCategory, IpItem } from "../../types/entities";
import type { IpPlanningRun } from "../../types/wholesale";
import type {
  IpErpWritebackConfig,
  IpExecutionAction,
  IpExecutionBatch,
  IpExecutionMethod,
  WritebackResult,
} from "../types/execution";
import {
  exportExecutionBatch,
  isBatchLocked,
  markActionStatus,
  removeAction,
  runWritebackDryRun,
  submitBatch,
  transitionBatch,
  updateExecutionAction,
} from "../services";
import { validateActions, hasBlockingErrors } from "../utils/validation";
import { S, PAL, formatQty, formatDate } from "../../components/styles";
import type { ToastMessage } from "../../components/Toast";
import { useCurrentUser } from "../../shared/hooks/useCurrentUser";
import { can } from "../../governance/services/permissionService";

const STATUS_COLOR: Record<string, string> = {
  pending:   "#94A3B8",
  approved:  "#3B82F6",
  exported:  "#3B82F6",
  submitted: "#8B5CF6",
  succeeded: "#10B981",
  failed:    "#EF4444",
  cancelled: "#6B7280",
};

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

export interface ExecutionBatchDetailProps {
  batch: IpExecutionBatch;
  actions: IpExecutionAction[];
  writebackConfig: IpErpWritebackConfig[];
  run: IpPlanningRun | null;
  items: IpItem[];
  categories: IpCategory[];
  onChange: () => Promise<void> | void;
  onToast: (t: ToastMessage) => void;
}

export default function ExecutionBatchDetail({
  batch, actions, writebackConfig, run, items, categories, onChange, onToast,
}: ExecutionBatchDetailProps) {
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<WritebackResult[]>([]);
  const locked = isBatchLocked(batch);
  const user = useCurrentUser();
  const canApproveBatch = user ? can(user, "approve_execution") : false;
  const canWriteback = user ? can(user, "run_writeback") : false;
  const canExport = user ? can(user, "run_exports") : true; // permissive default for exports
  const issues = useMemo(() => validateActions(actions), [actions]);
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const cfgByType = useMemo(() => new Map(writebackConfig.map((c) => [c.action_type, c])), [writebackConfig]);

  const totals = useMemo(() => {
    const t = { total: 0, approvedQty: 0, suggestedQty: 0, exported: 0, submitted: 0, succeeded: 0, failed: 0 };
    for (const a of actions) {
      t.total++;
      t.approvedQty += a.approved_qty ?? 0;
      t.suggestedQty += a.suggested_qty;
      if (a.execution_status === "exported") t.exported++;
      if (a.execution_status === "submitted") t.submitted++;
      if (a.execution_status === "succeeded") t.succeeded++;
      if (a.execution_status === "failed") t.failed++;
    }
    return t;
  }, [actions]);

  async function approveBatch() {
    setBusy(true);
    try {
      await transitionBatch({ batch, to: "approved", message: "Batch approved" });
      onToast({ text: "Batch approved", kind: "success" });
      await onChange();
    } catch (e) {
      onToast({ text: "Approve failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally { setBusy(false); }
  }
  async function markReady() {
    setBusy(true);
    try {
      await transitionBatch({ batch, to: "ready", message: "Reopened to ready" });
      onToast({ text: "Batch moved to ready", kind: "success" });
      await onChange();
    } catch (e) {
      onToast({ text: String(e instanceof Error ? e.message : e), kind: "error" });
    } finally { setBusy(false); }
  }
  async function archive() {
    if (!window.confirm("Archive this batch?")) return;
    setBusy(true);
    try {
      await transitionBatch({ batch, to: "archived" });
      onToast({ text: "Batch archived", kind: "success" });
      await onChange();
    } catch (e) {
      onToast({ text: String(e instanceof Error ? e.message : e), kind: "error" });
    } finally { setBusy(false); }
  }

  async function exportXlsx() {
    if (!run) { onToast({ text: "Run not found", kind: "error" }); return; }
    setBusy(true);
    try {
      await exportExecutionBatch({ batch, actions, run, items, categories });
      // Move to exported status if we were approved.
      if (batch.status === "approved") {
        await transitionBatch({ batch, to: "exported", message: "xlsx exported" });
      }
      onToast({ text: "xlsx downloaded", kind: "success" });
      await onChange();
    } catch (e) {
      onToast({ text: "Export failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally { setBusy(false); }
  }

  async function dryRun() {
    setBusy(true);
    try {
      const r = await runWritebackDryRun({ batch, actions });
      setResults(r.results);
      onToast({ text: `Dry run — ${r.results.filter((x) => x.ok).length} ok, ${r.results.filter((x) => !x.ok).length} failed`, kind: "success" });
      await onChange();
    } catch (e) {
      onToast({ text: "Dry run failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally { setBusy(false); }
  }
  async function submit() {
    if (hasBlockingErrors(issues)) {
      onToast({ text: "Fix validation errors before submitting", kind: "error" });
      return;
    }
    if (!window.confirm("Submit approved actions for writeback? Live mode will hit ERP endpoints when enabled.")) return;
    setBusy(true);
    try {
      const r = await submitBatch({ batch, actions });
      setResults(r.results);
      onToast({ text: `Submit — ${r.results.filter((x) => x.ok).length} ok, ${r.results.filter((x) => !x.ok).length} failed`, kind: "success" });
      await onChange();
    } catch (e) {
      onToast({ text: "Submit failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally { setBusy(false); }
  }

  async function editApprovedQty(action: IpExecutionAction) {
    const current = action.approved_qty ?? action.suggested_qty;
    const raw = window.prompt(`Approved qty for ${action.action_type}`, String(current));
    if (raw == null) return;
    const n = Number(raw);
    if (!Number.isFinite(n)) { onToast({ text: "Invalid number", kind: "error" }); return; }
    try {
      await updateExecutionAction({ batch, action, patch: { approved_qty: Math.round(n) } });
      await onChange();
    } catch (e) {
      onToast({ text: String(e instanceof Error ? e.message : e), kind: "error" });
    }
  }
  async function changeMethod(action: IpExecutionAction, method: IpExecutionMethod) {
    try {
      await updateExecutionAction({ batch, action, patch: { execution_method: method } });
      await onChange();
    } catch (e) {
      onToast({ text: String(e instanceof Error ? e.message : e), kind: "error" });
    }
  }
  async function remove(action: IpExecutionAction) {
    if (!window.confirm("Remove this action from the batch?")) return;
    try {
      await removeAction({ batch, action });
      await onChange();
      onToast({ text: "Action removed", kind: "success" });
    } catch (e) {
      onToast({ text: String(e instanceof Error ? e.message : e), kind: "error" });
    }
  }
  async function markApproved(action: IpExecutionAction) {
    try {
      await markActionStatus({ batch, action, status: "approved", message: "Marked approved" });
      await onChange();
    } catch (e) {
      onToast({ text: String(e instanceof Error ? e.message : e), kind: "error" });
    }
  }

  const blockingCount = issues.filter((i) => i.severity === "error").length;
  const warningCount = issues.filter((i) => i.severity === "warning").length;

  return (
    <div>
      {/* Header */}
      <div style={{ ...S.card, marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <h3 style={{ ...S.cardTitle, margin: 0 }}>{batch.batch_name}</h3>
          <span style={{ ...S.chip, background: BATCH_STATUS_COLOR[batch.status] + "33", color: BATCH_STATUS_COLOR[batch.status] }}>
            {batch.status.replace(/_/g, " ")}
          </span>
          <span style={{ color: PAL.textDim, fontSize: 12 }}>type: {batch.batch_type.replace(/_/g, " ")}</span>

          <div style={{ marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap" }}>
            {batch.status === "draft" && (
              <button style={S.btnSecondary} disabled={busy}
                      onClick={async () => { await transitionBatch({ batch, to: "ready" }); await onChange(); }}>
                Move to ready
              </button>
            )}
            {batch.status === "ready" && canApproveBatch && (
              <button style={S.btnPrimary} disabled={busy || blockingCount > 0} onClick={approveBatch}>
                Approve batch
              </button>
            )}
            {batch.status === "ready" && !canApproveBatch && (
              <span title="Missing permission: approve_execution"
                    style={{ ...S.chip, background: PAL.textMuted + "22", color: PAL.textMuted, fontSize: 11 }}>
                Approve batch · role required
              </span>
            )}
            {locked && batch.status !== "archived" && batch.status !== "executed" && (
              <button style={S.btnSecondary} disabled={busy} onClick={markReady}>Reopen to ready</button>
            )}
            {batch.status !== "archived" && (
              <button style={{ ...S.btnSecondary, color: PAL.textMuted }} disabled={busy} onClick={archive}>
                Archive
              </button>
            )}
          </div>
        </div>
        <div style={{ color: PAL.textMuted, fontSize: 12, marginTop: 6 }}>
          {batch.note ?? ""}
          {batch.approved_at ? ` · approved ${formatDate(batch.approved_at.slice(0, 10))}` : ""}
          {batch.approved_by ? ` by ${batch.approved_by}` : ""}
        </div>
      </div>

      {/* Stats row */}
      <div style={S.statsRow}>
        <StatCell label="Actions" value={String(totals.total)} />
        <StatCell label="Σ suggested" value={formatQty(totals.suggestedQty)} />
        <StatCell label="Σ approved" value={formatQty(totals.approvedQty)} accent={PAL.green} />
        <StatCell label="Succeeded / Failed" value={`${totals.succeeded} / ${totals.failed}`}
                  accent={totals.failed > 0 ? PAL.red : totals.succeeded > 0 ? PAL.green : PAL.textMuted} />
        <StatCell label="Validation" value={blockingCount > 0 ? `${blockingCount} errors` : warningCount > 0 ? `${warningCount} warnings` : "clean"}
                  accent={blockingCount > 0 ? PAL.red : warningCount > 0 ? PAL.yellow : PAL.green} />
      </div>

      {/* Export / Submit panel */}
      <div style={{ ...S.card, marginBottom: 12 }}>
        <h4 style={S.cardTitle}>Execute</h4>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <button style={S.btnSecondary} disabled={busy || batch.status === "draft" || !canExport} onClick={exportXlsx}
                  title={canExport ? "" : "Missing permission: run_exports"}>
            Export xlsx
          </button>
          <button style={S.btnSecondary} disabled={busy || !canWriteback} onClick={dryRun}
                  title={canWriteback ? "" : "Missing permission: run_writeback"}>
            Dry-run writeback
          </button>
          <button style={S.btnPrimary}
                  disabled={busy || !canWriteback || (batch.status !== "approved" && batch.status !== "exported")}
                  title={canWriteback ? "" : "Missing permission: run_writeback"}
                  onClick={submit}>
            Submit writeback
          </button>
          <div style={{ color: PAL.textMuted, fontSize: 12, marginLeft: "auto" }}>
            Writeback is per-action; only rows with method=<code style={{ color: PAL.text }}>api_writeback</code> and an enabled config are attempted.
          </div>
        </div>

        {results.length > 0 && (
          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 4 }}>
            {results.map((r) => (
              <div key={r.action_id} style={{
                background: (r.ok ? PAL.green : PAL.red) + "22",
                color: r.ok ? PAL.green : PAL.red,
                padding: "6px 10px",
                borderRadius: 6,
                fontSize: 12,
                fontFamily: "monospace",
              }}>
                [{r.dry_run ? "dry" : "live"}] {r.action_id.slice(0, 8)} · {r.status} · {r.message}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Actions table */}
      <div style={S.card}>
        <h4 style={S.cardTitle}>Actions</h4>
        <div style={S.tableWrap}>
          <table style={S.table}>
            <thead>
              <tr>
                <th style={S.th}>Type</th>
                <th style={S.th}>SKU</th>
                <th style={S.th}>Period</th>
                <th style={S.th}>PO</th>
                <th style={{ ...S.th, textAlign: "right" }}>Suggested</th>
                <th style={{ ...S.th, textAlign: "right" }}>Approved</th>
                <th style={S.th}>Method</th>
                <th style={S.th}>Status</th>
                <th style={S.th}>Reason</th>
                <th style={S.th}></th>
              </tr>
            </thead>
            <tbody>
              {actions.map((a) => {
                const item = itemById.get(a.sku_id);
                const cfg = cfgByType.get(a.action_type);
                const apiAllowed = !!cfg?.enabled;
                return (
                  <tr key={a.id} style={{ background: a.execution_status === "failed" ? "#3f1d1d22" : undefined }}>
                    <td style={S.td}>{a.action_type.replace(/_/g, " ")}</td>
                    <td style={{ ...S.td, fontFamily: "monospace", color: PAL.accent }}>
                      {item?.sku_code ?? a.sku_id.slice(0, 8)}
                    </td>
                    <td style={S.td}>{a.period_start ?? "–"}</td>
                    <td style={S.td}>{a.po_number ?? "–"}</td>
                    <td style={S.tdNum}>{formatQty(a.suggested_qty)}</td>
                    <td style={{ ...S.tdNum, color: locked ? PAL.textDim : PAL.accent, cursor: locked ? "default" : "pointer" }}
                        onClick={() => !locked && editApprovedQty(a)}>
                      {a.approved_qty == null ? "click to set" : formatQty(a.approved_qty)}
                    </td>
                    <td style={S.td}>
                      <select disabled={locked} style={{ ...S.select, padding: "4px 8px", fontSize: 12 }}
                              value={a.execution_method}
                              onChange={(e) => changeMethod(a, e.target.value as IpExecutionMethod)}>
                        <option value="export_only">export_only</option>
                        <option value="manual_erp_entry">manual_erp_entry</option>
                        <option value="api_writeback" disabled={!apiAllowed}>
                          api_writeback {apiAllowed ? "" : "(disabled)"}
                        </option>
                      </select>
                    </td>
                    <td style={S.td}>
                      <span style={{ ...S.chip, background: (STATUS_COLOR[a.execution_status] ?? PAL.textMuted) + "33", color: STATUS_COLOR[a.execution_status] ?? PAL.textMuted }}>
                        {a.execution_status}
                      </span>
                    </td>
                    <td style={{ ...S.td, color: PAL.textMuted, fontSize: 11 }}>{a.action_reason ?? ""}</td>
                    <td style={S.td}>
                      {!locked && a.execution_status === "pending" && (
                        <button style={S.btnGhost} onClick={() => markApproved(a)}>Approve</button>
                      )}
                      {!locked && (
                        <button style={{ ...S.btnGhost, color: PAL.red }} onClick={() => remove(a)}>Remove</button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {actions.length === 0 && (
                <tr><td colSpan={10} style={{ ...S.td, textAlign: "center", color: PAL.textMuted, padding: 40 }}>
                  No actions in this batch.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Validation */}
        {issues.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, color: PAL.textDim, marginBottom: 6 }}>Validation</div>
            {issues.map((i, idx) => (
              <div key={idx} style={{ fontSize: 12, color: i.severity === "error" ? PAL.red : PAL.yellow, padding: "2px 0" }}>
                {i.severity === "error" ? "✕" : "!"} {i.action_id.slice(0, 8)} · {i.field ?? ""} — {i.message}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatCell({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div style={S.statCard}>
      <div style={{ fontSize: 11, color: PAL.textMuted }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: accent ?? PAL.text, fontFamily: "monospace" }}>{value}</div>
    </div>
  );
}
