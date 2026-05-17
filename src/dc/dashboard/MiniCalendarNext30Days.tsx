// "Next 30 Days" mini calendar extracted from dashboardPanel.tsx.
// Renders one or two month grids (whichever months overlap the next-
// 30-day window). Each in-range day is a drop target — dragging a
// task chip onto a day reschedules it via setTasks().
//
// Day cells outside the [today+1, today+30] window render as empty
// placeholders so the month grid keeps its 7-column layout intact.
// Each day shows the first 2 task chips + a "+N" counter for the rest.
//
// All store state + setters are passed as props so the component can
// be mounted in isolation for tests (no Zustand wiring needed).

import type React from "react";
import { TH } from "../styles";
import { MONTHS } from "../../utils/constants";
import {
  DAY_NAMES,
  buildMonthsInRange,
  groupTasksByDueDate,
} from "./calendars";
import type { Task, Brand } from "../../store/types";

export interface MiniCalendarNext30DaysProps {
  /** Tasks to surface in the calendar (typically `due30`). */
  tasks: Task[];
  /** Tasks already shown in the "This Week" strip — flattened with
   *  `tasks` for the day-bucket map so a single task that's both
   *  due-this-week and due-30 only appears once per day. */
  dueThisWeek: Task[];
  /** Drag state — id of the task currently being dragged, null otherwise. */
  dragId: string | null;
  /** Drag-over state — date string ("YYYY-MM-DD") of the hovered cell, null otherwise. */
  miniCalDragOver: string | null;
  getBrand: (brand: string) => Brand | undefined;
  setDragId: (id: string | null) => void;
  setMiniCalDragOver: (ds: string | null) => void;
  /** Reschedule the dragged task to the dropped day. */
  setTasks: (updater: (prev: Task[]) => Task[]) => void;
  /** Open the edit-task modal on chip click. */
  setEditTask: (task: Task) => void;
}

