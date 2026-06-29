// Jobs dashboard: queued/running/failed/succeeded with per-job detail drawer + retry.

import { useEffect, useMemo, useState } from "react";
import type { IpJobRun, IpJobStatus } from "../../jobs/types/jobs";
import { listRecentJobs, retry } from "../../jobs/services/jobRunService";
import { S, PAL, formatDateTime } from "../../components/styles";
import type { ToastMessage } from "../../components/Toast";
import { useTablePrefs, TablePrefsButton, type ColumnDef } from "../../../tanda/components/TablePrefs";
import { useSort } from "../../../tanda/hooks/useSort";
import SortableTh from "../../../tanda/components/SortableTh";
import SearchableSelect from "../../../tanda/components/SearchableSelect";

const TABLE_KEY = "ip.job_runs";
const ALL_COLUMNS: ColumnDef[] = [
  { key: "status", label: "Status" },
  { key: "type", label: "Type" },
  { key: "scope", label: "Scope" },
  { key: "started", label: "Started" },
  { key: "completed", label: "Completed" },
  { key: "initiator", label: "Initiator" },
  { key: "retry", label: "Retry #" },
  { key: "error", label: "Error" },
];

const STATUS_COLOR: Record<string, string> = {
  queued:          "#94A3B8",
  running:         "#3B82F6",
  succeeded:       "#10B981",
  failed:          "#EF4444",
  cancelled:       "#6B7280",
  partial_success: "#F59E0B",
};

export interface JobRunsDashboardProps {
  onToast: (t: ToastMessage) => void;
  currentUserEmail: string;
}

