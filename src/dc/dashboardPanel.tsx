import React, { Fragment } from "react";
import { S, TH, fmtDays } from "./styles";
import { formatDate, getDaysUntil, getBusinessDaysUntil } from "../utils/dates";
import { STATUS_CONFIG, MONTHS } from "../utils/constants";
import Avatar from "../components/Avatar";
import { useAppStore } from "../store";
import { selectGetBrand, selectIsAdmin, selectCanViewAll, selectFiltered, selectOverdue, selectDueThisWeek, selectDue30, selectCollMap, selectCollList } from "../store/selectors";

export type DashboardCtx = { TaskCard: any };

// Proper React component backed by Zustand store
function DashboardPanelInner({ TaskCard }: DashboardCtx): React.ReactElement | null {
  const s = useAppStore();
  const { tasks, collections, view, listView, expandedColl, focusCollKey, statFilter, dragId, miniCalDragOver, team, pendingDeleteColl, brands, seasons, currentUser, showAddTask, editCollKey, globalLog, timelineBackFilter, ctxMenu } = s;
  const setView = (v: any) => s.setField("view", v);
  const setExpandedColl = (v: any) => s.setField("expandedColl", v);
  const setFocusCollKey = (v: any) => s.setField("focusCollKey", v);
  const setStatFilter = (v: any) => s.setField("statFilter", v);
  const setShowWizard = (v: any) => s.setField("showWizard", v);
  const setEditTask = (v: any) => s.setField("editTask", v);
  const setCtxMenu = (v: any) => s.setField("ctxMenu", v);
  const setDragId = (v: any) => s.setField("dragId", v);
  const setMiniCalDragOver = (v: any) => s.setField("miniCalDragOver", v);
  const setPendingDeleteColl = (v: any) => s.setField("pendingDeleteColl", v);
  const setShowAddTask = (v: any) => s.setField("showAddTask", v);
  const setEditCollKey = (v: any) => s.setField("editCollKey", v);
  const setTimelineBackFilter = (v: any) => s.setField("timelineBackFilter", v);
  const { setTasks, handleDrop, handleTimelineDrop, saveCascade, deleteTask, addCollection } = s;
  const pushUndo = s.pushUndoEntry;
  const filterBrand = s.filterBrand;
  const filterSeason = s.filterSeason;
  const filterCustomer = s.filterCustomer;
  const filterVendor = s.filterVendor;
  const isAdmin = selectIsAdmin(s);
  const canViewAll = selectCanViewAll(s);
  const getBrand = selectGetBrand(s);
  const overdue = selectOverdue(s);
  const dueThisWeek = selectDueThisWeek(s);
  const due30 = selectDue30(s);
  const collMap = selectCollMap(s);
  const collList = selectCollList(s);

    const collListView = listView;
    // Stat filter config
    const STAT_META = {
      overdue: {
        label: "Overdue Tasks",
        color: "#B91C1C",
        bg: "#FEF2F2",
        bdr: "#FCA5A5",
        accent: "#FC8181",
        tasks: overdue,
      },
      week: {
        label: "Due This Week",
        color: "#B45309",
        bg: "#FFFBEB",
        bdr: "#FCD34D",
        accent: "#F6AD55",
        tasks: dueThisWeek,
      },
      "30d": {
        label: "Due in Next 30 Days",
        color: "#1D4ED8",
        bg: "#EFF6FF",
        bdr: "#BFDBFE",
        accent: "#63B3ED",
        tasks: due30,
      },
      collections: {
        label: "All Collections",
        color: TH.primary,
        bg: TH.accent,
        bdr: TH.accentBdr,
        accent: TH.primary,
        tasks: [],
      },
    };
    const activeMeta = statFilter ? STAT_META[statFilter] : null;
    const showTaskList = statFilter && statFilter !== "collections";
    const showCollections = !statFilter || statFilter === "collections";

    return (
      <div onClick={() => { if (ctxMenu) setCtxMenu(null); }}>
        {overdue.length > 0 && !statFilter && (
          <div
            style={{
              background: "#FFF5F5",
              border: "1px solid #FEB2B2",
              borderLeft: `4px solid ${TH.primary}`,
              borderRadius: 10,
              padding: "12px 20px",
              marginBottom: 22,
              display: "flex",
              gap: 12,
              alignItems: "center",
            }}
          >
            <span>⚠️</span>
            <span style={{ color: "#B91C1C", fontSize: 13 }}>
              <strong>{overdue.length} overdue</strong> —{" "}
              {overdue
                .map((t) => `${(getBrand(t.brand) || {}).short || t.brand} ${t.phase}`)
                .join(", ")}
            </span>
          </div>
        )}
        {tasks.length === 0 && (
          <div style={{ textAlign: "center", padding: "80px 0" }}>
            <div style={{ fontSize: 52, marginBottom: 16 }}>📅</div>
            <div
              style={{
                fontSize: 22,
                fontWeight: 800,
                color: TH.text,
                marginBottom: 8,
              }}
            >
              No collections yet
            </div>
            <div
              style={{ fontSize: 14, color: TH.textMuted, marginBottom: 28 }}
            >
              Create your first collection to auto-generate a full timeline.
            </div>
            {isAdmin && (
              <button
                onClick={() => setShowWizard(true)}
                style={{ ...S.btn, padding: "14px 32px", fontSize: 15 }}
              >
                + New Collection
              </button>
            )}
          </div>
        )}
        {tasks.length > 0 && (
          <>
            {/* Stat filter banner */}
            {statFilter && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  marginBottom: 22,
                  padding: "12px 18px",
                  background: activeMeta.bg,
                  border: `1px solid ${activeMeta.bdr}`,
                  borderLeft: `4px solid ${activeMeta.accent}`,
                  borderRadius: 10,
                }}
              >
                <span
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    color: activeMeta.color,
                  }}
                >
                  {activeMeta.tasks?.length ?? collList.length}{" "}
                  {activeMeta.label}
                </span>
                <button
                  onClick={() => setStatFilter(null)}
                  style={{
                    marginLeft: "auto",
                    padding: "4px 12px",
                    borderRadius: 6,
                    border: `1px solid ${activeMeta.bdr}`,
                    background: "none",
                    color: activeMeta.color,
                    cursor: "pointer",
                    fontFamily: "inherit",
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >
                  ✕ Clear Filter
                </button>
              </div>
            )}

            {/* Stat summary cards — only when no filter active */}
            {!statFilter && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(3,1fr)",
                  gap: 16,
                  marginBottom: 28,
                }}
              >
                {[
                  {
                    id: "overdue",
                    label: "Overdue",
                    count: overdue.length,
                    c: "#B91C1C",
                    bg: "#FEF2F2",
                    bdr: "#FCA5A5",
                  },
                  {
                    id: "week",
                    label: "Due This Week",
                    count: dueThisWeek.length,
                    c: "#B45309",
                    bg: "#FFFBEB",
                    bdr: "#FCD34D",
                  },
                  {
                    id: "30d",
                    label: "Next 30 Days",
                    count: due30.length,
                    c: "#1D4ED8",
                    bg: "#EFF6FF",
                    bdr: "#BFDBFE",
                  },
                ].map((s) => (
                  <button
                    key={s.label}
                    onClick={(e) => { e.stopPropagation(); setStatFilter(s.id); }}
                    style={{
                      background: s.bg,
                      border: `1px solid ${s.bdr}`,
                      borderTop: `4px solid ${s.c}`,
                      borderRadius: 12,
                      padding: "20px 24px",
                      boxShadow: `0 2px 8px ${TH.shadow}`,
                      cursor: "pointer",
                      transition: "transform 0.15s,box-shadow 0.15s",
                      fontFamily: "inherit",
                      textAlign: "left" as const,
                      display: "block",
                      width: "100%",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.transform = "translateY(-2px)";
                      e.currentTarget.style.boxShadow = `0 6px 16px ${TH.shadowMd}`;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.transform = "none";
                      e.currentTarget.style.boxShadow = `0 2px 8px ${TH.shadow}`;
                    }}
                  >
                    <div
                      style={{
                        fontSize: 40,
                        fontWeight: 800,
                        color: s.c,
                        lineHeight: 1,
                      }}
                    >
                      {s.count}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: TH.textMuted,
                        letterSpacing: "0.08em",
                        textTransform: "uppercase",
                        marginTop: 6,
                      }}
                    >
                      {s.label}
                    </div>
                    {s.count > 0 && (
                      <div
                        style={{
                          fontSize: 11,
                          color: s.c,
                          marginTop: 4,
                          fontWeight: 600,
                        }}
                      >
                        Click to view →
                      </div>
                    )}
                  </button>
                ))}
              </div>
            )}

            {/* Filtered task list view */}
            {showTaskList && (
              <>
                {activeMeta.tasks.length === 0 ? (
                  <div
                    style={{
                      textAlign: "center",
                      color: TH.textMuted,
                      padding: "48px 0",
                      fontSize: 14,
                    }}
                  >
                    No tasks in this category 🎉
                  </div>
                ) : (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fill,minmax(240px,1fr))",
                      gap: 10,
                      marginBottom: 28,
                    }}
                  >
                    {[...activeMeta.tasks]
                      .sort((a, b) => +new Date(a.due) - +new Date(b.due))
                      .map((t) => (
                        <TaskCard key={t.id} task={t} showDayDate={true} />
                      ))}
                  </div>
                )}

                {/* Mini calendar for "This Week" */}
                {statFilter === "week" &&
                  (() => {
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    const days = Array.from({ length: 8 }, (_, i) => {
                      const d = new Date(today);
                      d.setDate(today.getDate() + i);
                      return d;
                    });
                    const DAY_NAMES_FULL = [
                      "Sun",
                      "Mon",
                      "Tue",
                      "Wed",
                      "Thu",
                      "Fri",
                      "Sat",
                    ];
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
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              marginBottom: 12,
                            }}
                          >
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 10,
                              }}
                            >
                              <span
                                style={{
                                  fontSize: 13,
                                  fontWeight: 800,
                                  color: "#fff",
                                  letterSpacing: "-0.01em",
                                }}
                              >
                                This Week
                              </span>
                              <span
                                style={{
                                  fontSize: 10,
                                  color: "rgba(255,255,255,0.4)",
                                  background: "rgba(255,255,255,0.07)",
                                  padding: "1px 8px",
                                  borderRadius: 20,
                                }}
                              >
                                {days[0].toLocaleDateString("en-US", {
                                  month: "short",
                                  day: "numeric",
                                })}{" "}
                                –{" "}
                                {days[7].toLocaleDateString("en-US", {
                                  month: "short",
                                  day: "numeric",
                                })}
                              </span>
                            </div>
                            {dragId && (
                              <span
                                style={{
                                  fontSize: 10,
                                  color: "#93C5FD",
                                  fontWeight: 600,
                                }}
                              >
                                ✋ Drop to reschedule
                              </span>
                            )}
                          </div>
                          <div
                            style={{
                              display: "grid",
                              gridTemplateColumns: "repeat(8,1fr)",
                              gap: 4,
                            }}
                          >
                            {days.map((day, i) => {
                              const isWeekend =
                                day.getDay() === 0 || day.getDay() === 6;
                              return (
                                <div
                                  key={i}
                                  style={{
                                    textAlign: "center",
                                    padding: "5px 0 7px",
                                    fontSize: 9,
                                    color: isWeekend
                                      ? "rgba(255,255,255,0.3)"
                                      : "rgba(255,255,255,0.5)",
                                    letterSpacing: "0.1em",
                                    textTransform: "uppercase",
                                    fontWeight: 700,
                                  }}
                                >
                                  {DAY_NAMES_FULL[day.getDay()]}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns: "repeat(8,1fr)",
                            gap: 4,
                          }}
                        >
                          {days.map((day, i) => {
                            const ds = `${day.getFullYear()}-${String(
                              day.getMonth() + 1
                            ).padStart(2, "0")}-${String(
                              day.getDate()
                            ).padStart(2, "0")}`;
                            const dayTasks = activeMeta.tasks.filter(
                              (t) => t.due === ds
                            );
                            const isToday =
                              day.toDateString() === today.toDateString();
                            const isDragTarget =
                              miniCalDragOver === ds && dragId;
                            return (
                              <div
                                key={i}
                                onDragOver={(e) => {
                                  if (!dragId) return;
                                  e.preventDefault();
                                  if (miniCalDragOver !== ds)
                                    setMiniCalDragOver(ds);
                                }}
                                onDragEnter={(e) => {
                                  if (!dragId) return;
                                  e.preventDefault();
                                  setMiniCalDragOver(ds);
                                }}
                                onDragLeave={(e) => {
                                  if (
                                    !e.currentTarget.contains(
                                      e.relatedTarget as Node
                                    )
                                  )
                                    setMiniCalDragOver(null);
                                }}
                                onDrop={(e) => {
                                  e.preventDefault();
                                  const id =
                                    e.dataTransfer.getData("text/plain") ||
                                    dragId;
                                  if (!id) return;
                                  setTasks((ts) =>
                                    ts.map((t) =>
                                      t.id === id ? { ...t, due: ds } : t
                                    )
                                  );
                                  setDragId(null);
                                  setMiniCalDragOver(null);
                                }}
                                style={{
                                  borderRadius: "0 0 10px 10px",
                                  overflow: "hidden",
                                  border: `1px solid ${
                                    isDragTarget
                                      ? "#3B82F6"
                                      : isToday
                                      ? TH.primary
                                      : TH.border
                                  }`,
                                  borderTop: `3px solid ${
                                    isDragTarget
                                      ? "#3B82F6"
                                      : isToday
                                      ? TH.primary
                                      : TH.border
                                  }`,
                                  background: isDragTarget
                                    ? "#DBEAFE"
                                    : isToday
                                    ? TH.primary + "06"
                                    : TH.surface,
                                  boxShadow: `0 1px 4px ${TH.shadow}`,
                                  transition:
                                    "background 0.1s, border-color 0.1s",
                                }}
                              >
                                <div
                                  style={{
                                    padding: "6px 8px 3px",
                                    borderBottom: `1px solid ${TH.border}`,
                                  }}
                                >
                                  <div
                                    style={{
                                      fontSize: 16,
                                      fontWeight: 800,
                                      color: isDragTarget
                                        ? "#1D4ED8"
                                        : isToday
                                        ? TH.primary
                                        : TH.text,
                                      lineHeight: 1.1,
                                    }}
                                  >
                                    {day.getDate()}
                                    {isDragTarget && " 📅"}
                                  </div>
                                </div>
                                <div style={{ padding: "5px 5px" }}>
                                  {dayTasks.length === 0 && !isDragTarget ? (
                                    <div
                                      style={{
                                        fontSize: 10,
                                        color: TH.textMuted,
                                        textAlign: "center",
                                        padding: "4px 0",
                                      }}
                                    >
                                      —
                                    </div>
                                  ) : (
                                    dayTasks.map((t) => {
                                      const b = getBrand(t.brand) || { id: "unknown", name: "Unknown", color: "#6B7280", short: "?" };
                                      const sc =
                                        STATUS_CONFIG[t.status] ||
                                        STATUS_CONFIG["Not Started"];
                                      const isBeingDragged = dragId === t.id;
                                      return (
                                        <div
                                          key={t.id}
                                          draggable
                                          onDragStart={(e) => {
                                            e.dataTransfer.setData(
                                              "text/plain",
                                              t.id
                                            );
                                            setTimeout(
                                              () => setDragId(t.id),
                                              0
                                            );
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
                                            background: isBeingDragged
                                              ? "#F3F4F6"
                                              : "#FFFFFF",
                                            borderLeft: `3px solid ${b.color}`,
                                            padding: "3px 5px",
                                            borderRadius: 4,
                                            marginBottom: 3,
                                            cursor: isBeingDragged
                                              ? "grabbing"
                                              : "grab",
                                            boxShadow:
                                              "0 1px 2px rgba(0,0,0,0.08)",
                                            opacity: isBeingDragged ? 0.4 : 1,
                                            userSelect: "none",
                                          }}
                                        >
                                          <div
                                            style={{
                                              fontWeight: 700,
                                              color: TH.text,
                                            }}
                                          >
                                            {b.short} {t.phase}
                                          </div>
                                          <div
                                            style={{
                                              color: sc.color,
                                              fontWeight: 600,
                                              fontSize: 9.5,
                                            }}
                                          >
                                            {t.status}
                                          </div>
                                          <div
                                            style={{
                                              color: TH.textMuted,
                                              fontSize: 9.5,
                                            }}
                                          >
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
                  })()}

                {/* Mini calendar for "Next 30 Days" */}
                {statFilter === "30d" &&
                  (() => {
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    const rangeStart = new Date(today);
                    rangeStart.setDate(today.getDate() + 1);
                    const rangeEnd = new Date(today);
                    rangeEnd.setDate(today.getDate() + 30);
                    const tasksByDate = {};
                    [...dueThisWeek, ...activeMeta.tasks].forEach((t) => {
                      if (!tasksByDate[t.due]) tasksByDate[t.due] = [];
                      if (!tasksByDate[t.due].find((x) => x.id === t.id))
                        tasksByDate[t.due].push(t);
                    });
                    const months = [];
                    let cur = new Date(
                      rangeStart.getFullYear(),
                      rangeStart.getMonth(),
                      1
                    );
                    const endMonthStart = new Date(
                      rangeEnd.getFullYear(),
                      rangeEnd.getMonth(),
                      1
                    );
                    while (cur <= endMonthStart) {
                      months.push({
                        year: cur.getFullYear(),
                        month: cur.getMonth(),
                      });
                      cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
                    }
                    const DAY_NAMES = [
                      "Sun",
                      "Mon",
                      "Tue",
                      "Wed",
                      "Thu",
                      "Fri",
                      "Sat",
                    ];
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
                            <div
                              key={`${year}-${month}`}
                              style={{ marginBottom: 16 }}
                            >
                              {/* Dark gradient month header */}
                              <div
                                style={{
                                  background: `linear-gradient(135deg, ${TH.header} 0%, #2D3748 100%)`,
                                  borderRadius: 14,
                                  padding: "12px 16px 0",
                                  marginBottom: 4,
                                  boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
                                }}
                              >
                                <div
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "space-between",
                                    marginBottom: 12,
                                  }}
                                >
                                  <div
                                    style={{
                                      display: "flex",
                                      alignItems: "center",
                                      gap: 10,
                                    }}
                                  >
                                    <span
                                      style={{
                                        fontSize: 14,
                                        fontWeight: 800,
                                        color: "#fff",
                                        letterSpacing: "-0.01em",
                                      }}
                                    >
                                      {MONTHS[month]}
                                    </span>
                                    <span
                                      style={{
                                        fontSize: 13,
                                        fontWeight: 400,
                                        color: "rgba(255,255,255,0.45)",
                                      }}
                                    >
                                      {year}
                                    </span>
                                  </div>
                                  {dragId && (
                                    <span
                                      style={{
                                        fontSize: 10,
                                        color: "#93C5FD",
                                        fontWeight: 600,
                                      }}
                                    >
                                      ✋ Drop to reschedule
                                    </span>
                                  )}
                                </div>
                                <div
                                  style={{
                                    display: "grid",
                                    gridTemplateColumns: "repeat(7,1fr)",
                                    gap: 3,
                                  }}
                                >
                                  {DAY_NAMES.map((d, di) => {
                                    const isWeekend = di === 0 || di === 6;
                                    return (
                                      <div
                                        key={d}
                                        style={{
                                          textAlign: "center",
                                          padding: "5px 0 7px",
                                          fontSize: 9,
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
                                  gap: 3,
                                }}
                              >
                                {cells.map((d, i) => {
                                  if (!d)
                                    return (
                                      <div key={i} style={{ minHeight: 58 }} />
                                    );
                                  const ds = `${year}-${String(
                                    month + 1
                                  ).padStart(2, "0")}-${String(d).padStart(
                                    2,
                                    "0"
                                  )}`;
                                  const cellDate = new Date(year, month, d);
                                  const inRange =
                                    cellDate >= rangeStart &&
                                    cellDate <= rangeEnd;
                                  if (!inRange)
                                    return (
                                      <div key={i} style={{ minHeight: 58 }} />
                                    );
                                  const dayTasks = tasksByDate[ds] || [];
                                  const hasTasks = dayTasks.length > 0;
                                  const isDragTarget =
                                    miniCalDragOver === ds && dragId;
                                  return (
                                    <div
                                      key={i}
                                      onDragOver={(e) => {
                                        if (!dragId) return;
                                        e.preventDefault();
                                        if (miniCalDragOver !== ds)
                                          setMiniCalDragOver(ds);
                                      }}
                                      onDragEnter={(e) => {
                                        if (!dragId) return;
                                        e.preventDefault();
                                        setMiniCalDragOver(ds);
                                      }}
                                      onDragLeave={(e) => {
                                        if (
                                          !e.currentTarget.contains(
                                            e.relatedTarget as Node
                                          )
                                        )
                                          setMiniCalDragOver(null);
                                      }}
                                      onDrop={(e) => {
                                        e.preventDefault();
                                        const id =
                                          e.dataTransfer.getData(
                                            "text/plain"
                                          ) || dragId;
                                        if (!id) return;
                                        setTasks((ts) =>
                                          ts.map((t) =>
                                            t.id === id ? { ...t, due: ds } : t
                                          )
                                        );
                                        setDragId(null);
                                        setMiniCalDragOver(null);
                                      }}
                                      style={{
                                        minHeight: 58,
                                        padding: "4px 4px",
                                        borderRadius: 7,
                                        background: isDragTarget
                                          ? "#DBEAFE"
                                          : hasTasks
                                          ? "#EFF6FF"
                                          : "#F7F8FA",
                                        border: `1px solid ${
                                          isDragTarget
                                            ? "#3B82F6"
                                            : hasTasks
                                            ? "#BFDBFE"
                                            : TH.border
                                        }`,
                                        transition:
                                          "background 0.1s, border-color 0.1s",
                                      }}
                                    >
                                      <div
                                        style={{
                                          fontSize: 11,
                                          fontWeight:
                                            hasTasks || isDragTarget
                                              ? 800
                                              : 400,
                                          color: isDragTarget
                                            ? "#1D4ED8"
                                            : hasTasks
                                            ? "#1D4ED8"
                                            : TH.textMuted,
                                          marginBottom: 2,
                                        }}
                                      >
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
                                              e.dataTransfer.setData(
                                                "text/plain",
                                                t.id
                                              );
                                              setTimeout(
                                                () => setDragId(t.id),
                                                0
                                              );
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
                                              background: isBeingDragged
                                                ? "#F3F4F6"
                                                : "#fff",
                                              borderLeft: `2px solid ${b.color}`,
                                              padding: "2px 4px",
                                              borderRadius: 3,
                                              marginBottom: 2,
                                              cursor: isBeingDragged
                                                ? "grabbing"
                                                : "grab",
                                              color: TH.text,
                                              fontWeight: 600,
                                              lineHeight: 1.2,
                                              boxShadow:
                                                "0 1px 2px rgba(0,0,0,0.06)",
                                              opacity: isBeingDragged ? 0.4 : 1,
                                              userSelect: "none",
                                            }}
                                          >
                                            {b.short} {t.phase}
                                          </div>
                                        );
                                      })}
                                      {dayTasks.length > 2 && (
                                        <div
                                          style={{
                                            fontSize: 9,
                                            color: "#1D4ED8",
                                            fontWeight: 700,
                                          }}
                                        >
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
                  })()}
              </>
            )}

            {/* Collections grid */}
            {showCollections && (
              <>
                <div style={{ marginBottom: 12 }}>
                  <span style={S.sec}>
                    Collections{" "}
                    <span style={{ color: TH.textSub2, fontWeight: 400 }}>
                      — click to focus · right-click for options
                    </span>
                  </span>
                </div>

                {/* LIST VIEW */}
                {collListView && (
                  <div style={{ marginBottom: 28, border: `1px solid ${TH.border}`, borderRadius: 12, overflow: "hidden" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: "inherit" }}>
                      <thead>
                        <tr style={{ background: TH.header, borderBottom: `2px solid ${TH.header}` }}>
                          {["Brand", "Collection", "Season", "Vendor", "DDP", "Progress", "Next Task"].map(h => (
                            <th key={h} style={{ padding: "10px 14px", textAlign: "left", fontWeight: 700, color: "rgba(255,255,255,0.75)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em" }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {collList.map((c, ri) => {
                          const brand = getBrand(c.brand) || { id: "unknown", name: "Unknown", color: "#6B7280", short: "?" };
                          const done = c.tasks.filter(t => ["Complete","Approved"].includes(t.status)).length;
                          const pct = Math.round((done / c.tasks.length) * 100);
                          const ddpTask = c.tasks.find(t => t.phase === "DDP");
                          const next = c.tasks.filter(t => !["Complete","Approved"].includes(t.status)).sort((a,b) => new Date(a.due).getTime() - new Date(b.due).getTime())[0];
                          const isExpanded = expandedColl === c.key;
                          const sortedTasks = [...c.tasks].sort((a,b) => new Date(a.due).getTime() - new Date(b.due).getTime());
                          const rowBg = isExpanded ? "#E8EDF5" : ri % 2 === 0 ? "#FFFFFF" : "#F1F5F9";
                          return (
                            <Fragment key={c.key}>
                              <tr onClick={() => setExpandedColl(isExpanded ? null : c.key)}
                                style={{ borderBottom: `1px solid ${TH.border}`, cursor: "pointer", background: rowBg, transition: "background 0.1s" }}
                                onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = "#DDE3EE"}
                                onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = rowBg}>
                                <td style={{ padding: "10px 14px" }}>
                                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                    <div style={{ width: 10, height: 10, borderRadius: 2, background: brand.color, flexShrink: 0 }} />
                                    <span style={{ fontWeight: 700, color: brand.color }}>{brand.short || brand.name}</span>
                                  </div>
                                </td>
                                <td style={{ padding: "10px 14px", fontWeight: 600, color: TH.text }}>
                                  {isExpanded ? "▼ " : "▶ "}{c.collection}
                                </td>
                                <td style={{ padding: "10px 14px", color: TH.textSub2 }}>{c.season || "—"}</td>
                                <td style={{ padding: "10px 14px", color: TH.textSub2 }}>{c.vendorName || "—"}</td>
                                <td style={{ padding: "10px 14px", color: ddpTask ? TH.text : TH.textSub2, fontWeight: ddpTask ? 600 : 400 }}>{ddpTask ? formatDate(ddpTask.due) : "—"}</td>
                                <td style={{ padding: "10px 14px" }}>
                                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                    <div style={{ flex: 1, height: 6, background: "#CBD5E0", borderRadius: 3, minWidth: 60 }}>
                                      <div style={{ width: `${pct}%`, height: "100%", background: pct === 100 ? "#10B981" : brand.color, borderRadius: 3, transition: "width 0.3s" }} />
                                    </div>
                                    <span style={{ fontSize: 11, color: TH.textSub2, flexShrink: 0 }}>{pct}%</span>
                                  </div>
                                </td>
                                <td style={{ padding: "10px 14px", color: next ? TH.text : TH.textSub2 }}>{next ? `${next.phase} · ${formatDate(next.due)}` : "All done"}</td>
                              </tr>
                              {isExpanded && (
                                <tr>
                                  <td colSpan={7} style={{ background: "#EEF2F9", padding: 0, borderBottom: `2px solid ${TH.border}` }}>
                                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, fontFamily: "inherit" }}>
                                      <thead>
                                        <tr style={{ background: "#3A4A5C", borderBottom: `1px solid #2D3748` }}>
                                          {["Phase", "Due Date", "Business Days Left", "Status", "Assignee"].map(h => (
                                            <th key={h} style={{ padding: "7px 14px 7px 28px", textAlign: "left", fontWeight: 600, color: "rgba(255,255,255,0.7)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em" }}>{h}</th>
                                          ))}
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {sortedTasks.map((t, ti) => {
                                          const sc = STATUS_CONFIG[t.status] || STATUS_CONFIG["Not Started"];
                                          const assignee = team.find(m => m.id === t.assigneeId);
                                          const bd = getBusinessDaysUntil(t.due);
                                          const innerBg = ti % 2 === 0 ? "#F8FAFC" : "#FFFFFF";
                                          return (
                                            <tr key={t.id} onClick={e => { e.stopPropagation(); setEditTask(t); }}
                                              style={{ borderBottom: `1px solid ${TH.border}`, cursor: "pointer", background: innerBg }}
                                              onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = "#E2E8F0"}
                                              onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = innerBg}>
                                              <td style={{ padding: "8px 14px 8px 28px", fontWeight: 600, color: TH.text }}>{t.phase}</td>
                                              <td style={{ padding: "8px 14px 8px 28px", color: TH.textSub2 }}>{formatDate(t.due)}</td>
                                              <td style={{ padding: "8px 14px 8px 28px", color: bd < 0 ? "#B91C1C" : bd <= 5 ? "#B45309" : TH.textSub, fontWeight: bd < 0 ? 700 : 400 }}>{t.status === "Complete" ? "Done" : fmtDays(bd)}</td>
                                              <td style={{ padding: "8px 14px 8px 28px" }}>
                                                <span style={{ background: sc.bg, color: sc.color, border: `1px solid ${sc.border}`, padding: "2px 8px", borderRadius: 10, fontSize: 10, fontWeight: 600 }}>{t.status}</span>
                                              </td>
                                              <td style={{ padding: "8px 14px 8px 28px", color: TH.textSub2 }}>{assignee?.name || "—"}</td>
                                            </tr>
                                          );
                                        })}
                                      </tbody>
                                    </table>
                                  </td>
                                </tr>
                              )}
                            </Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* GRID VIEW */}
                {!collListView && <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill,minmax(300px,1fr))",
                    gap: 12,
                    marginBottom: 28,
                  }}
                >
                  {collList.map((c) => {
                    const brand = getBrand(c.brand) || { id: "unknown", name: "Unknown", color: "#6B7280", short: "?" },
                      done = c.tasks.filter((t) =>
                        ["Complete", "Approved"].includes(t.status)
                      ).length,
                      pct = Math.round((done / c.tasks.length) * 100),
                      hasDelay = c.tasks.some((t) => t.status === "Delayed");
                    const next = c.tasks
                      .filter(
                        (t) => !["Complete", "Approved"].includes(t.status)
                      )
                      .sort((a, b) => +new Date(a.due) - +new Date(b.due))[0];
                    const collData = collections[c.key] || {},
                      skuCount = collData.skus?.length || 0;
                    const assigneeIds = [
                      ...new Set(
                        c.tasks.map((t) => t.assigneeId).filter(Boolean)
                      ),
                    ];
                    const isFocused = focusCollKey === c.key;
                    const ddpTask = c.tasks.find((t) => t.phase === "DDP");
                    return (
                      <div
                        key={c.key}
                        onClick={(e) => {
                          e.stopPropagation();
                          setFocusCollKey(isFocused ? null : c.key);
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setCtxMenu({
                            x: e.clientX,
                            y: e.clientY,
                            collKey: c.key,
                          });
                        }}
                        style={{
                          ...S.card,
                          cursor: "pointer",
                          outline: isFocused
                            ? `2px solid ${brand.color}`
                            : "2px solid transparent",
                          outlineOffset: 2,
                          transition: "all 0.15s",
                          transform: isFocused ? "scale(1.01)" : "scale(1)",
                          position: "relative",
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            position: "absolute",
                            top: 0,
                            left: 0,
                            right: 0,
                            height: 3,
                            background: TH.primary,
                          }}
                        />
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "flex-start",
                            marginBottom: 10,
                            paddingTop: 4,
                          }}
                        >
                          <div>
                            {/* Line 1: Brand · Collection Name · Sample Due */}
                            <div style={{ fontSize: 11, fontWeight: 700, color: TH.primary, marginBottom: 2 }}>
                              {brand.short || brand.name} · {c.collection}{collData.sampleDueDate ? ` · Sample: ${formatDate(collData.sampleDueDate)}` : ""}
                            </div>
                            {/* Line 2: Season Year · Gender · Category */}
                            <div style={{ fontSize: 11, color: TH.textSub2 }}>
                              {c.season}
                              {collData.year ? ` ${collData.year}` : ""}
                              {collData.gender ? ` · ${collData.gender}` : ""}
                              {c.category ? ` · ${c.category}` : ""}
                            </div>
                            {/* Line 3: Vendor · DDP · Exit Factory */}
                            {(() => {
                              const shipTask = c.tasks.find((t) => t.phase === "Ship Date");
                              const parts = [];
                              if (c.vendorName) parts.push(c.vendorName);
                              if (ddpTask) parts.push(`DDP: ${formatDate(ddpTask.due)}`);
                              if (shipTask) parts.push(`Exit Factory: ${formatDate(shipTask.due)}`);
                              return parts.length > 0 ? (
                                <div style={{ fontSize: 11, color: TH.textMuted, marginTop: 2 }}>
                                  {parts.join(" · ")}
                                </div>
                              ) : null;
                            })()}
                            {/* Line 4: Customer · Start Ship · Cancel */}
                            {(() => {
                              const parts = [];
                              if (collData.customer) {
                                parts.push(collData.customer + (collData.orderType ? ` (${collData.orderType})` : ""));
                              }
                              if (collData.customerShipDate) parts.push(`Start Ship: ${formatDate(collData.customerShipDate)}`);
                              if (collData.cancelDate) parts.push(`Cancel: ${formatDate(collData.cancelDate)}`);
                              return parts.length > 0 ? (
                                <div style={{ fontSize: 11, color: TH.textMuted, marginTop: 2 }}>
                                  {parts.join(" · ")}
                                </div>
                              ) : null;
                            })()}
                          </div>
                          <div style={{ textAlign: "right" }}>
                            <div
                              style={{
                                fontSize: 24,
                                fontWeight: 800,
                                color: pct === 100 ? "#047857" : TH.text,
                                lineHeight: 1,
                              }}
                            >
                              {pct}%
                            </div>
                            {hasDelay && (
                              <div
                                style={{
                                  fontSize: 10,
                                  color: "#B91C1C",
                                  fontWeight: 700,
                                }}
                              >
                                ⚠ Delayed
                              </div>
                            )}
                          </div>
                        </div>
                        <div
                          style={{
                            height: 5,
                            background: TH.surfaceHi,
                            border: `1px solid ${TH.border}`,
                            borderRadius: 3,
                            overflow: "hidden",
                            marginBottom: 10,
                          }}
                        >
                          <div
                            style={{
                              height: "100%",
                              width: `${pct}%`,
                              background: `linear-gradient(90deg,${brand.color},${TH.primary})`,
                              borderRadius: 3,
                              transition: "width 0.6s",
                            }}
                          />
                        </div>
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            marginBottom: 6,
                          }}
                        >
                          {next && (
                            <div style={{ fontSize: 11, color: TH.textMuted }}>
                              Next:{" "}
                              <span
                                style={{ color: TH.textSub2, fontWeight: 600 }}
                              >
                                {next.phase}
                              </span>{" "}
                              —{" "}
                              <span
                                style={{
                                  color:
                                    getDaysUntil(next.due) < 0
                                      ? "#B91C1C"
                                      : getDaysUntil(next.due) < 7
                                      ? "#B45309"
                                      : TH.primary,
                                  fontWeight: 600,
                                }}
                              >
                                {formatDate(next.due)}
                              </span>
                            </div>
                          )}
                          <div style={{ fontSize: 11, color: TH.textMuted }}>
                            {skuCount} SKU{skuCount !== 1 ? "s" : ""}
                          </div>
                        </div>
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              gap: 3,
                              flexWrap: "wrap",
                            }}
                          >
                            {c.tasks
                              .sort((a, b) => +new Date(a.due) - +new Date(b.due))
                              .map((t) => (
                                <span
                                  key={t.id}
                                  title={`${t.phase}: ${t.status}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setEditTask(t);
                                  }}
                                  style={{
                                    width: 9,
                                    height: 9,
                                    borderRadius: 2,
                                    background:
                                      STATUS_CONFIG[t.status]?.dot || TH.border,
                                    display: "inline-block",
                                    cursor: "pointer",
                                  }}
                                />
                              ))}
                          </div>
                          <div style={{ display: "flex", gap: 3 }}>
                            {assigneeIds.slice(0, 4).map((id) => {
                              const m = team.find((x) => x.id === id);
                              return m ? (
                                <Avatar key={id} member={m} size={20} />
                              ) : null;
                            })}
                          </div>
                        </div>
                        <div
                          style={{
                            marginTop: 10,
                            paddingTop: 10,
                            borderTop: `1px solid ${TH.border}`,
                            display: "flex",
                            gap: 6,
                          }}
                        >
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setFocusCollKey(c.key);
                              setView("timeline");
                            }}
                            style={{
                              flex: 1,
                              padding: "4px 6px",
                              borderRadius: 6,
                              border: `1px solid ${brand.color}44`,
                              background: brand.color + "12",
                              color: brand.color,
                              cursor: "pointer",
                              fontFamily: "inherit",
                              fontSize: 10,
                              fontWeight: 700,
                            }}
                          >
                            📊 Timeline
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setFocusCollKey(c.key);
                              setView("calendar");
                            }}
                            style={{
                              flex: 1,
                              padding: "4px 6px",
                              borderRadius: 6,
                              border: `1px solid ${brand.color}44`,
                              background: brand.color + "12",
                              color: brand.color,
                              cursor: "pointer",
                              fontFamily: "inherit",
                              fontSize: 10,
                              fontWeight: 700,
                            }}
                          >
                            📅 Calendar
                          </button>
                          {/* Images button with concept/sku submenu */}
                        </div>
                      </div>
                    );
                  })}
                </div>}
                {!statFilter && dueThisWeek.length > 0 && (
                  <>
                    <span style={S.sec}>Due This Week</span>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns:
                          "repeat(auto-fill,minmax(220px,1fr))",
                        gap: 10,
                      }}
                    >
                      {dueThisWeek.map((t) => (
                        <TaskCard key={t.id} task={t} />
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
          </>
        )}
      </div>
    );
}

// Proper React component — reads from Zustand store, only needs TaskCard as prop
export const DashboardPanel = React.memo(function DashboardPanel({ ctx }: { ctx: DashboardCtx }) {
  return <DashboardPanelInner TaskCard={ctx.TaskCard} />;
});

// Legacy export for any remaining callers
