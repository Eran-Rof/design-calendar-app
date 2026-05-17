// "This Week" mini calendar extracted from dashboardPanel.tsx. Renders
// an 8-day strip with day-name header + per-day task chips. Each day
// is a drop target — dragging a task chip onto a day reschedules it
// via setTasks(). Today's column gets a primary-color accent.
//
// All store state + setters are passed as props so the component can
// be mounted in isolation for tests (avoids re-coupling to Zustand).

import type React from "react";
import { TH } from "../styles";
import { STATUS_CONFIG } from "../../utils/constants";
import { toDateStr } from "../../utils/dates";
import {
  DAY_NAMES,
  buildDayStrip,
  tasksOnDay,
  isWeekend,
} from "./calendars";
import type { Task, Brand } from "../../store/types";

export interface MiniCalendarThisWeekProps {
  /** Tasks to show across the 8-day window (already scoped, e.g. dueThisWeek). */
  tasks: Task[];
  /** Drag state — id of the task currently being dragged, null otherwise. */
  dragId: string | null;
  /** Drag-over state — date string ("YYYY-MM-DD") of the hovered drop target, null otherwise. */
  miniCalDragOver: string | null;
  /** Brand lookup keyed by `task.brand`. */
  getBrand: (brand: string) => Brand | undefined;
  /** Set the dragged task id (call with null when drop ends or aborts). */
  setDragId: (id: string | null) => void;
  /** Set the hovered drop target date (call with null on drop / leave). */
  setMiniCalDragOver: (ds: string | null) => void;
  /**
   * Apply a tasks-array update. Used on drop to reschedule the dragged
   * task to the dropped-on day. Caller wraps store.setTasks (or
   * equivalent) so it stays setter-shaped here.
   */
  setTasks: (updater: (prev: Task[]) => Task[]) => void;
  /** Open the edit-task modal for the given task (called on chip click). */
  setEditTask: (task: Task) => void;
}

export function MiniCalendarThisWeek({
  tasks,
  dragId,
  miniCalDragOver,
  getBrand,
  setDragId,
  setMiniCalDragOver,
  setTasks,
  setEditTask,
}: MiniCalendarThisWeekProps) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = buildDayStrip(today, 8);

  return (
    <div style={{ marginBottom: 28 }}>
      {/* Dark gradient header */}
      <div
        style={{
          background: `linear-gradient(135deg, ${TH.header} 0%, #2D3748 100%)`,
          borderRadius: 14,
          padding: "12px 16px 0",
          marginBottom: 4,
          boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 800, color: "#fff", letterSpacing: "-0.01em" }}>
              This Week
            </span>
            <span style={{
              fontSize: 10,
              color: "rgba(255,255,255,0.4)",
              background: "rgba(255,255,255,0.07)",
              padding: "1px 8px",
              borderRadius: 20,
            }}>
              {days[0].toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              {" – "}
              {days[7].toLocaleDateString("en-US", { month: "short", day: "numeric" })}
            </span>
          </div>
          {dragId && (
            <span style={{ fontSize: 10, color: "#93C5FD", fontWeight: 600 }}>
              ✋ Drop to reschedule
            </span>
          )}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(8,1fr)", gap: 4 }}>
          {days.map((day, i) => {
            const weekend = isWeekend(day);
            return (
              <div key={i} style={{
                textAlign: "center",
                padding: "5px 0 7px",
                fontSize: 9,
                color: weekend ? "rgba(255,255,255,0.3)" : "rgba(255,255,255,0.5)",
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                fontWeight: 700,
              }}>
                {DAY_NAMES[day.getDay()]}
              </div>
            );
          })}
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(8,1fr)", gap: 4 }}>
        {days.map((day, i) => {
          const ds = toDateStr(day);
          const dayTasks = tasksOnDay(tasks, day);
          const isToday = day.toDateString() === today.toDateString();
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
                borderRadius: "0 0 10px 10px",
                overflow: "hidden",
                border: `1px solid ${isDragTarget ? "#3B82F6" : isToday ? TH.primary : TH.border}`,
                borderTop: `3px solid ${isDragTarget ? "#3B82F6" : isToday ? TH.primary : TH.border}`,
                background: isDragTarget ? "#DBEAFE" : isToday ? TH.primary + "06" : TH.surface,
                boxShadow: `0 1px 4px ${TH.shadow}`,
                transition: "background 0.1s, border-color 0.1s",
              }}
            >
              <div style={{ padding: "6px 8px 3px", borderBottom: `1px solid ${TH.border}` }}>
                <div style={{
                  fontSize: 16,
                  fontWeight: 800,
                  color: isDragTarget ? "#1D4ED8" : isToday ? TH.primary : TH.text,
                  lineHeight: 1.1,
                }}>
                  {day.getDate()}
                  {isDragTarget && " 📅"}
                </div>
              </div>
              <div style={{ padding: "5px 5px" }}>
                {dayTasks.length === 0 && !isDragTarget ? (
                  <div style={{ fontSize: 10, color: TH.textMuted, textAlign: "center", padding: "4px 0" }}>—</div>
                ) : (
                  dayTasks.map((t) => {
                    const b = getBrand(t.brand) || { id: "unknown", name: "Unknown", color: "#6B7280", short: "?" };
                    const sc = STATUS_CONFIG[t.status] || STATUS_CONFIG["Not Started"];
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
                          fontSize: 10.5,
                          background: isBeingDragged ? "#F3F4F6" : "#FFFFFF",
                          borderLeft: `3px solid ${b.color}`,
                          padding: "3px 5px",
                          borderRadius: 4,
                          marginBottom: 3,
                          cursor: isBeingDragged ? "grabbing" : "grab",
                          boxShadow: "0 1px 2px rgba(0,0,0,0.08)",
                          opacity: isBeingDragged ? 0.4 : 1,
                          userSelect: "none",
                        }}
                      >
                        <div style={{ fontWeight: 700, color: TH.text }}>
                          {b.short} {t.phase}
                        </div>
                        <div style={{ color: sc.color, fontWeight: 600, fontSize: 9.5 }}>
                          {t.status}
                        </div>
                        <div style={{ color: TH.textMuted, fontSize: 9.5 }}>
                          {t.collection}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