export default function JobRunsDashboard({ onToast, currentUserEmail }: JobRunsDashboardProps) {
  const [rows, setRows] = useState<IpJobRun[]>([]);
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [filterType, setFilterType] = useState<string>("all");
  const [selected, setSelected] = useState<IpJobRun | null>(null);
  const { visibleColumns, toggleColumn, setAllVisible, resetToDefault } = useTablePrefs(TABLE_KEY, ALL_COLUMNS);

  async function refresh() {
    const all = await listRecentJobs({ limit: 500 });
    setRows(all);
  }
  useEffect(() => { void refresh(); }, []);

  const types = useMemo(() => Array.from(new Set(rows.map((r) => r.job_type))).sort(), [rows]);
  const visible = useMemo(() => rows.filter((r) => {
    if (filterStatus !== "all" && r.status !== filterStatus) return false;
    if (filterType !== "all" && r.job_type !== filterType) return false;
    return true;
  }), [rows, filterStatus, filterType]);

  const counts: Record<string, number> = { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0, partial_success: 0 };
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;

  // Additive per-column sort over the already-filtered rows. Every visible
  // column maps to a direct scalar field (or a trivially-correct accessor).
  const { sorted: sortedVisible, sortKey, sortDir, onHeaderClick } = useSort(visible, {
    persistKey: "ip:job_runs:sort",
    accessors: {
      type: (r) => r.job_type ?? "",
      scope: (r) => r.job_scope ?? "",
      started: (r) => r.started_at ?? "",
      completed: (r) => r.completed_at ?? "",
      initiator: (r) => r.initiated_by ?? "",
      retry: (r) => r.retry_count,
      error: (r) => r.error_message ?? "",
    },
  });

  async function doRetry(job: IpJobRun) {
    try {
      await retry(job, currentUserEmail);
      onToast({ text: "Retry queued", kind: "success" });
      await refresh();
    } catch (e) {
      onToast({ text: String(e instanceof Error ? e.message : e), kind: "error" });
    }
  }

  return (
    <div>
      <div style={S.statsRow}>
        {(["queued", "running", "failed", "succeeded", "partial_success"] as IpJobStatus[]).map((k) => (
          <div key={k} style={S.statCard}>
            <div style={{ fontSize: 11, color: PAL.textMuted }}>{k.replace(/_/g, " ")}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: STATUS_COLOR[k], fontFamily: "monospace" }}>
              {counts[k] ?? 0}
            </div>
          </div>
        ))}
      </div>

      <div style={S.toolbar}>
        <SearchableSelect
          inputStyle={S.select}
          value={filterStatus}
          onChange={(v) => setFilterStatus(v)}
          options={[{ value: "all", label: "All statuses" }, ...Object.keys(counts).map((s) => ({ value: s, label: s.replace(/_/g, " ") }))]}
        />
        <SearchableSelect
          inputStyle={S.select}
          value={filterType}
          onChange={(v) => setFilterType(v)}
          options={[{ value: "all", label: "All types" }, ...types.map((t) => ({ value: t, label: t }))]}
        />
        <button style={S.btnSecondary} onClick={refresh}>Refresh</button>
        <div style={{ marginLeft: "auto" }}>
          <TablePrefsButton tableKey={TABLE_KEY} columns={ALL_COLUMNS} visibleColumns={visibleColumns}
                            onToggle={toggleColumn} onReset={resetToDefault} onSetAll={setAllVisible} />
        </div>
      </div>

      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead>
            <tr>
              <SortableTh label="Status" sortKey="status" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} hidden={!visibleColumns.has("status")} />
              <SortableTh label="Type" sortKey="type" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} hidden={!visibleColumns.has("type")} />
              <SortableTh label="Scope" sortKey="scope" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} hidden={!visibleColumns.has("scope")} />
              <SortableTh label="Started" sortKey="started" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} hidden={!visibleColumns.has("started")} />
              <SortableTh label="Completed" sortKey="completed" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} hidden={!visibleColumns.has("completed")} />
              <SortableTh label="Initiator" sortKey="initiator" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} hidden={!visibleColumns.has("initiator")} />
              <SortableTh label="Retry #" sortKey="retry" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={{ ...S.th, textAlign: "right" }} hidden={!visibleColumns.has("retry")} />
              <SortableTh label="Error" sortKey="error" activeKey={sortKey} dir={sortDir} onSort={onHeaderClick} style={S.th} hidden={!visibleColumns.has("error")} />
              <th style={S.th}></th>
            </tr>
          </thead>
          <tbody>
            {sortedVisible.map((r) => (
              <tr key={r.id} style={{ cursor: "pointer", background: r.status === "failed" ? "#3f1d1d22" : undefined }}
                  onClick={() => setSelected(r)}>
                <td hidden={!visibleColumns.has("status")} style={S.td}>
                  <span style={{ ...S.chip, background: STATUS_COLOR[r.status] + "33", color: STATUS_COLOR[r.status] }}>
                    {r.status.replace(/_/g, " ")}
                  </span>
                </td>
                <td hidden={!visibleColumns.has("type")} style={S.td}>{r.job_type}</td>
                <td hidden={!visibleColumns.has("scope")} style={{ ...S.td, fontFamily: "monospace", color: PAL.textDim, fontSize: 11 }}>{r.job_scope ?? ""}</td>
                <td hidden={!visibleColumns.has("started")} style={{ ...S.td, fontSize: 11, color: PAL.textDim }}>{r.started_at ? formatDateTime(r.started_at) : "—"}</td>
                <td hidden={!visibleColumns.has("completed")} style={{ ...S.td, fontSize: 11, color: PAL.textDim }}>{r.completed_at ? formatDateTime(r.completed_at) : "—"}</td>
                <td hidden={!visibleColumns.has("initiator")} style={{ ...S.td, fontSize: 11 }}>{r.initiated_by ?? ""}</td>
                <td hidden={!visibleColumns.has("retry")} style={S.tdNum}>{r.retry_count}</td>
                <td hidden={!visibleColumns.has("error")} style={{ ...S.td, fontSize: 11, color: PAL.red }}>{r.error_message ?? ""}</td>
                <td style={S.td}>
                  {r.status === "failed" && (
                    <button style={S.btnGhost} onClick={(e) => { e.stopPropagation(); void doRetry(r); }}>Retry</button>
                  )}
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr><td colSpan={9} style={{ ...S.td, textAlign: "center", color: PAL.textMuted, padding: 32 }}>
                No jobs match your filter.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {selected && (
        <div style={S.drawerOverlay} onClick={() => setSelected(null)}>
          <div style={S.drawer} onClick={(e) => e.stopPropagation()}>
            <div style={S.drawerHeader}>
              <div>
                <h3 style={{ margin: 0, fontSize: 15 }}>{selected.job_type}</h3>
                <div style={{ fontSize: 12, color: PAL.textMuted }}>{selected.status}</div>
              </div>
              <button style={S.btnGhost} onClick={() => setSelected(null)}>✕</button>
            </div>
            <div style={S.drawerBody}>
              <Field label="Scope" value={selected.job_scope ?? "—"} />
              <Field label="Initiator" value={selected.initiated_by ?? "—"} />
              <Field label="Started" value={selected.started_at ?? "—"} />
              <Field label="Completed" value={selected.completed_at ?? "—"} />
              <Field label="Retry count" value={String(selected.retry_count)} />
              {selected.retry_of && <Field label="Retry of" value={selected.retry_of} />}
              {selected.error_message && <Field label="Error" value={selected.error_message} color={PAL.red} />}
              <SectionLabel>Input</SectionLabel>
              <pre style={{ ...S.infoCell, fontSize: 11, overflowX: "auto", maxHeight: 200 }}>
                {JSON.stringify(selected.input_json, null, 2)}
              </pre>
              {selected.output_json && (
                <>
                  <SectionLabel>Output</SectionLabel>
                  <pre style={{ ...S.infoCell, fontSize: 11, overflowX: "auto", maxHeight: 200 }}>
                    {JSON.stringify(selected.output_json, null, 2)}
                  </pre>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ ...S.infoCell, marginBottom: 6 }}>
      <div style={S.infoLabel}>{label}</div>
      <div style={{ ...S.infoValue, color: color ?? PAL.text, fontSize: 12, fontFamily: "monospace" }}>{value}</div>
    </div>
  );
}
function SectionLabel({ children }: { children: string }) {
  return <div style={{ color: PAL.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 1, margin: "16px 0 6px" }}>{children}</div>;
}