export function MiniCalendarNext30Days({
  tasks,
  dueThisWeek,
  dragId,
  miniCalDragOver,
  getBrand,
  setDragId,
  setMiniCalDragOver,
  setTasks,
  setEditTask,
}: MiniCalendarNext30DaysProps) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const rangeStart = new Date(today);
  rangeStart.setDate(today.getDate() + 1);
  const rangeEnd = new Date(today);
  rangeEnd.setDate(today.getDate() + 30);
  const tasksByDate = groupTasksByDueDate([dueThisWeek, tasks]);
  const months = buildMonthsInRange(rangeStart, rangeEnd);

  return (
    <div style={{ marginBottom: 28 }}>
      {months.map(({ year, month }) => {
        const fd = new Date(year, month, 1).getDay();
        const dim = new Date(year, month + 1, 0).getDate();
        const allCells = [
          ...Array(fd).fill(null),
          ...Array.from({ length: dim }, (_, i) => i + 1),
        ];
        // Skip leading weeks that have no in-range dates
        const firstInRangeIdx = allCells.findIndex(d => {
          if (!d) return false;
          const cd = new Date(year, month, d);
          return cd >= rangeStart && cd <= rangeEnd;
        });
        const startWeek = firstInRangeIdx >= 0 ? Math.floor(firstInRangeIdx / 7) : 0;
        const cells = allCells.slice(startWeek * 7);
        return (
          <div key={`${year}-${month}`} style={{ marginBottom: 16 }}>
            {/* Dark gradient month header */}
            <div style={{
              background: `linear-gradient(135deg, ${TH.header} 0%, #2D3748 100%)`,
              borderRadius: 14,
              padding: "12px 16px 0",
              marginBottom: 4,
              boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
            }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 14, fontWeight: 800, color: "#fff", letterSpacing: "-0.01em" }}>
                    {MONTHS[month]}
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 400, color: "rgba(255,255,255,0.45)" }}>
                    {year}
                  </span>
                </div>
                {dragId && (
                  <span style={{ fontSize: 10, color: "#93C5FD", fontWeight: 600 }}>
                    ✋ Drop to reschedule
                  </span>
                )}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 3 }}>
                {DAY_NAMES.map((d, di) => {
                  const wknd = di === 0 || di === 6;
                  return (
                    <div key={d} style={{
                      textAlign: "center",
                      padding: "5px 0 7px",
                      fontSize: 9,
                      color: wknd ? "rgba(255,255,255,0.3)" : "rgba(255,255,255,0.5)",
                      letterSpacing: "0.1em",
                      textTransform: "uppercase",
                      fontWeight: 700,
                    }}>
                      {d}
                    </div>
                  );
                })}
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 3 }}>
              {cells.map((d, i) => {
                if (!d) {
                  return <div key={i} style={{ minHeight: 58 }} />;
                }
                const ds = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
                const cellDate = new Date(year, month, d);
                const inRange = cellDate >= rangeStart && cellDate <= rangeEnd;
                if (!inRange) {
                  return <div key={i} style={{ minHeight: 58 }} />;
                }
                const dayTasks = tasksByDate[ds] || [];
                const hasTasks = dayTasks.length > 0;
                const isDragTarget = !!(miniCalDragOver === ds && dragId);
                return (
                  <div
                    key={i}
                    onDragOver={(e) => {
                      if (!dragId) return;
                      e.preventDefault();
                      if (miniCalDragOver !== ds) setMiniCalDragOver(ds);
                    }}
                    onDragEnter={(e) => {
                      if (!dragId) return;
                      e.preventDefault();
                      setMiniCalDragOver(ds);
                    }}
                    onDragLeave={(e) => {
                      if (!e.currentTarget.contains(e.relatedTarget as Node))
                        setMiniCalDragOver(null);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      const id = e.dataTransfer.getData("text/plain") || dragId;
                      if (!id) return;
                      setTasks((ts) => ts.map((t) => t.id === id ? { ...t, due: ds } : t));
                      setDragId(null);
                      setMiniCalDragOver(null);
                    }}
                    style={{
                      minHeight: 58,
                      padding: "4px 4px",
                      borderRadius: 7,
                      background: isDragTarget ? "#DBEAFE" : hasTasks ? "#EFF6FF" : "#F7F8FA",
                      border: `1px solid ${isDragTarget ? "#3B82F6" : hasTasks ? "#BFDBFE" : TH.border}`,
                      transition: "background 0.1s, border-color 0.1s",
                    }}
                  >
                    <div style={{
                      fontSize: 11,
                      fontWeight: hasTasks || isDragTarget ? 800 : 400,
                      color: isDragTarget ? "#1D4ED8" : hasTasks ? "#1D4ED8" : TH.textMuted,
                      marginBottom: 2,
                    }}>
                      {d}
                      {isDragTarget && " 📅"}
                    </div>
                    {dayTasks.slice(0, 2).map((t) => {
                      const b = getBrand(t.brand) || { id: "unknown", name: "Unknown", color: "#6B7280", short: "?" };
                      const isBeingDragged = dragId === t.id;
                      return (
                        <div
                          key={t.id}
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.setData("text/plain", t.id);
                            setTimeout(() => setDragId(t.id), 0);
                          }}
                          onDragEnd={() => {
                            setDragId(null);
                            setMiniCalDragOver(null);
                          }}
                          onClick={() => {
                            if (!dragId) setEditTask(t);
                          }}
                          style={{
                            fontSize: 9.5,
                            background: isBeingDragged ? "#F3F4F6" : "#fff",
                            borderLeft: `2px solid ${b.color}`,
                            padding: "2px 4px",
                            borderRadius: 3,
                            marginBottom: 2,
                            cursor: isBeingDragged ? "grabbing" : "grab",
                            color: TH.text,
                            fontWeight: 600,
                            lineHeight: 1.2,
                            boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
                            opacity: isBeingDragged ? 0.4 : 1,
                            userSelect: "none",
                          }}
                        >
                          {b.short} {t.phase}
                        </div>
                      );
                    })}
                    {dayTasks.length > 2 && (
                      <div style={{ fontSize: 9, color: "#1D4ED8", fontWeight: 700 }}>
                        +{dayTasks.length - 2}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
