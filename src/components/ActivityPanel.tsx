import React, { useState } from "react";
import { TH } from "../utils/theme";
import { formatDate, formatDT, toDateStr } from "../utils/dates";
import Avatar from "./Avatar";

function ActivityPanel({ tasks, globalLog = [], currentUser, isAdmin, team, onClose }: {
  tasks: any[];
  globalLog?: any[];
  currentUser: any;
  isAdmin: boolean;
  team: any[];
  onClose: () => void;
}) {
  const canViewAll = isAdmin || currentUser.permissions?.view_all_activity;
  const [daysBack, setDaysBack] = useState(1); // 1=today, 7=week, 30=month

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (daysBack - 1));
  cutoff.setHours(0, 0, 0, 0);

  const allEntries = [
    ...tasks.flatMap(t =>
      (t.history || []).map((h: any) => ({
        ...h,
        taskPhase: t.phase,
        taskCollection: t.collection,
        taskBrand: t.brand,
      }))
    ),
    ...globalLog,
  ];

  const filtered = allEntries
    .filter(h => {
      if (!h.at) return false;
      if (new Date(h.at) < cutoff) return false;
      if (!canViewAll && h.changedBy !== currentUser.name) return false;
      return true;
    })
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  const FIELD_ICONS: Record<string, string> = { "due date": "📅", "status": "🔄", "assignee": "👤", "vendor": "🏭", "note added": "📝", "order type": "📦", "category": "🗂️", "season": "🌿", "customer": "🏪", "collection created": "✨", "collection deleted": "🗑️", "collection renamed": "✏️", "DDP date": "📅", "task created": "➕", "task deleted": "🗑️", "SKUs updated": "🏷️" };

  // Group by date label
  const grouped: Record<string, typeof filtered> = {};
  filtered.forEach(h => {
    const d = new Date(h.at);
    const today = new Date(); today.setHours(0,0,0,0);
    const yesterday = new Date(today); yesterday.setDate(today.getDate()-1);
    let label: string;
    d.setHours(0,0,0,0);
    if (d.getTime() === today.getTime()) label = "Today";
    else if (d.getTime() === yesterday.getTime()) label = "Yesterday";
    else label = formatDate(toDateStr(d));
    if (!grouped[label]) grouped[label] = [];
    grouped[label].push(h);
  });

  return (
    <div style={{ position: "fixed", top: 0, right: 0, width: 420, height: "100vh", background: "#fff", boxShadow: "-4px 0 32px rgba(0,0,0,0.18)", zIndex: 1200, display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <div style={{ padding: "18px 20px 14px", borderBottom: `1px solid ${TH.border}`, display: "flex", justifyContent: "space-between", alignItems: "center", background: TH.header }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#fff" }}>Activity Log</div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", marginTop: 2 }}>
            {canViewAll ? "All team activity" : "Your activity only"}
          </div>
        </div>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "rgba(255,255,255,0.7)", fontSize: 18, cursor: "pointer", padding: "4px 8px" }}>✕</button>
      </div>

      {/* Filter pills */}
      <div style={{ padding: "10px 16px", borderBottom: `1px solid ${TH.border}`, display: "flex", gap: 6 }}>
        {([[1,"Today"],[7,"Last 7 Days"],[30,"Last 30 Days"]] as [number, string][]).map(([d, label]) => (
          <button key={d} onClick={() => setDaysBack(d)}
            style={{ padding: "4px 12px", borderRadius: 20, border: `1px solid ${daysBack === d ? TH.primary : TH.border}`, background: daysBack === d ? TH.primary : "none", color: daysBack === d ? "#fff" : TH.textMuted, cursor: "pointer", fontSize: 12, fontFamily: "inherit", fontWeight: 600 }}>
            {label}
          </button>
        ))}
      </div>

      {/* Entries */}
      <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px" }}>
        {filtered.length === 0 && (
          <div style={{ textAlign: "center", color: TH.textMuted, padding: "48px 24px", fontSize: 13 }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>📋</div>
            No activity {daysBack === 1 ? "today" : `in the last ${daysBack} days`}.
          </div>
        )}
        {Object.entries(grouped).map(([dateLabel, entries]) => (
          <div key={dateLabel}>
            <div style={{ fontSize: 11, fontWeight: 700, color: TH.textMuted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8, marginTop: 8 }}>{dateLabel}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {entries.map(h => {
                const icon = FIELD_ICONS[h.field] || "✏️";
                const accentColor = (h.field === "due date" || h.field === "DDP date") ? "#1D4ED8" : (h.field === "status" || h.field === "collection created" || h.field === "task created") ? "#059669" : (h.field === "collection deleted" || h.field === "task deleted") ? "#DC2626" : h.field === "note added" ? "#7C3AED" : TH.primary;
                const member = team.find((m: any) => m.name === h.changedBy);
                return (
                  <div key={h.id} style={{ background: TH.surfaceHi, borderRadius: 8, padding: "10px 12px", borderLeft: `3px solid ${accentColor}55` }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 13 }}>{icon}</span>
                        <span style={{ fontSize: 12, fontWeight: 700, color: accentColor, textTransform: "capitalize" }}>{h.field}</span>
                      </div>
                      <span style={{ fontSize: 10, color: TH.textMuted }}>{formatDT(h.at)}</span>
                    </div>
                    <div style={{ fontSize: 11, color: TH.textMuted, marginBottom: 4 }}>
                      <span style={{ fontWeight: 600, color: TH.textSub }}>{h.taskBrand} / {h.taskCollection}</span>
                      {h.taskPhase && <span> · {h.taskPhase}</span>}
                    </div>
                    {h.field !== "note added" ? (
                      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", fontSize: 11 }}>
                        <span style={{ background: "#FEF2F2", border: "1px solid #FCA5A5", padding: "1px 6px", borderRadius: 4, color: "#991B1B", textDecoration: "line-through" }}>{h.from || "—"}</span>
                        <span style={{ color: TH.textMuted }}>→</span>
                        <span style={{ background: "#F0FDF4", border: "1px solid #86EFAC", padding: "1px 6px", borderRadius: 4, color: "#166534", fontWeight: 600 }}>{h.to || "—"}</span>
                      </div>
                    ) : (
                      <div style={{ fontSize: 11, color: TH.textSub, fontStyle: "italic" }}>"{h.to}"</div>
                    )}
                    <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 6 }}>
                      {member && <Avatar member={member} size={16} />}
                      <span style={{ fontSize: 11, color: TH.textMuted }}>{h.changedBy}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default ActivityPanel;
