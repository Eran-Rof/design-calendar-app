import React, { Fragment } from "react";
import { S, TH, fmtDays } from "./styles";
import { formatDate, getDaysUntil, getBusinessDaysUntil } from "../utils/dates";
import { STATUS_CONFIG, MONTHS } from "../utils/constants";
import Avatar from "../components/Avatar";
import { useAppStore } from "../store";
import { selectGetBrand, selectIsAdmin, selectCanViewAll, selectFiltered, selectOverdue, selectDueThisWeek, selectDue30, selectCollMap, selectCollList } from "../store/selectors";
import { STAT_META_CONFIG, type StatFilterKey } from "./dashboard/statMeta";
import { OverdueBanner } from "./dashboard/OverdueBanner";
import { EmptyState } from "./dashboard/EmptyState";
import {
  DAY_NAMES,
  buildDayStrip,
  buildMonthsInRange,
  groupTasksByDueDate,
  tasksOnDay,
  isWeekend,
} from "./dashboard/calendars";
import { MiniCalendarThisWeek } from "./dashboard/MiniCalendarThisWeek";
import { MiniCalendarNext30Days } from "./dashboard/MiniCalendarNext30Days";
import { CollectionListView } from "./dashboard/CollectionListView";
import { CollectionGridView } from "./dashboard/CollectionGridView";
import { toDateStr } from "../utils/dates";

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
    // Visual config lives in ./dashboard/statMeta.ts. We merge in the
    // runtime task arrays here so the panel reads the same shape it
    // used to (label/color/bg/bdr/accent + tasks).
    const STAT_TASKS: Record<StatFilterKey, typeof overdue> = {
      overdue,
      week:         dueThisWeek,
      "30d":        due30,
      collections:  [],
    };
    const STAT_META = (Object.keys(STAT_META_CONFIG) as StatFilterKey[]).reduce((acc, k) => {
      acc[k] = { ...STAT_META_CONFIG[k], tasks: STAT_TASKS[k] };
      return acc;
    }, {} as Record<StatFilterKey, typeof STAT_META_CONFIG[StatFilterKey] & { tasks: typeof overdue }>);
    const activeMeta = statFilter ? STAT_META[statFilter as StatFilterKey] : null;
    const showTaskList = statFilter && statFilter !== "collections";
    const showCollections = !statFilter || statFilter === "collections";

    return (
      <div onClick={() => { if (ctxMenu) setCtxMenu(null); }}>
        {!statFilter && <OverdueBanner overdue={overdue} getBrand={getBrand} />}
        {tasks.length === 0 && (
          <EmptyState isAdmin={isAdmin} onCreateCollection={() => setShowWizard(true)} />
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
                {statFilter === "week" && activeMeta && (
                  <MiniCalendarThisWeek
                    tasks={activeMeta.tasks}
                    dragId={dragId}
                    miniCalDragOver={miniCalDragOver}
                    getBrand={getBrand}
                    setDragId={setDragId}
                    setMiniCalDragOver={setMiniCalDragOver}
                    setTasks={setTasks}
                    setEditTask={setEditTask}
                  />
                )}

                {/* Mini calendar for "Next 30 Days" */}
                {statFilter === "30d" && activeMeta && (
                  <MiniCalendarNext30Days
                    tasks={activeMeta.tasks}
                    dueThisWeek={dueThisWeek}
                    dragId={dragId}
                    miniCalDragOver={miniCalDragOver}
                    getBrand={getBrand}
                    setDragId={setDragId}
                    setMiniCalDragOver={setMiniCalDragOver}
                    setTasks={setTasks}
                    setEditTask={setEditTask}
                  />
                )}
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
                  <CollectionListView
                    collList={collList}
                    expandedColl={expandedColl}
                    team={team}
                    getBrand={getBrand}
                    setExpandedColl={setExpandedColl}
                    setEditTask={setEditTask}
                  />
                )}

                {/* GRID VIEW */}
                {!collListView && (
                  <CollectionGridView
                    collList={collList}
                    collections={collections}
                    team={team}
                    focusCollKey={focusCollKey}
                    getBrand={getBrand}
                    setFocusCollKey={setFocusCollKey}
                    setCtxMenu={setCtxMenu}
                    setEditTask={setEditTask}
                    setView={setView}
                  />
                )}
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
