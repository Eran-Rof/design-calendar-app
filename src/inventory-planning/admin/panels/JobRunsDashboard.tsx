// Jobs dashboard: queued/running/failed/succeeded with per-job detail drawer + retry.

import { useEffect, useMemo, useState } from "react";
import type { IpJobRun, IpJobStatus } from "../../jobs/types/jobs";
import { listRecentJobs, retry } from "../../jobs/services/jobRunService";
import { S, PAL, formatDateTime } from "../../components/styles";
import type { ToastMessage } from "../../components/Toast";

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
        <select style={S.select} value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
          <option value="all">All statuses</option>
          {Object.keys(counts).map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
        </select>
        <select style={S.select} value={filterType} onChange={(e) => setFilterType(e.target.value)}>
          <option value="all">All types</option>
          {types.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <button style={S.btnSecondary} onClick={refresh}>Refresh</button>
      </div>

      <div style={S.tableWrap}>
        <table style={S.table}>
          <thead>
            <tr>
              <th style={S.th}>Status</th>
              <th style={S.th}>Type</th>
              <th style={S.th}>Scope</th>
              <th style={S.th}>Started</th>
              <th style={S.th}>Completed</th>
              <th style={S.th}>Initiator</th>
              <th style={{ ...S.th, textAlign: "right" }}>Retry #</th>
              <th style={S.th}>Error</th>
              <th style={S.th}></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.id} style={{ cursor: "pointer", background: r.status === "failed" ? "#3f1d1d22" : undefined }}
                  onClick={() => setSelected(r)}>
                <td style={S.td}>
                  <span style={{ ...S.chip, background: STATUS_COLOR[r.status] + "33", color: STATUS_COLOR[r.status] }}>
                    {r.status.replace(/_/g, " ")}
                  </span>
                </td>
                <td style={S.td}>{r.job_type}</td>
                <td style={{ ...S.td, fontFamily: "monospace", color: PAL.textDim, fontSize: 11 }}>{r.job_scope ?? ""}</td>
                <td style={{ ...S.td, fontSize: 11, color: PAL.textDim }}>{r.started_at ? formatDateTime(r.started_at) : "—"}</td>
                <td style={{ ...S.td, fontSize: 11, color: PAL.textDim }}>{r.completed_at ? formatDateTime(r.completed_at) : "—"}</td>
                <td style={{ ...S.td, fontSize: 11 }}>{r.initiated_by ?? ""}</td>
                <td style={S.tdNum}>{r.retry_count}</td>
                <td style={{ ...S.td, fontSize: 11, color: PAL.red }}>{r.error_message ?? ""}</td>
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
                <div style={{ fontSize: 12, color: PAL.textMuted }}>{selected.id.slice(0, 8)} · {selected.status}</div>
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
