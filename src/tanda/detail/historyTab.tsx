import React from "react";
import { fmtDate } from "../../utils/tandaTypes";
import S from "../styles";
import type { DetailPanelCtx } from "../detailPanel";

/**
 * History tab body. Read-only timeline of PO change history entries
 * (synthetic notes with status_override === "__history__").
 */
export function HistoryTab({ ctx }: { ctx: DetailPanelCtx }): React.ReactElement | null {
  const { selected, detailMode, selectedHistory } = ctx;

  if (!selected) return null;
  if (!(detailMode === "history" || detailMode === "all")) return null;

  return (
    <div>
      <div style={S.sectionLabel}>Change History</div>
      {selectedHistory.length === 0 && <p style={{ color: "#6B7280", fontSize: 13 }}>No history recorded yet.</p>}
      {selectedHistory.map(h => (
        <div key={h.id} style={{ display: "flex", gap: 12, padding: "10px 14px", borderBottom: "1px solid #334155", alignItems: "flex-start" }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#3B82F6", marginTop: 6, flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <p style={{ color: "#D1D5DB", fontSize: 14, margin: 0 }}>{h.note}</p>
            <div style={{ display: "flex", gap: 12, marginTop: 4, fontSize: 11, color: "#6B7280" }}>
              <span>{h.user_name}</span>
              <span>{fmtDate(h.created_at)} {new Date(h.created_at).toLocaleTimeString()}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
