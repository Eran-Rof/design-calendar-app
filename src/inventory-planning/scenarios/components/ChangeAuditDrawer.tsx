// Right-side drawer that lists audit entries for a scenario or run.
// Read-only — any "undo" action belongs to the caller service.

import type { IpChangeAuditLog } from "../types/scenarios";
import { S, PAL, formatDateTime } from "../../components/styles";

export interface ChangeAuditDrawerProps {
  entries: IpChangeAuditLog[];
  title: string;
  onClose: () => void;
}

export default function ChangeAuditDrawer({ entries, title, onClose }: ChangeAuditDrawerProps) {
  return (
    <div style={S.drawerOverlay} onClick={onClose}>
      <div style={{ ...S.drawer, width: 560 }} onClick={(e) => e.stopPropagation()}>
        <div style={S.drawerHeader}>
          <div>
            <h3 style={{ margin: 0, fontSize: 15 }}>{title}</h3>
            <div style={{ fontSize: 12, color: PAL.textMuted }}>{entries.length} entries</div>
          </div>
          <button style={S.btnGhost} onClick={onClose}>✕</button>
        </div>
        <div style={S.drawerBody}>
          {entries.length === 0 ? (
            <div style={{ color: PAL.textMuted, padding: 16 }}>No audit entries yet.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {entries.map((e) => (
                <div key={e.id} style={{ ...S.infoCell, padding: "10px 12px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <span style={{ fontWeight: 600 }}>
                      {e.entity_type}
                      {e.changed_field ? ` · ${e.changed_field}` : ""}
                    </span>
                    <span style={{ fontSize: 11, color: PAL.textMuted }}>{formatDateTime(e.created_at)}</span>
                  </div>
                  {(e.old_value || e.new_value) && (
                    <div style={{ fontSize: 12, color: PAL.textDim, marginTop: 4, fontFamily: "monospace" }}>
                      {e.old_value ? `${e.old_value}` : "∅"} → {e.new_value ? `${e.new_value}` : "∅"}
                    </div>
                  )}
                  {e.change_reason && (
                    <div style={{ fontSize: 12, color: PAL.textDim, marginTop: 4 }}>
                      Reason: {e.change_reason}
                    </div>
                  )}
                  {e.changed_by && (
                    <div style={{ fontSize: 11, color: PAL.textMuted, marginTop: 2 }}>
                      by {e.changed_by}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
