import React from "react";
import { type XoroPO, type LocalNote, type View } from "../../utils/tandaTypes";

export interface ActivityViewProps {
  notes: LocalNote[];
  pos: XoroPO[];
  setDetailMode: (v: "milestones") => void;
  setNewNote: (v: string) => void;
  setSearch: (v: string) => void;
  setSelected: (v: XoroPO | null) => void;
  setView: (v: View) => void;
}

export function ActivityView({
  notes, pos, setDetailMode, setNewNote, setSearch, setSelected, setView,
}: ActivityViewProps) {
  const historyEntries = notes
    .filter(n => n.status_override === "__history__")
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))
    .slice(0, 100);

  return (
    <div style={{ maxWidth: "50%", margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2 style={{ margin: 0, color: "#F1F5F9", fontSize: 20, fontWeight: 700 }}>Activity Feed</h2>
        <span style={{ color: "#6B7280", fontSize: 12 }}>{historyEntries.length} recent activities</span>
      </div>
      <div style={{ background: "#1E293B", borderRadius: 12, border: "1px solid #334155", overflow: "hidden" }}>
        {historyEntries.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: "#6B7280" }}>No activity recorded yet</div>
        ) : historyEntries.map((entry, i) => {
          const isStatus = (entry.note ?? "").includes("Status:");
          const isBulk = (entry.note ?? "").includes("Bulk update");
          const isSync = (entry.note ?? "").includes("synced");
          const isGen = (entry.note ?? "").includes("generated") || (entry.note ?? "").includes("Regenerated");
          const icon = isBulk ? "⚡" : isSync ? "🔄" : isGen ? "🏭" : isStatus ? "📊" : "📝";
          const time = entry.created_at ? new Date(entry.created_at).toLocaleString() : "";
          const timeAgo = entry.created_at ? (() => { const ms = Date.now() - new Date(entry.created_at).getTime(); const m = Math.floor(ms / 60000); if (m < 60) return `${m}m ago`; const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`; return `${Math.floor(h / 24)}d ago`; })() : "";
          return (
            <div key={entry.id || i} style={{ display: "flex", gap: 12, padding: "14px 18px", borderBottom: "1px solid #0F172A", background: i % 2 === 0 ? "#1E293B" : "#1A2332", cursor: "pointer" }}
              onClick={() => { const p = pos.find(x => x.PoNumber === entry.po_number); if (p) { setDetailMode("milestones"); setNewNote(""); setSearch(""); setSelected(p); setView("list"); } }}>
              <div style={{ fontSize: 18, flexShrink: 0, width: 32, textAlign: "center" }}>{icon}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: "#60A5FA", fontFamily: "monospace" }}>{entry.po_number}</span>
                  <span style={{ fontSize: 12, color: "#94A3B8" }}>{entry.user_name}</span>
                  <span style={{ fontSize: 13, color: "#6B7280", marginLeft: "auto", flexShrink: 0, fontFamily: "monospace" }}>{timeAgo} · {time}</span>
                </div>
                <div style={{ fontSize: 14, color: "#D1D5DB", lineHeight: 1.5 }}>{entry.note}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
