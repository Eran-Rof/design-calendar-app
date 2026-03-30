import React from "react";
import { S, TH, fmtDays } from "./styles";
import { formatDate } from "../utils/dates";
import { MONTHS } from "../utils/constants";
import Avatar from "../components/Avatar";

export type CalendarCtx = Record<string, any>;

export function calendarPanel(ctx: CalendarCtx): React.ReactElement | null {
  const { tasks, collections, setEditTask, calViewYear, setCalViewYear, calViewMonth, setCalViewMonth, calDragOver, setCalDragOver, focusCollKey, team, filtered, isAdmin, canViewAll, currentUser, filterBrand, filterSeason, filterCustomer, filterVendor, collMap, collList, dragId, setDragId, setFocusCollKey, setTasks, getBrand } = ctx;

    const today = new Date();
    // Use parent-level state so month persists when task modal opens/closes
    const cy = calViewYear, setCy = setCalViewYear;
    const cm = calViewMonth, setCm = setCalViewMonth;
    // calDragOver is defined in App state so CalendarView() can be called as a plain function
    const fd = new Date(cy, cm, 1).getDay(),
      dim = new Date(cy, cm + 1, 0).getDate();
    const cells = [
      ...Array(fd).fill(null),
      ...Array.from({ length: dim }, (_, i) => i + 1),
    ];
    const ds = (d) =>
      `${cy}-${String(cm + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const src = focusCollKey
      ? tasks.filter((t) => `${t.brand}||${t.collection}` === focusCollKey)
      : filtered;

    function handleCalDrop(dateStr) {
      if (!dragId || !dateStr) return;
      setTasks((ts) =>
        ts.map((t) => (t.id === dragId ? { ...t, due: dateStr } : t))
      );
      setDragId(null);
      setCalDragOver(null);
    }

    return (
      <div>
        {dragId && (
          <div
            style={{
              marginBottom: 10,
              padding: "7px 14px",
              background: "#EFF6FF",
              border: "1px solid #BFDBFE",
              borderRadius: 8,
              fontSize: 12,
              color: "#1D4ED8",
              fontWeight: 600,
            }}
          >
            ✋ Drag a task to a day to reschedule
          </div>
        )}

        {/* ── Unified calendar header ── */}
        <div
          style={{
            background: `linear-gradient(135deg, ${TH.header} 0%, #2D3748 100%)`,
            borderRadius: 14,
            padding: "14px 20px 0",
            marginBottom: 4,
            boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
          }}
        >
          {/* Top row: collection filter + month nav */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 14,
            }}
          >
            {/* Left: collection label */}
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {focusCollKey ? (
                <>
                  <span
                    style={{
                      fontSize: 11,
                      color: "rgba(255,255,255,0.45)",
                      fontWeight: 600,
                      textTransform: "uppercase",
                      letterSpacing: "0.08em",
                    }}
                  >
                    Showing
                  </span>
                  <span
                    style={{ fontSize: 13, fontWeight: 800, color: "#fff" }}
                  >
                    {focusCollKey.split("||")[1]}
                  </span>
                  <button
                    onClick={() => setFocusCollKey(null)}
                    style={{
                      padding: "3px 10px",
                      borderRadius: 20,
                      border: "1px solid rgba(255,255,255,0.2)",
                      background: "rgba(255,255,255,0.08)",
                      color: "rgba(255,255,255,0.6)",
                      cursor: "pointer",
                      fontFamily: "inherit",
                      fontSize: 10,
                      fontWeight: 600,
                    }}
                  >
                    ✕ Show All
                  </button>
                </>
              ) : (
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 700,
                    color: "rgba(255,255,255,0.5)",
                    letterSpacing: "0.04em",
                  }}
                >
                  All Collections
                </span>
              )}
            </div>

            {/* Center: month navigation */}
            <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
              <button
                onClick={() => {
                  if (cm === 0) {
                    setCm(11);
                    setCy((y) => y - 1);
                  } else setCm((m) => m - 1);
                }}
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: "8px 0 0 8px",
                  border: "1px solid rgba(255,255,255,0.15)",
                  borderRight: "none",
                  background: "rgba(255,255,255,0.07)",
                  color: "rgba(255,255,255,0.8)",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  fontSize: 16,
                  fontWeight: 700,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  transition: "background 0.15s",
                }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.background = "rgba(255,255,255,0.14)")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.background = "rgba(255,255,255,0.07)")
                }
              >
                ‹
              </button>
              <div
                style={{
                  padding: "0 22px",
                  height: 32,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  border: "1px solid rgba(255,255,255,0.15)",
                  background: "rgba(255,255,255,0.05)",
                  minWidth: 160,
                }}
              >
                <span
                  style={{
                    fontSize: 15,
                    fontWeight: 800,
                    color: "#fff",
                    letterSpacing: "-0.01em",
                  }}
                >
                  {MONTHS[cm]}
                </span>
                <span
                  style={{
                    fontSize: 15,
                    fontWeight: 400,
                    color: "rgba(255,255,255,0.5)",
                    marginLeft: 8,
                  }}
                >
                  {cy}
                </span>
              </div>
              <button
                onClick={() => {
                  if (cm === 11) {
                    setCm(0);
                    setCy((y) => y + 1);
                  } else setCm((m) => m + 1);
                }}
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: "0 8px 8px 0",
                  border: "1px solid rgba(255,255,255,0.15)",
                  borderLeft: "none",
                  background: "rgba(255,255,255,0.07)",
                  color: "rgba(255,255,255,0.8)",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  fontSize: 16,
                  fontWeight: 700,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  transition: "background 0.15s",
                }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.background = "rgba(255,255,255,0.14)")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.background = "rgba(255,255,255,0.07)")
                }
              >
                ›
              </button>
            </div>

            {/* Right: today button */}
            <button
              onClick={() => {
                setCy(today.getFullYear());
                setCm(today.getMonth());
              }}
              style={{
                padding: "5px 14px",
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.18)",
                background: "rgba(255,255,255,0.07)",
                color: "rgba(255,255,255,0.65)",
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 11,
                fontWeight: 600,
                transition: "background 0.15s",
              }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = "rgba(255,255,255,0.14)")
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.background = "rgba(255,255,255,0.07)")
              }
            >
              Today
            </button>
          </div>

          {/* Day headers */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(7,1fr)",
              gap: 4,
            }}
          >
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => {
              const isWeekend = i === 0 || i === 6;
              return (
                <div
                  key={d}
                  style={{
                    textAlign: "center",
                    padding: "6px 0 8px",
                    fontSize: 10,
                    color: isWeekend
                      ? "rgba(255,255,255,0.3)"
                      : "rgba(255,255,255,0.5)",
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    fontWeight: 700,
                  }}
                >
                  {d}
                </div>
              );
            })}
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(7,1fr)",
            gap: 4,
          }}
        >
          {cells.map((d, i) => {
            const dateStr = d ? ds(d) : null;
            const dt = d ? src.filter((t) => t.due === ds(d)) : [];
            const isToday =
              d && new Date(ds(d)).toDateString() === today.toDateString();
            const isDragTarget = dateStr && calDragOver === dateStr;
            return (
              <div
                key={i}
                onDragOver={(e) => {
                  if (!d || !dragId) return;
                  e.preventDefault();
                  e.stopPropagation();
                  if (calDragOver !== dateStr) setCalDragOver(dateStr);
                }}
                onDragEnter={(e) => {
                  if (!d || !dragId) return;
                  e.preventDefault();
                  setCalDragOver(dateStr);
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node))
                    setCalDragOver(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  handleCalDrop(dateStr);
                }}
                style={{
                  minHeight: 90,
                  padding: 6,
                  background: isDragTarget
                    ? "#DBEAFE"
                    : d
                    ? "#E8ECF0"
                    : "transparent",
                  border: `1px solid ${
                    isDragTarget
                      ? "#3B82F6"
                      : isToday
                      ? TH.primary
                      : d
                      ? "#C8D0DA"
                      : "transparent"
                  }`,
                  borderTop: isDragTarget
                    ? `3px solid #3B82F6`
                    : isToday
                    ? `3px solid ${TH.primary}`
                    : d
                    ? `1px solid #C8D0DA`
                    : "none",
                  borderRadius: 8,
                  boxShadow: d ? `0 1px 3px ${TH.shadow}` : "none",
                  transition: "background 0.1s, border-color 0.1s",
                }}
              >
                {d && (
                  <div
                    style={{
                      fontSize: 13.8,
                      color: isDragTarget
                        ? "#1D4ED8"
                        : isToday
                        ? TH.primary
                        : TH.textMuted,
                      fontWeight: isDragTarget || isToday ? 800 : 400,
                      marginBottom: 4,
                    }}
                  >
                    {d}
                    {isDragTarget && (
                      <span style={{ fontSize: 10, marginLeft: 4 }}>📅</span>
                    )}
                  </div>
                )}
                {dt.slice(0, 3).map((t) => {
                  const b = getBrand(t.brand),
                    assignee = team.find((m) => m.id === t.assigneeId),
                    isDDP = t.phase === "DDP";
                  const collKey = `${t.brand}||${t.collection}`;
                  const collMeta = collections[collKey] || {};
                  const isBeingDragged = dragId === t.id;
                  return (
                    <div
                      key={t.id}
                      draggable
                      onDragStart={(e) => {
                        e.stopPropagation();
                        setDragId(t.id);
                        setCalDragOver(null);
                      }}
                      onDragEnd={() => {
                        setDragId(null);
                        setCalDragOver(null);
                      }}
                      onClick={() => {
                        if (!dragId) setEditTask(t);
                      }}
                      style={{
                        fontSize: 11.5,
                        background: isBeingDragged ? "#F3F4F6" : "#FFFFFF",
                        borderLeft: `3px solid ${b.color}`,
                        padding: "3px 6px",
                        borderRadius: 4,
                        marginBottom: 3,
                        cursor: isBeingDragged ? "grabbing" : "grab",
                        color: "#1A202C",
                        fontWeight: isDDP ? 700 : 500,
                        boxShadow: "0 1px 3px rgba(0,0,0,0.10)",
                        opacity: isBeingDragged ? 0.4 : 1,
                        transition: "opacity 0.12s",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                        }}
                      >
                        <span style={{ fontWeight: 700, color: "#1A202C" }}>
                          {isDDP ? "🎯 " : ""}
                          {b.short} {t.phase}
                        </span>
                        {assignee && <Avatar member={assignee} size={13} />}
                      </div>
                      <div
                        style={{
                          fontSize: 10.5,
                          color: "#4A5568",
                          marginTop: 1,
                          lineHeight: 1.4,
                        }}
                      >
                        {t.collection} · {t.season}
                        {collMeta.year ? ` ${collMeta.year}` : ""} ·{" "}
                        {t.category}
                        {collMeta.customer ? ` · ${collMeta.customer}` : ""}
                        {isDDP ? ` · DDP: ${formatDate(t.due)}` : ""}
                      </div>
                    </div>
                  );
                })}
                {dt.length > 3 && (
                  <div
                    style={{
                      fontSize: 11.5,
                      color: TH.textMuted,
                      fontWeight: 600,
                    }}
                  >
                    +{dt.length - 3} more
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
}
