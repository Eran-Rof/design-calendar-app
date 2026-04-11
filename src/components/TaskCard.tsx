import React from "react";
import { TH } from "../utils/theme";
import { getDaysUntil, parseLocalDate, formatDate } from "../utils/dates";
import { STATUS_CONFIG, BRANDS } from "../utils/constants";
import Avatar from "./Avatar";
import { useAppStore } from "../store";
import type { Task } from "../store/types";
import { UNKNOWN_BRAND } from "../store/types";

const DAYS_OF_WEEK = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

/**
 * Task card used on the Dashboard and filtered views.
 * Reads all state from the Zustand store — no props except task data.
 */
function TaskCard({ task, showDayDate }: { task: Task; showDayDate?: boolean }) {
  const s = useAppStore();
  const brand = s.brands.find((b) => b.id === task.brand) || s.brands[0] || BRANDS[0] || UNKNOWN_BRAND;
  const days = getDaysUntil(task.due);
  const sc = STATUS_CONFIG[task.status] || STATUS_CONFIG["Not Started"];
  const isOver = days < 0 && task.status !== "Complete";
  const assignee = s.team.find((m: any) => m.id === task.assigneeId) || null;
  const dueDate = parseLocalDate(task.due);
  const dayOfWeek = DAYS_OF_WEEK[dueDate.getDay()];
  const formattedDue = formatDate(task.due);

  return (
    <div
      draggable
      onDragStart={() => s.setField("dragId", task.id)}
      onDragOver={(e) => { e.preventDefault(); s.setField("dragOverId", task.id); }}
      onDrop={() => s.handleDrop(task.id)}
      onDragEnd={() => { s.setField("dragId", null); s.setField("dragOverId", null); }}
      onClick={(e) => { e.stopPropagation(); s.setField("editTask", task); }}
      style={{
        background: s.dragOverId === task.id ? TH.surfaceHi : TH.surface,
        border: `1px solid ${s.dragOverId === task.id ? brand.color + "88" : TH.border}`,
        borderLeft: `3px solid ${brand.color}`,
        borderRadius: 9, padding: "12px 14px", cursor: "pointer",
        transition: "all 0.15s", opacity: s.dragId === task.id ? 0.4 : 1,
        boxShadow: `0 1px 4px ${TH.shadow}`,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: TH.text }}>{task.phase}</span>
        <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 10, background: sc.bg, color: sc.color, fontWeight: 600 }}>{task.status}</span>
      </div>
      <div style={{ fontSize: 11, color: TH.textMuted, marginBottom: 2 }}>{task.collection}</div>
      <div style={{ fontSize: 11, color: TH.textSub2, marginBottom: 6 }}>{task.category}{task.vendorName ? ` · ${task.vendorName}` : ""}</div>
      {task.customer && <div style={{ fontSize: 11, color: TH.primary, fontWeight: 600, marginBottom: 5 }}>{task.customer}{task.orderType ? ` · ${task.orderType}` : ""}</div>}
      {showDayDate && (
        <div style={{ display: "flex", flexDirection: "column", gap: 2, marginBottom: 6, padding: "6px 10px", background: isOver ? "#FEF2F2" : days === 0 ? "#FFFBEB" : "#F0FDF4", borderRadius: 7, border: `1px solid ${isOver ? "#FCA5A5" : days === 0 ? "#FCD34D" : "#BBF7D0"}` }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 10, fontWeight: 600, color: TH.textMuted, textTransform: "uppercase", letterSpacing: "0.06em" }}>Due</span>
            <span style={{ fontSize: 10, fontWeight: 700, color: isOver ? "#B91C1C" : days === 0 ? "#B45309" : "#065F46" }}>{isOver ? `${Math.abs(days)}d overdue` : days === 0 ? "Today" : `In ${days}d`}</span>
          </div>
          <div style={{ fontSize: 11, fontWeight: 700, color: isOver ? "#B91C1C" : TH.text }}>{dayOfWeek}, {formattedDue}</div>
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 11, color: brand.color, fontWeight: 700 }}>{brand.short}</span>
          {assignee && <><Avatar member={assignee} size={18} /><span style={{ fontSize: 10, color: TH.textMuted }}>{assignee.name.split(" ")[0]}</span></>}
        </div>
        <span style={{ fontSize: 11, fontWeight: 600, color: isOver ? "#B91C1C" : days <= 7 ? "#B45309" : "#047857" }}>{isOver ? `${Math.abs(days)}d over` : days === 0 ? "Today" : `${days}d`}</span>
      </div>
      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
        <button onClick={(e) => { e.stopPropagation(); s.setField("editTask", task); }} style={{ flex: 1, padding: "5px 0", fontSize: 11, fontWeight: 600, color: TH.textSub, background: TH.surfaceHi, border: `1px solid ${TH.border}`, borderRadius: 6, cursor: "pointer", fontFamily: "inherit" }}>View Card</button>
        <button onClick={(e) => { e.stopPropagation(); s.setField("timelineBackFilter", s.statFilter); s.setField("focusCollKey", `${task.brand}||${task.collection}`); s.setField("view", "timeline"); s.setField("statFilter", null); }} style={{ flex: 1, padding: "5px 0", fontSize: 11, fontWeight: 600, color: TH.primary, background: TH.accent, border: `1px solid ${TH.accentBdr}`, borderRadius: 6, cursor: "pointer", fontFamily: "inherit" }}>View Timeline →</button>
      </div>
    </div>
  );
}

export default React.memo(TaskCard);
