// Batch detail: actions table + export/submit panel + validation.

import { useEffect, useMemo, useState, type ReactNode } from "react";
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
  canBatchTransition,
  exportExecutionBatch,
  executionRepo,
  isBatchLocked,
  markActionStatus,
  removeAction,
  runWritebackDryRun,
  submitBatch,
  transitionBatch,
  updateExecutionAction,
  createTangerinePos,
  linkPlanningVendor,
} from "../services";
import { wholesaleRepo } from "../../services/wholesalePlanningRepository";
import type { TangerinePoResult, TangerineVendorSuggestion } from "../services/tangerinePoService";
import type { ExecutionExportNameMaps } from "../services";
import {
  nextStepFor,
  styleOf,
  PO_PANEL_URL,
  VENDORS_URL,
  type NextStepActionKind,
} from "./nextStep";

const SKIP_LABEL: Record<string, string> = {
  already_linked: "already linked to a PO",
  cancelled: "cancelled action",
  zero_qty: "zero approved qty",
  no_sku: "SKU not in item master",
  no_vendor: "no vendor on action",
  vendor_missing: "vendor not in planning master",
  vendor_unlinked: "vendor not linked to Tangerine",
};
import { validateActions, hasBlockingErrors } from "../utils/validation";
import { S, PAL, formatQty, formatDate } from "../../components/styles";
import { confirmDialog, promptDialog } from "../../../shared/ui/warn";
import { StatCell } from "../../components/StatCell";
import type { ToastMessage } from "../../components/Toast";
import { useCurrentUser } from "../../shared/hooks/useCurrentUser";
import { can } from "../../governance/services/permissionService";
import SearchableSelect from "../../../tanda/components/SearchableSelect";
import { useSort } from "../../../tanda/hooks/useSort";
import SortableTh from "../../../tanda/components/SortableTh";

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
  // id → name maps so the xlsx export shows vendor/customer/channel names, not UUIDs.
  nameMaps?: ExecutionExportNameMaps;
  onChange: () => Promise<void> | void;
  onToast: (t: ToastMessage) => void;
}

