import React from "react";
import { S, TH, fmtDays } from "./styles";
import { formatDate, getDaysUntil, getDaysUntilForPhase, addDays, diffDaysForPhase, parseLocalDate, snapToBusinessDay, toDateStr, isPostPO } from "../utils/dates";
import { STATUS_CONFIG, PHASE_KEYS } from "../utils/constants";
import Avatar from "../components/Avatar";

export type TimelineCtx = Record<string, any>;

export function timelinePanel(ctx: TimelineCtx): React.ReactElement | null {
  const { tasks, collections, setView, focusCollKey, setFocusCollKey, setEditTask, timelineBackFilter, setTimelineBackFilter, expandedColl, setExpandedColl, dragId, setDragId, dragOverId, setDragOverId, setStatFilter, pushUndo, team, filtered, overdue, sbSaveTask, saveCascade, setTasks, isAdmin, canViewAll, currentUser, filterBrand, filterSeason, filterCustomer, filterVendor, collMap, collList, listView, getBrand } = ctx;

    const g = {};
    const src = focusCollKey
      ? tasks.filter((t) => `${t.brand}||${t.collection}` === focusCollKey)
      : filtered;
    src.forEach((t) => {
      if (!g[t.brand]) g[t.brand] = {};
      if (!g[t.brand][t.collection]) g[t.brand][t.collection] = [];
      g[t.brand][t.collection].push(t);
    });
    if (!Object.keys(g).length)
      return (
        <div
          style={{
            textAlign: "center",
            color: TH.textMuted,
            padding: "60px 0",
          }}
        >
          No collections match.
          {focusCollKey && (
            <>
              <br />
              <button
                onClick={() => setFocusCollKey(null)}
                style={{
                  marginTop: 12,
                  padding: "8px 16px",
                  borderRadius: 8,
                  border: `1px solid ${TH.border}`,
                  background: "none",
                  color: TH.textMuted,
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                Show All
              </button>
            </>
          )}
        </div>
      );
    if (listView) {
      // Build collection rows from src tasks, sorted by earliest DDP
      const collMap2: Record<string, { key: string; brand: string; collection: string; tasks: typeof src }> = {};
      src.forEach(t => {
        const key = `${t.brand}||${t.collection}`;
        if (!collMap2[key]) collMap2[key] = { key, brand: t.brand, collection: t.collection, tasks: [] };
        collMap2[key].tasks.push(t);
      });
      const collRows = Object.values(collMap2).sort((a, b) => {
        const aDDP = a.tasks.find(t => t.phase === "DDP")?.due || a.tasks[0]?.due || "";
        const bDDP = b.tasks.find(t => t.phase === "DDP")?.due || b.tasks[0]?.due || "";
        return aDDP < bDDP ? -1 : 1;
      });
      return (
        <div style={{ border: `1px solid ${TH.border}`, borderRadius: 12, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: "inherit" }}>
            <thead>
              <tr style={{ background: TH.header, borderBottom: `2px solid ${TH.header}` }}>
                {["Brand", "Collection", "Season", "Vendor", "DDP", "Progress", "Next Task"].map(h => (
                  <th key={h} style={{ padding: "10px 14px", textAlign: "left", fontWeight: 700, color: "rgba(255,255,255,0.75)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {collRows.map((c, ri) => {
                const brand = getBrand(c.brand);
                const done = c.tasks.filter(t => ["Complete","Approved"].includes(t.status)).length;
                const pct = Math.round((done / c.tasks.length) * 100);
                const ddpTask = c.tasks.find(t => t.phase === "DDP");
                const next = c.tasks.filter(t => !["Complete","Approved"].includes(t.status)).sort((a,b) => new Date(a.due).getTime() - new Date(b.due).getTime())[0];
                const isExpanded = expandedColl === c.key;
                const sortedTasks = [...c.tasks].sort((a,b) => new Date(a.due).getTime() - new Date(b.due).getTime());
                const rowBg = isExpanded ? "#E8EDF5" : ri % 2 === 0 ? "#FFFFFF" : "#F1F5F9";
                const season = c.tasks[0]?.season || "—";
                const vendorName = c.tasks[0]?.vendorName || "—";
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
                      <td style={{ padding: "10px 14px", color: TH.textSub2 }}>{season}</td>
                      <td style={{ padding: "10px 14px", color: TH.textSub2 }}>{vendorName}</td>
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
      );
    }

    return (
      <div
        style={{
          background: "#EEF1F6",
          borderRadius: 14,
          padding: "22px",
          minHeight: 200,
        }}
      >
        {timelineBackFilter && (
          <div style={{ marginBottom: 14 }}>
            <button
              onClick={() => {
                setView("dashboard");
                setStatFilter(timelineBackFilter);
                setTimelineBackFilter(null);
                setFocusCollKey(null);
              }}
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 14px", borderRadius: 8, border: `1px solid ${TH.accentBdr}`, background: TH.accent, color: TH.primary, cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: 700 }}
            >
              ← Back to {timelineBackFilter === "overdue" ? "Overdue Tasks" : timelineBackFilter === "week" ? "Due This Week" : "Due in Next 30 Days"}
            </button>
          </div>
        )}
        {focusCollKey && (
          <div
            style={{
              marginBottom: 18,
              display: "flex",
              alignItems: "center",
              gap: 12,
            }}
          >
            <span style={{ fontSize: 13, color: TH.textMuted }}>
              Showing:{" "}
              <strong style={{ color: TH.text }}>
                {focusCollKey.split("||")[1]}
              </strong>
            </span>
            <button
              onClick={() => setFocusCollKey(null)}
              style={{
                padding: "4px 12px",
                borderRadius: 6,
                border: `1px solid ${TH.border}`,
                background: "none",
                color: TH.textMuted,
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 12,
              }}
            >
              ✕ Show All
            </button>
          </div>
        )}
        {Object.entries(g).map(([bid, colls]) => {
          const brand = getBrand(bid);
          return (
            <div key={bid} style={{ marginBottom: 36 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  marginBottom: 16,
                }}
              >
                <div
                  style={{
                    width: 4,
                    height: 28,
                    background: brand.color,
                    borderRadius: 2,
                  }}
                />
                <span style={{ fontSize: 17, fontWeight: 700, color: TH.primary }}>
                  {brand.name.toUpperCase()}
                  {(() => {
                    // Find sampleDueDate from any collection under this brand
                    const sampleDate = Object.keys(colls)
                      .map((cname) => (collections[`${bid}||${cname}`] || {}).sampleDueDate)
                      .find(Boolean);
                    return sampleDate ? (
                      <span style={{ fontSize: 12, fontWeight: 700, color: TH.textMuted, marginLeft: 12, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                        · SAMPLES DUE: {formatDate(sampleDate)}
                      </span>
                    ) : null;
                  })()}
                </span>
              </div>
              {Object.entries(colls).map(([cname, ctasks]) => {
                const ALL_PHASES = [
                  ...PHASE_KEYS.slice(0, PHASE_KEYS.indexOf("Purchase Order")),
                  "Line Review",
                  "Compliance/Testing",
                  ...PHASE_KEYS.slice(PHASE_KEYS.indexOf("Purchase Order")),
                ];
                const sorted = [...ctasks].sort((a, b) => {
                  // Primary sort: chronological by due date
                  const dateDiff = new Date(a.due) - new Date(b.due);
                  if (dateDiff !== 0) return dateDiff;
                  // Tiebreaker: use standard phase order when dates are equal
                  const ai = ALL_PHASES.indexOf(a.phase);
                  const bi = ALL_PHASES.indexOf(b.phase);
                  return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
                });
                const collData = collections[`${bid}||${cname}`] || {};
                const ddpTask = sorted.find((t) => t.phase === "DDP");
                return (
                  <div key={cname} style={{ marginBottom: 24, marginLeft: 16, padding: "16px 16px 0", background: "#fff", borderRadius: 14 }}>
                    <div
                      style={{
                        fontSize: 12,
                        color: TH.textMuted,
                        letterSpacing: "0.07em",
                        textTransform: "uppercase",
                        marginBottom: 8,
                        display: "flex",
                        alignItems: "center",
                        gap: 16,
                        flexWrap: "wrap",
                      }}
                    >
                      {/* Line 1: Brand · Collection · Sample Due */}
                      <span style={{ fontWeight: 700, color: TH.primary }}>
                        {brand.short || brand.name}
                      </span>
                      <span style={{ fontWeight: 700, color: TH.textMuted }}>
                        {cname}
                      </span>
                      {collData.sampleDueDate && (
                        <span style={{ fontWeight: 600, color: "#B45309" }}>
                          · Sample Due: {formatDate(collData.sampleDueDate)}
                        </span>
                      )}
                      {/* Season · Year · Gender · Category */}
                      <span style={{ fontWeight: 400, color: TH.textMuted }}>
                        {ctasks[0]?.season ? `${ctasks[0].season}` : ""}
                        {collData.year ? ` ${collData.year}` : ""}
                        {collData.gender ? ` · ${collData.gender}` : ""}
                        {ctasks[0]?.category ? ` · ${ctasks[0].category}` : ""}
                      </span>
                      {/* Line 2: Vendor · DDP · Exit Factory */}
                      {(() => {
                        const shipTask = sorted.find((t) => t.phase === "Ship Date");
                        const parts = [];
                        if (ctasks[0]?.vendorName) parts.push(ctasks[0].vendorName);
                        if (ddpTask) parts.push(`DDP: ${formatDate(ddpTask.due)}`);
                        if (shipTask) parts.push(`Exit Factory: ${formatDate(shipTask.due)}`);
                        return parts.length > 0 ? (
                          <span style={{ color: TH.textMuted, fontWeight: 400 }}>
                            {parts.join(" · ")}
                          </span>
                        ) : null;
                      })()}
                      {/* Line 3: Customer · Start Ship · Cancel */}
                      {(() => {
                        const shipDays = collData.customerShipDate ? getDaysUntil(collData.customerShipDate) : null;
                        const parts = [];
                        if (collData.customer) parts.push(collData.customer + (collData.orderType ? ` (${collData.orderType})` : ""));
                        if (collData.customerShipDate) parts.push(`Start Ship: ${formatDate(collData.customerShipDate)}`);
                        if (collData.cancelDate) parts.push(`Cancel: ${formatDate(collData.cancelDate)}`);
                        return parts.length > 0 ? (
                          <span style={{ color: TH.textMuted, fontWeight: 400 }}>
                            {parts.join(" · ")}
                          </span>
                        ) : null;
                      })()}
                    </div>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "stretch",
                        overflowX: "auto",
                        paddingBottom: 16,
                        gap: 0,
                      }}
                    >
                      {/* ── DROP ZONE before first card ── */}
                      {(() => {
                        const beforeKey = `${bid}-${cname}-gap-before`;
                        const isBefore = dragOverId === beforeKey;
                        return (
                          <div
                            onDragOver={e => { e.preventDefault(); e.stopPropagation(); if (dragOverId !== beforeKey) setDragOverId(beforeKey); }}
                            onDragEnter={e => { e.preventDefault(); setDragOverId(beforeKey); }}
                            onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverId(null); }}
                            onDrop={e => {
                              e.preventDefault(); e.stopPropagation();
                              const droppedId = e.dataTransfer.getData("text/plain") || dragId;
                              if (!droppedId || !sorted.length) return;
                              const droppedTask = tasks.find(x => x.id === droppedId);
                              // Post-PO phases use calendar days; pre-PO snap to business day
                              const rawDue = addDays(sorted[0].due, -1);
                              const newDue = droppedTask && isPostPO(droppedTask.phase)
                                ? rawDue
                                : snapToBusinessDay(rawDue);
                              if (droppedTask) {
                                pushUndo(tasks, 'drag');
                                const updated = { ...droppedTask, due: newDue };
                                setTasks(ts => ts.map(x => x.id === droppedId ? updated : x));
                                sbSaveTask(updated);
                              }
                              setDragId(null); setDragOverId(null);
                            }}
                            style={{ width: isBefore ? 52 : dragId ? 40 : 28, minHeight: "100%", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", cursor: "copy", transition: "width 0.12s", position: "relative", zIndex: 2 }}
                          >
                            {isBefore && (
                              <div style={{ width: 4, height: "100%", minHeight: 80, background: brand.color, borderRadius: 4, boxShadow: `0 0 0 3px ${brand.color}44`, position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}>
                                <div style={{ width: 24, height: 24, borderRadius: "50%", background: brand.color, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 3, position: "absolute" }}>
                                  <span style={{ color: "#fff", fontSize: 14, fontWeight: 900, lineHeight: 1 }}>+</span>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })()}
                      {sorted.map((t, i) => {
                        const sc =
                            STATUS_CONFIG[t.status] ||
                            STATUS_CONFIG["Not Started"],
                          days = getDaysUntilForPhase(t.due, t.phase),
                          isOver = days < 0 && t.status !== "Complete",
                          isPL =
                            t.phase === "Line Review" ||
                            t.phase === "Compliance/Testing",
                          isDDP = t.phase === "DDP",
                          isShip = t.phase === "Ship Date";
                        const assignee =
                          team.find((m) => m.id === t.assigneeId) || null;
                        const countdownColor = isOver
                          ? "#B91C1C"
                          : days <= 7
                          ? "#B45309"
                          : days <= 14
                          ? "#D97706"
                          : "#065F46";
                        const countdownLabel =
                          t.status === "Complete"
                            ? "Done"
                            : isOver
                            ? `${fmtDays(Math.abs(days))} over`
                            : days === 0
                            ? "Today"
                            : fmtDays(days);
                        const isDraggingThis = dragId === t.id;
                        const gapKey = `${bid}-${cname}-gap-${i}`;
                        const isGapActive = dragOverId === gapKey;

                        // Days from concept (first task) to this task
                        // Post-PO phases count calendar days; pre-PO count business days
                        const conceptTask = sorted[0];
                        const daysFromConcept = conceptTask
                          ? diffDaysForPhase(t.due, conceptTask.due, t.phase)
                          : 0;

                        // Days from previous task to this task (same logic)
                        const prevTask = sorted[i - 1];
                        const daysFromPrev = prevTask
                          ? diffDaysForPhase(t.due, prevTask.due, t.phase)
                          : null;

                        return (
                          <div
                            key={t.id}
                            style={{
                              display: "flex",
                              alignItems: "stretch",
                              flexShrink: 0,
                            }}
                          >
                            {/* ── CARD ── */}
                            <div
                              draggable={true}
                              onDragStart={(e) => {
                                e.dataTransfer.effectAllowed = "move";
                                e.dataTransfer.setData("text/plain", t.id);
                                setTimeout(() => setDragId(t.id), 0);
                              }}
                              onDragEnd={() => {
                                setDragId(null);
                                setDragOverId(null);
                              }}
                              onDragOver={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                if (dragOverId !== t.id) setDragOverId(t.id);
                              }}
                              onDragLeave={(e) => {
                                if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverId(null);
                              }}
                              onDrop={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                const droppedId = e.dataTransfer.getData("text/plain") || dragId;
                                if (!droppedId || droppedId === t.id) { setDragId(null); setDragOverId(null); return; }
                                const droppedTask = tasks.find(x => x.id === droppedId);
                                if (!droppedTask) { setDragId(null); setDragOverId(null); return; }
                                // Drop on card = insert just before this card
                                const prev = sorted[i - 1];
                                let newDue: string;
                                if (prev && prev.id !== droppedId) {
                                  const prevMs = parseLocalDate(prev.due).getTime();
                                  const curMs = parseLocalDate(t.due).getTime();
                                  const mid = new Date(Math.round((prevMs + curMs) / 2));
                                  newDue = isPostPO(droppedTask.phase) ? toDateStr(mid) : snapToBusinessDay(toDateStr(mid));
                                  if (newDue <= prev.due) newDue = addDays(prev.due, 1);
                                  if (newDue >= t.due) newDue = addDays(t.due, -1);
                                  if (newDue <= prev.due) newDue = prev.due;
                                } else {
                                  newDue = isPostPO(droppedTask.phase) ? addDays(t.due, -1) : snapToBusinessDay(addDays(t.due, -1));
                                }
                                pushUndo(tasks, 'drag');
                                const updated = { ...droppedTask, due: newDue };
                                setTasks(ts => ts.map(x => x.id === droppedId ? updated : x));
                                sbSaveTask(updated);
                                setDragId(null); setDragOverId(null);
                              }}
                              onClick={() => {
                                if (!dragId) setEditTask(t);
                              }}
                              style={{
                                minWidth: 94,
                                textAlign: "center",
                                background: isDDP
                                  ? "#FFF5F5"
                                  : isShip
                                  ? "#F5FDFB"
                                  : isPL
                                  ? "#F9F8FF"
                                  : `${brand.color}08`,
                                border: `2px solid ${
                                  isDDP
                                    ? TH.primary
                                    : isShip
                                    ? "#10B981"
                                    : isPL
                                    ? "#8B5CF6"
                                    : brand.color + "44"
                                }`,
                                borderRadius: 10,
                                cursor: "pointer",
                                boxShadow: `0 2px 6px ${TH.shadow}`,
                                opacity: isDraggingThis ? 0.3 : 1,
                                transition: "opacity 0.15s",
                                userSelect: "none",
                                overflow: "hidden",
                              }}
                            >
                              {/* Drag handle */}
                              <div
                                style={{
                                  background: isDDP
                                    ? TH.primary + "22"
                                    : isShip
                                    ? "#10B98122"
                                    : isPL
                                    ? "#8B5CF622"
                                    : brand.color + "22",
                                  borderBottom: `1px solid ${brand.color}22`,
                                  padding: "4px 6px 3px",
                                  cursor: "grab",
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  gap: 3,
                                }}
                              >
                                {[0, 1, 2, 3, 4].map((d) => (
                                  <div
                                    key={d}
                                    style={{
                                      width: 3,
                                      height: 3,
                                      borderRadius: "50%",
                                      background: brand.color + "99",
                                    }}
                                  />
                                ))}
                              </div>
                              <div style={{ padding: "6px 10px 8px" }}>
                                <div
                                  style={{
                                    fontSize: 13,
                                    color: TH.text,
                                    fontWeight: 700,
                                    marginBottom: 3,
                                  }}
                                >
                                  {t.phase}
                                </div>
                                {isPL && (
                                  <div
                                    style={{
                                      fontSize: 9,
                                      color: "#6D28D9",
                                      marginBottom: 2,
                                      fontWeight: 700,
                                    }}
                                  >
                                    PL REQ
                                  </div>
                                )}
                                <div
                                  style={{
                                    fontSize: 11,
                                    padding: "2px 6px",
                                    borderRadius: 5,
                                    background: sc.bg,
                                    color: sc.color,
                                    display: "inline-block",
                                    marginBottom: 4,
                                    fontWeight: 600,
                                  }}
                                >
                                  {t.status}
                                </div>
                                <div
                                  style={{
                                    fontSize: 10,
                                    color: TH.textMuted,
                                    fontWeight: 500,
                                    marginBottom: 1,
                                  }}
                                >
                                  Due
                                </div>
                                <div
                                  style={{
                                    fontSize: 11,
                                    color: isOver
                                      ? "#B91C1C"
                                      : days <= 7
                                      ? "#B45309"
                                      : TH.textMuted,
                                    fontWeight: 600,
                                    marginBottom: 6,
                                  }}
                                >
                                  {formatDate(t.due)}
                                </div>

                                {/* Days section — matches design */}
                                <div
                                  style={{
                                    borderTop: `1px solid ${brand.color}22`,
                                    paddingTop: 6,
                                  }}
                                >
                                  <div
                                    style={{
                                      fontSize: 8,
                                      color: TH.textMuted,
                                      fontWeight: 600,
                                      textTransform: "uppercase",
                                      letterSpacing: "0.08em",
                                      marginBottom: 4,
                                    }}
                                  >
                                    To Complete
                                  </div>
                                  <div style={{ marginBottom: 6 }}>
                                    <div
                                      style={{
                                        fontSize: 13,
                                        fontWeight: 800,
                                        color: countdownColor,
                                        background: countdownColor + "18",
                                        borderRadius: 6,
                                        padding: "2px 8px",
                                        display: "inline-block",
                                      }}
                                    >
                                      {countdownLabel}
                                    </div>
                                  </div>
                                  <div
                                    style={{
                                      fontSize: 8,
                                      color: TH.textMuted,
                                      fontWeight: 600,
                                      textTransform: "uppercase",
                                      letterSpacing: "0.08em",
                                      marginBottom: 2,
                                    }}
                                  >
                                    From Last Task
                                  </div>
                                  <div
                                    style={{
                                      fontSize: 13,
                                      fontWeight: 700,
                                      color:
                                        daysFromPrev != null && daysFromPrev < 0
                                          ? "#B91C1C"
                                          : TH.textSub2,
                                    }}
                                  >
                                    {daysFromPrev == null
                                      ? "—"
                                      : fmtDays(daysFromPrev)}
                                  </div>
                                </div>

                                {assignee && (
                                  <div
                                    style={{
                                      display: "flex",
                                      justifyContent: "center",
                                      marginTop: 5,
                                    }}
                                  >
                                    <Avatar member={assignee} size={16} />
                                  </div>
                                )}
                              </div>
                            </div>

                            {/* ── DROP ZONE between cards ── */}
                            {i < sorted.length - 1 && (
                              <div
                                onDragOver={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  if (dragOverId !== gapKey)
                                    setDragOverId(gapKey);
                                }}
                                onDragEnter={(e) => {
                                  e.preventDefault();
                                  setDragOverId(gapKey);
                                }}
                                onDragLeave={(e) => {
                                  if (
                                    !e.currentTarget.contains(
                                      e.relatedTarget as Node
                                    )
                                  )
                                    setDragOverId(null);
                                }}
                                onDrop={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  const droppedId =
                                    e.dataTransfer.getData("text/plain") ||
                                    dragId;
                                  if (!droppedId) return;
                                  const prevTask = sorted[i];
                                  const nextTask = sorted[i + 1];
                                  const prevMs = parseLocalDate(prevTask.due).getTime();
                                  const nextMs = parseLocalDate(nextTask.due).getTime();
                                  const midMs = Math.round((prevMs + nextMs) / 2);
                                  const mid = new Date(midMs);
                                  const droppedTaskMid = tasks.find(x => x.id === droppedId);
                                  // Post-PO phases use calendar days; pre-PO snap to business day
                                  let newDue = droppedTaskMid && isPostPO(droppedTaskMid.phase)
                                    ? toDateStr(mid)
                                    : snapToBusinessDay(toDateStr(mid));
                                  // Enforce minimum 1 calendar day from each neighbor
                                  if (newDue <= prevTask.due) newDue = addDays(prevTask.due, 1);
                                  if (newDue >= nextTask.due) newDue = addDays(nextTask.due, -1);
                                  if (newDue <= prevTask.due) newDue = prevTask.due; // fallback
                                  const droppedTask = tasks.find(x => x.id === droppedId);
                                  if (droppedTask) {
                                    pushUndo(tasks, 'drag');
                                    const updated = { ...droppedTask, due: newDue };
                                    setTasks(ts => ts.map(x => x.id === droppedId ? updated : x));
                                    sbSaveTask(updated);
                                  }
                                  setDragId(null);
                                  setDragOverId(null);
                                }}
                                style={{
                                  width: isGapActive ? 52 : dragId ? 40 : 28,
                                  minHeight: "100%",
                                  flexShrink: 0,
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  cursor: "copy",
                                  transition: "width 0.12s",
                                  position: "relative",
                                  zIndex: 2,
                                }}
                              >
                                {isGapActive ? (
                                  <div
                                    style={{
                                      width: 4,
                                      height: "100%",
                                      minHeight: 80,
                                      background: brand.color,
                                      borderRadius: 4,
                                      boxShadow: `0 0 0 3px ${brand.color}44`,
                                      position: "relative",
                                      display: "flex",
                                      alignItems: "center",
                                      justifyContent: "center",
                                    }}
                                  >
                                    <div
                                      style={{
                                        width: 24,
                                        height: 24,
                                        borderRadius: "50%",
                                        background: brand.color,
                                        display: "flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                        boxShadow: `0 0 0 4px ${brand.color}33`,
                                        zIndex: 3,
                                        position: "absolute",
                                      }}
                                    >
                                      <span
                                        style={{
                                          color: "#fff",
                                          fontSize: 14,
                                          fontWeight: 900,
                                          lineHeight: 1,
                                          marginTop: -1,
                                        }}
                                      >
                                        +
                                      </span>
                                    </div>
                                  </div>
                                ) : (
                                  <div
                                    style={{
                                      width: "100%",
                                      height: 4,
                                      background: dragId
                                        ? brand.color + "66"
                                        : brand.color + "33",
                                      borderRadius: 2,
                                      transition: "background 0.15s",
                                    }}
                                  />
                                )}
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
        })}
      </div>
    );
}
