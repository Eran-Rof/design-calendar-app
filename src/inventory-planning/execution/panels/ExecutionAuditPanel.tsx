import type { IpExecutionAuditEntry } from "../types/execution";
import { S, PAL, formatDateTime } from "../../components/styles";

const STATUS_COLOR: Record<string, string> = {
  batch_created:    "#3B82F6",
  batch_approved:   "#10B981",
  batch_exported:   "#3B82F6",
  batch_submitted:  "#8B5CF6",
  batch_archived:   "#6B7280",
  action_succeeded: "#10B981",
  action_failed:    "#EF4444",
  dry_run:          "#94A3B8",
};

export interface ExecutionAuditPanelProps {
  entries: IpExecutionAuditEntry[];
  onClose: () => void;
}

export default function ExecutionAuditPanel({ entries, onClose }: ExecutionAuditPanelProps) {
  return (
    <div style={S.drawerOverlay} onClick={onClose}>
      <div style={{ ...S.drawer, width: 560 }} onClick={(e) => e.stopPropagation()}>
        <div style={S.drawerHeader}>
          <div>
            <h3 style={{ margin: 0, fontSize: 15 }}>Execution audit</h3>
            <div style={{ fontSize: 12, color: PAL.textMuted }}>{entries.length} entries</div>
          </div>
          <button style={S.btnGhost} onClick={onClose}>✕</button>
        </div>
        <div style={S.drawerBody}>
          {entries.length === 0 ? (
            <div style={{ color: PAL.textMuted, padding: 16 }}>No events yet.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {entries.map((e) => {
                const color = STATUS_COLOR[e.event_type]
                  ?? (e.event_type.startsWith("action_") ? PAL.textDim : PAL.textMuted);
                return (
                  <div key={e.id} style={{ ...S.infoCell, padding: "10px 12px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                      <span style={{ fontWeight: 600, color }}>{e.event_type}</span>
                      <span style={{ fontSize: 11, color: PAL.textMuted }}>{formatDateTime(e.created_at)}</span>
                    </div>
                    {(e.old_status || e.new_status) && (
                      <div style={{ fontSize: 12, color: PAL.textDim, marginTop: 4, fontFamily: "monospace" }}>
                        {e.old_status ?? "∅"} → {e.new_status ?? "∅"}
                      </div>
                    )}
                    {e.event_message && (
                      <div style={{ fontSize: 12, color: PAL.textDim, marginTop: 4 }}>{e.event_message}</div>
                    )}
                    {e.actor && (
                      <div style={{ fontSize: 11, color: PAL.textMuted, marginTop: 2 }}>by {e.actor}</div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
