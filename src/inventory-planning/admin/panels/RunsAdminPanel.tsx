// Planning Admin → Runs. Lists EVERY ip_planning_runs row across all scopes
// (wholesale / ecom / all) — including reconciliation runs and orphaned
// "[Scenario]" runs that the scope-filtered workbench dropdowns never show —
// and lets the operator delete them. Deleting a run CASCADE-removes all of its
// data (forecasts / recommendations / projected / scenarios / approvals /
// exports); a run with execution batches is RESTRICTed by the DB and reported
// as such.

import { useCallback, useEffect, useState } from "react";
import type { IpPlanningRun } from "../../types/wholesale";
import { wholesaleRepo } from "../../services/wholesalePlanningRepository";
import { S, PAL, formatDate } from "../../components/styles";
import { useSort } from "../../../tanda/hooks/useSort";
import SortableTh from "../../../tanda/components/SortableTh";
import { confirmDialog } from "../../../shared/ui/warn";
import type { ToastMessage } from "../../components/Toast";

export default function RunsAdminPanel({ onToast }: { onToast: (t: ToastMessage) => void }) {
  const [runs, setRuns] = useState<IpPlanningRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setRuns(await wholesaleRepo.listAllPlanningRuns());
    } catch (e) {
      onToast({ text: "Load failed — " + (e instanceof Error ? e.message : String(e)), kind: "error" });
    } finally {
      setLoading(false);
    }
  }, [onToast]);
  useEffect(() => { void refresh(); }, [refresh]);

  // Per-column sort over the planning runs. Created maps to the raw timestamp
  // the cell formats; Horizon is a composite range and stays inert.
  const { sorted, sortKey, sortDir, onHeaderClick } = useSort(runs, {
    persistKey: "ip:runs_admin:sort",
    accessors: {
      created: (r) => r.created_at ?? "",
    },
  });

  async function del(run: IpPlanningRun) {
    const orphan = /^\[Scenario\]|^\[Saved\]/.test(run.name);
    const ok = await confirmDialog(
      `Permanently DELETE run "${run.name}" (${run.planning_scope} · ${run.status})?\n\n` +
      `This CASCADE-deletes ALL of its data — forecasts, recommendations, projected inventory, ` +
      `scenarios, approvals and exports. It cannot be undone.` +
      (orphan ? `\n\nThis looks like a leftover scenario/saved-build run — safe to remove.` : "") +
      `\n\n(A run that has execution batches can't be deleted — remove those in the Execution screen first.)`,
      { title: "Delete planning run", confirmText: "Delete run" },
    );
    if (!ok) return;
    setBusyId(run.id);
    try {
      await wholesaleRepo.deletePlanningRun(run.id);
      onToast({ text: `Deleted run "${run.name}"`, kind: "info" });
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      onToast({
        text: /23503|foreign key|violates/i.test(msg)
          ? "Can't delete — this run has execution batches. Delete them in the Execution screen first."
          : "Delete failed — " + msg,
        kind: "error",
      });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div style={S.card}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
        <h3 style={S.cardTitle}>All planning runs ({runs.length})</h3>
        <button style={S.btnSecondary} onClick={refresh} disabled={loading}>{loading ? "Loading…" : "Refresh"}</button>
        <span style={{ color: PAL.textMuted, fontSize: 12 }}>
          Every run across all scopes — including reconciliation + orphaned scenario runs the workbench dropdowns hide.
        </span>
      </div>
      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead>
            <tr>
              <SortableTh label="Name" sortKey="name" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} />
              <SortableTh label="Scope" sortKey="planning_scope" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} />
              <SortableTh label="Status" sortKey="status" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} />
              <th style={S.th}>Horizon</th>
              <SortableTh label="Created" sortKey="created" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} />
              <th style={S.th}></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.id}>
                <td style={S.td}>{r.name}</td>
                <td style={S.td}>{r.planning_scope}</td>
                <td style={S.td}>{r.status}</td>
                <td style={{ ...S.td, fontSize: 11, color: PAL.textDim }}>
                  {r.horizon_start ? `${formatDate(r.horizon_start)}–${formatDate(r.horizon_end)}` : "—"}
                </td>
                <td style={{ ...S.td, fontSize: 11, color: PAL.textDim }}>{formatDate(r.created_at.slice(0, 10))}</td>
                <td style={S.td}>
                  <button style={{ ...S.btnGhost, color: PAL.red }} disabled={busyId === r.id} onClick={() => del(r)}>
                    {busyId === r.id ? "Deleting…" : "Delete"}
                  </button>
                </td>
              </tr>
            ))}
            {!loading && runs.length === 0 && (
              <tr><td colSpan={6} style={{ ...S.td, textAlign: "center", color: PAL.textMuted, padding: 24 }}>No planning runs.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