export default function ExecutionBatchDetail({
  batch, actions, writebackConfig, run, items, categories, nameMaps, onChange, onToast,
}: ExecutionBatchDetailProps) {
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<WritebackResult[]>([]);
  const [poResult, setPoResult] = useState<TangerinePoResult | null>(null);
  const locked = isBatchLocked(batch);
  const user = useCurrentUser();
  const canApproveBatch = user ? can(user, "approve_execution") : false;
  const canWriteback = user ? can(user, "run_writeback") : false;
  const canExport = user ? can(user, "run_exports") : true; // permissive default for exports
  const issues = useMemo(() => validateActions(actions), [actions]);
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const cfgByType = useMemo(() => new Map(writebackConfig.map((c) => [c.action_type, c])), [writebackConfig]);

  // Legacy-Xoro writeback is demoted when every config row is disabled (the
  // live state): the two Xoro buttons collapse into a disclosure and the banner
  // reads "disabled". Some enabled → keep them top-level.
  const allXoroDisabled = writebackConfig.length === 0 || writebackConfig.every((c) => !c.enabled);

  // Planning-vendor list for the inline "assign vendor" selects on null-vendor rows.
  const [vendors, setVendors] = useState<Array<{ id: string; vendor_code: string; name: string }>>([]);
  useEffect(() => {
    let alive = true;
    wholesaleRepo.listVendors().then((v) => { if (alive) setVendors(v); }).catch(() => { /* selects stay empty */ });
    return () => { alive = false; };
  }, []);
  const vendorById = useMemo(() => new Map(vendors.map((v) => [v.id, v])), [vendors]);
  const vendorOptions = useMemo(
    () => vendors.map((v) => ({ value: v.id, label: v.vendor_code ? `${v.name} · ${v.vendor_code}` : v.name })),
    [vendors],
  );

  // POs created for this batch survive a refresh via response_json.tangerine_po_id.
  const posCreated = useMemo(
    () => actions.some((a) => !!(a.response_json as { tangerine_po_id?: string } | null)?.tangerine_po_id),
    [actions],
  );

  // After assigning a vendor to one null-vendor line we offer to apply it to the
  // remaining unassigned lines of the same style.
  const [applyAll, setApplyAll] = useState<{ vendorId: string; style: string; actionIds: string[]; vendorLabel: string } | null>(null);

  // Additive per-column sort over the actions list (rows keyed on a.id, so
  // re-ordering never disturbs the inline approved-qty editor or row actions).
  const { sorted: sortedActions, sortKey, sortDir, onHeaderClick } = useSort(actions, {
    persistKey: "ip:execution_actions:sort",
    accessors: {
      type: (a) => a.action_type,
      sku: (a) => itemById.get(a.sku_id)?.sku_code ?? "",
      period: (a) => a.period_start ?? "",
      po: (a) => a.po_number ?? "",
      suggested: (a) => a.suggested_qty ?? 0,
      approved: (a) => a.approved_qty ?? 0,
      method: (a) => a.execution_method ?? "",
      status: (a) => a.execution_status ?? "",
      reason: (a) => a.action_reason ?? "",
    },
  });
  const actionById = useMemo(() => new Map(actions.map((a) => [a.id, a])), [actions]);
  // Resolve an action id to its SKU code for human-readable log/validation lines (never show a raw UUID).
  const actionLabel = (id: string): string => itemById.get(actionById.get(id)?.sku_id ?? "")?.sku_code ?? "—";

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
    if (!(await confirmDialog("Archive this batch?"))) return;
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
      await exportExecutionBatch({ batch, actions, run, items, categories, names: nameMaps });
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
    if (!(await confirmDialog("Submit approved actions for writeback? Live mode will hit ERP endpoints when enabled.", { title: "Submit for writeback", confirmText: "Submit" }))) return;
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

  // M31 (direction A) — preview (dry-run) which draft POs this buy plan would
  // create, and why actions get skipped, WITHOUT writing anything.
  async function previewPos() {
    setBusy(true);
    try {
      const r = await createTangerinePos({ batch, dryRun: true });
      setPoResult(r);
      const elig = r.diagnostics?.eligible_lines ?? 0;
      onToast({ text: r.message || `Preview — ${elig} line(s) across ${r.created.length} vendor(s)`, kind: "success" });
    } catch (e) {
      onToast({ text: "Preview failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally { setBusy(false); }
  }

  // M31 (direction A) — create DRAFT native Tangerine POs from this buy plan
  // (one draft PO per vendor). Operator issues them in Tangerine Procurement.
  async function createPos() {
    if (!(await confirmDialog(
      "Create DRAFT native Tangerine purchase orders from this buy plan?\n\nThe server groups create_buy_request actions by vendor → one draft PO each. You then review + issue them in Tangerine → Procurement → Purchase Orders (issuing assigns the PO number and opens commitments).\n\nTip: use \"Preview POs\" first to see what will be created and which actions will skip.",
      { title: "Create Tangerine POs", confirmText: "Create POs", confirmColor: "#EA580C" },
    ))) return;
    setBusy(true);
    try {
      const r = await createTangerinePos({ batch });
      setPoResult(r);
      onToast({ text: r.message || `Created ${r.created.length} draft PO(s)`, kind: r.created.length ? "success" : "error" });
      await onChange();
    } catch (e) {
      onToast({ text: "Create POs failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally { setBusy(false); }
  }

  // One-click resolve of an unlinked planning vendor → Tangerine vendor, then
  // re-preview so the skipped lines move into the eligible set.
  async function linkVendor(s: TangerineVendorSuggestion, tangerineVendorId: string) {
    setBusy(true);
    try {
      const r = await linkPlanningVendor({ planningVendorId: s.planning_vendor_id, tangerineVendorId });
      onToast({ text: r.message, kind: "success" });
      const preview = await createTangerinePos({ batch, dryRun: true });
      setPoResult(preview);
    } catch (e) {
      onToast({ text: "Link failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally { setBusy(false); }
  }

  async function moveToReady() {
    setBusy(true);
    try {
      await transitionBatch({ batch, to: "ready" });
      await onChange();
    } catch (e) {
      onToast({ text: String(e instanceof Error ? e.message : e), kind: "error" });
    } finally { setBusy(false); }
  }

  // Assign a planning vendor to a null-vendor action (direct PATCH, works even on
  // a locked/approved batch — that's when the PO preview surfaces the skip).
  async function assignVendor(action: IpExecutionAction, vendorId: string) {
    if (!vendorId) return;
    try {
      await executionRepo.updateActionVendor(action.id, vendorId);
      const style = styleOf(itemById.get(action.sku_id)?.sku_code ?? "");
      const siblings = actions.filter(
        (a) => a.id !== action.id && a.vendor_id == null && style !== "" &&
          styleOf(itemById.get(a.sku_id)?.sku_code ?? "") === style,
      );
      setApplyAll(siblings.length > 0
        ? { vendorId, style, actionIds: siblings.map((a) => a.id), vendorLabel: vendorById.get(vendorId)?.name ?? "vendor" }
        : null);
      onToast({ text: "Vendor assigned", kind: "success" });
      await onChange();
    } catch (e) {
      onToast({ text: "Assign vendor failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    }
  }

  async function applyVendorToAll() {
    if (!applyAll) return;
    setBusy(true);
    try {
      for (const id of applyAll.actionIds) {
        await executionRepo.updateActionVendor(id, applyAll.vendorId);
      }
      onToast({ text: `Applied ${applyAll.vendorLabel} to ${applyAll.actionIds.length} line(s)`, kind: "success" });
      setApplyAll(null);
      await onChange();
    } catch (e) {
      onToast({ text: "Apply failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally { setBusy(false); }
  }

  // The NextStep banner routes onto the existing handlers by action kind.
  function runNextAction(kind: NextStepActionKind) {
    switch (kind) {
      case "moveReady": void moveToReady(); break;
      case "approve":   void approveBatch(); break;
      case "preview":   void previewPos(); break;
      case "createPos": void createPos(); break;
      case "issue":     if (typeof window !== "undefined") window.open(PO_PANEL_URL, "_blank", "noreferrer"); break;
    }
  }

  async function editApprovedQty(action: IpExecutionAction) {
    const current = action.approved_qty ?? action.suggested_qty;
    const raw = await promptDialog(`Approved qty for ${action.action_type}`, { title: "Approved qty", inputType: "number", defaultValue: String(current) });
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
    if (!(await confirmDialog("Remove this action from the batch?"))) return;
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

  const nextStep = nextStepFor(batch, poResult, { canApproveBatch, posCreated });
  const nextTone = nextStep.tone === "done" ? PAL.green
    : nextStep.tone === "blocked" ? PAL.yellow
    : nextStep.tone === "muted" ? PAL.textMuted
    : PAL.accent;

  return (
    <div>
      {/* NextStep banner — always states the single next action for this batch */}
      <div style={{ ...S.card, marginBottom: 12, borderLeft: `4px solid ${nextTone}`, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ color: PAL.text, fontWeight: 700, fontSize: 14 }}>{nextStep.title}</div>
          {nextStep.detail && <div style={{ color: PAL.textMuted, fontSize: 12, marginTop: 3 }}>{nextStep.detail}</div>}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {nextStep.href && (
            <a href={nextStep.href} target="_blank" rel="noreferrer"
               style={{ ...S.btnPrimary, background: PAL.green, textDecoration: "none", display: "inline-block" }}>
              Issue in Procurement →
            </a>
          )}
          {nextStep.secondary && (
            <button style={S.btnSecondary} disabled={busy} onClick={() => runNextAction(nextStep.secondary!.kind)}>
              {nextStep.secondary.label}
            </button>
          )}
          {nextStep.primary && (
            <button
              style={{ ...S.btnPrimary, ...(nextStep.primary.kind === "createPos" ? { background: "#EA580C" } : {}) }}
              disabled={busy}
              onClick={() => runNextAction(nextStep.primary!.kind)}>
              {nextStep.primary.label}
            </button>
          )}
        </div>
      </div>

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
              <button style={S.btnSecondary} disabled={busy} onClick={moveToReady}>
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
            {locked && canBatchTransition(batch.status, "ready") && (
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
        {(() => {
          const poDisabled = busy || !canWriteback || (batch.status !== "approved" && batch.status !== "exported" && batch.status !== "submitted" && batch.status !== "partially_executed");
          const xoroButtons = (
            <>
              <button style={S.btnSecondary} disabled={busy || !canWriteback} onClick={dryRun}
                      title={canWriteback ? "" : "Missing permission: run_writeback"}>
                Dry-run writeback
              </button>
              <button style={S.btnSecondary}
                      disabled={busy || !canWriteback || (batch.status !== "approved" && batch.status !== "exported")}
                      title={canWriteback ? "" : "Missing permission: run_writeback"}
                      onClick={submit}>
                Submit writeback
              </button>
            </>
          );
          return (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <button style={S.btnSecondary} disabled={busy || batch.status === "draft" || !canExport} onClick={exportXlsx}
                      title={canExport ? "" : "Missing permission: run_exports"}>
                Export xlsx
              </button>
              <button style={S.btnSecondary} disabled={poDisabled}
                      title={canWriteback ? "Preview (dry-run) the draft POs this buy plan would create — no writes" : "Missing permission: run_writeback"}
                      onClick={previewPos}>
                🔍 Preview POs
              </button>
              <button style={{ ...S.btnPrimary, background: "#EA580C", fontSize: 14, padding: "8px 18px" }}
                      disabled={poDisabled}
                      title={canWriteback ? "Create draft native Tangerine POs (one per vendor) from this buy plan" : "Missing permission: run_writeback"}
                      onClick={createPos}>
                🍊 Create Tangerine POs
              </button>
              {allXoroDisabled ? (
                <details style={{ marginLeft: "auto" }}>
                  <summary style={{ color: PAL.textMuted, fontSize: 12, cursor: "pointer", listStyle: "revert" }}>
                    Legacy Xoro writeback (disabled)
                  </summary>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginTop: 8 }}>
                    {xoroButtons}
                    <span style={{ color: PAL.textMuted, fontSize: 11 }}>
                      All Xoro endpoints are disabled — these are dry-run only and do not affect Tangerine POs.
                    </span>
                  </div>
                </details>
              ) : (
                <>
                  {xoroButtons}
                  <span style={{ color: PAL.yellow, fontSize: 11 }}>Xoro writeback partially enabled — live endpoints exist.</span>
                </>
              )}
            </div>
          );
        })()}

        {poResult && (
          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 4 }}>
            {/* Diagnostics summary banner */}
            {poResult.diagnostics && (
              <div style={{ background: PAL.accent + "18", color: PAL.text, padding: "8px 10px", borderRadius: 6, fontSize: 12, display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
                <b style={{ color: poResult.dry_run ? PAL.accent : PAL.green }}>{poResult.dry_run ? "PREVIEW" : "DONE"}</b>
                <span>{poResult.diagnostics.eligible_lines} eligible line(s) → {poResult.diagnostics.vendors} vendor PO(s)</span>
                {poResult.diagnostics.skipped > 0 && <span style={{ color: PAL.textMuted }}>· {poResult.diagnostics.skipped} skipped</span>}
                {poResult.diagnostics.warnings > 0 && <span style={{ color: PAL.yellow }}>· {poResult.diagnostics.warnings} cost warning(s)</span>}
                {Object.entries(poResult.diagnostics.skip_breakdown || {}).map(([code, n]) => (
                  <span key={code} style={{ ...S.chip, background: PAL.textMuted + "22", color: PAL.textMuted, fontSize: 11 }}>
                    {n}× {SKIP_LABEL[code] || code}
                  </span>
                ))}
              </div>
            )}

            {/* Vendor-skip fix hints — each of the three vendor skip reasons with
                its fix affordance pointed at the right place. */}
            {poResult.diagnostics && (() => {
              const sb = poResult.diagnostics.skip_breakdown || {};
              const rows: ReactNode[] = [];
              if (sb.no_vendor) rows.push(
                <div key="nv">{sb.no_vendor} line(s) have <b>no vendor</b> — assign one inline in the Actions table below (the yellow selects).</div>,
              );
              if (sb.vendor_unlinked) rows.push(
                <div key="vu">{sb.vendor_unlinked} line(s) use a planning vendor <b>not linked to Tangerine</b> — use the 🔗 Link buttons below, or <a href={VENDORS_URL} style={{ color: PAL.accent, textDecoration: "underline" }}>manage vendors →</a>.</div>,
              );
              if (sb.vendor_missing) rows.push(
                <div key="vm">{sb.vendor_missing} line(s) reference a vendor <b>not in the planning master</b> — <a href={VENDORS_URL} style={{ color: PAL.accent, textDecoration: "underline" }}>manage vendors →</a>.</div>,
              );
              if (rows.length === 0) return null;
              return (
                <div style={{ background: PAL.yellow + "14", color: PAL.text, padding: "8px 10px", borderRadius: 6, fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>
                  {rows}
                </div>
              );
            })()}

            {poResult.created.map((c, i) => (
              <div key={(c.po_id || "preview") + i} style={{ background: PAL.green + "22", color: PAL.green, padding: "6px 10px", borderRadius: 6, fontSize: 12, fontFamily: "monospace", display: "flex", alignItems: "center", gap: 8 }}>
                <span>{c.preview ? "[preview] " : "✓ "}{c.vendor_name || "—"} · {c.line_count} line(s) · ${(c.total_cents / 100).toFixed(2)}{c.po_id ? ` · PO (draft)` : ""}</span>
                {c.po_id && (
                  <a href={PO_PANEL_URL} target="_blank" rel="noreferrer" style={{ color: PAL.accent, textDecoration: "underline" }}>open in Procurement →</a>
                )}
              </div>
            ))}

            {/* Unlinked-vendor suggestions with one-click Link */}
            {poResult.vendor_suggestions.filter((s) => s.candidates.length > 0).map((s) => (
              <div key={"vs" + s.planning_vendor_id} style={{ background: PAL.yellow + "18", color: PAL.text, padding: "6px 10px", borderRadius: 6, fontSize: 12, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ color: PAL.yellow }}>link planning vendor <b>{s.vendor_code || s.name}</b> →</span>
                {s.candidates.map((cand) => (
                  <button key={cand.id} style={{ ...S.btnGhost, fontSize: 12 }} disabled={busy} onClick={() => linkVendor(s, cand.id)}
                          title={`Set portal_vendor_id → ${cand.name} (matched on ${cand.match_on})`}>
                    {cand.name} ({cand.match_on})
                  </button>
                ))}
              </div>
            ))}
            {poResult.vendor_suggestions.filter((s) => s.candidates.length === 0).map((s) => (
              <div key={"vsn" + s.planning_vendor_id} style={{ background: PAL.textMuted + "18", color: PAL.textMuted, padding: "6px 10px", borderRadius: 6, fontSize: 12 }}>
                planning vendor <b>{s.vendor_code || s.name}</b> has no Tangerine match —{" "}
                <a href={VENDORS_URL} style={{ color: PAL.accent, textDecoration: "underline" }}>manage vendors →</a>
              </div>
            ))}

            {poResult.warnings.map((w) => (
              <div key={"w" + w.action_id} style={{ background: PAL.yellow + "22", color: PAL.yellow, padding: "6px 10px", borderRadius: 6, fontSize: 12, fontFamily: "monospace" }}>
                {actionLabel(w.action_id)} · {w.message}
              </div>
            ))}
            {poResult.skipped.filter((s) => s.code !== "vendor_unlinked").map((s) => (
              <div key={"s" + s.action_id} style={{ background: PAL.textMuted + "22", color: PAL.textMuted, padding: "6px 10px", borderRadius: 6, fontSize: 12, fontFamily: "monospace" }}>
                skipped {actionLabel(s.action_id)} · {s.reason}
              </div>
            ))}
          </div>
        )}

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
                [{r.dry_run ? "dry" : "live"}] {actionLabel(r.action_id)} · {r.status} · {r.message}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Actions table */}
      <div style={S.card}>
        <h4 style={S.cardTitle}>Actions</h4>

        {/* Apply-a-just-picked-vendor to every unassigned line of the same style. */}
        {applyAll && (
          <div style={{ background: PAL.accent + "18", color: PAL.text, padding: "8px 10px", borderRadius: 6, fontSize: 12, marginBottom: 10, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span>Apply <b>{applyAll.vendorLabel}</b> to all <b>{applyAll.actionIds.length}</b> unassigned line(s) of style <code style={{ color: PAL.text }}>{applyAll.style}</code>?</span>
            <button style={S.btnPrimary} disabled={busy} onClick={applyVendorToAll}>Apply to all {applyAll.actionIds.length}</button>
            <button style={S.btnGhost} disabled={busy} onClick={() => setApplyAll(null)}>Dismiss</button>
          </div>
        )}

        <div style={S.tableWrap}>
          <table style={S.table}>
            <thead>
              <tr>
                <SortableTh label="Type" sortKey="type" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} />
                <SortableTh label="SKU" sortKey="sku" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} />
                <th style={S.th}>Vendor</th>
                <SortableTh label="Period" sortKey="period" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} />
                <SortableTh label="PO" sortKey="po" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} />
                <th style={S.th}>Tangerine PO</th>
                <SortableTh label="Suggested" sortKey="suggested" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} cellStyle={{ textAlign: "right" }} />
                <SortableTh label="Approved" sortKey="approved" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} cellStyle={{ textAlign: "right" }} />
                <SortableTh label="Method" sortKey="method" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} />
                <SortableTh label="Status" sortKey="status" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} />
                <SortableTh label="Reason" sortKey="reason" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} />
                <th style={S.th}></th>
              </tr>
            </thead>
            <tbody>
              {sortedActions.map((a) => {
                const item = itemById.get(a.sku_id);
                const cfg = cfgByType.get(a.action_type);
                const apiAllowed = !!cfg?.enabled;
                return (
                  <tr key={a.id} style={{ background: a.execution_status === "failed" ? "#3f1d1d22" : undefined }}>
                    <td style={S.td}>{a.action_type.replace(/_/g, " ")}</td>
                    <td style={{ ...S.td, fontFamily: "monospace", color: PAL.accent }}>
                      {item?.sku_code ?? "—"}
                    </td>
                    <td style={S.td}>
                      {a.vendor_id ? (
                        <span style={{ color: PAL.textDim, fontSize: 12 }}>
                          {vendorById.get(a.vendor_id)?.name ?? a.vendor_id.slice(0, 8)}
                        </span>
                      ) : (
                        <SearchableSelect
                          value={null}
                          onChange={(v) => assignVendor(a, v)}
                          placeholder="assign vendor"
                          options={[{ value: "", label: "— assign vendor —" }, ...vendorOptions]}
                          inputStyle={{ ...S.select, padding: "4px 8px", fontSize: 12, minWidth: 150, borderColor: PAL.yellow }}
                        />
                      )}
                    </td>
                    <td style={S.td}>{a.period_start ?? "–"}</td>
                    <td style={S.td}>{a.po_number ?? "–"}</td>
                    <td style={S.td}>
                      {(() => {
                        const tpo = (a.response_json as { tangerine_po_id?: string } | null)?.tangerine_po_id;
                        return tpo ? (
                          <a href={PO_PANEL_URL} target="_blank" rel="noreferrer"
                             style={{ ...S.chip, background: PAL.green + "22", color: PAL.green, textDecoration: "none" }}
                             title={`Draft Tangerine PO ${tpo} — open Procurement`}>
                            draft PO
                          </a>
                        ) : <span style={{ color: PAL.textMuted }}>–</span>;
                      })()}
                    </td>
                    <td style={S.tdNum}>{formatQty(a.suggested_qty)}</td>
                    <td style={{ ...S.tdNum, color: locked ? PAL.textDim : PAL.accent, cursor: locked ? "default" : "pointer" }}
                        onClick={() => !locked && editApprovedQty(a)}>
                      {a.approved_qty == null ? "click to set" : formatQty(a.approved_qty)}
                    </td>
                    <td style={S.td}>
                      <SearchableSelect
                        disabled={locked}
                        value={a.execution_method}
                        onChange={(v) => changeMethod(a, v as IpExecutionMethod)}
                        options={[
                          { value: "export_only", label: "export_only" },
                          { value: "manual_erp_entry", label: "manual_erp_entry" },
                          { value: "api_writeback", label: `api_writeback ${apiAllowed ? "" : "(disabled)"}`, disabled: !apiAllowed },
                        ]}
                        inputStyle={{ ...S.select, padding: "4px 8px", fontSize: 12 }}
                      />
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
                <tr><td colSpan={12} style={{ ...S.td, textAlign: "center", color: PAL.textMuted, padding: 40 }}>
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
                {i.severity === "error" ? "✕" : "!"} {actionLabel(i.action_id)} · {i.field ?? ""} — {i.message}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

