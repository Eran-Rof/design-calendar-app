// Collections "List" view (table) extracted from dashboardPanel.tsx.
// Each row collapses/expands to reveal that collection's tasks. Click
// a task row in the expanded sub-table to open the edit-task modal.
//
// All store state + setters are passed as props so the component can
// mount in isolation for tests.

import { Fragment } from "react";
import { TH, fmtDays } from "../styles";
import { STATUS_CONFIG } from "../../utils/constants";
import { formatDate, getBusinessDaysUntil } from "../../utils/dates";
import type { Task, Brand, TeamMember, CollectionGroup } from "../../store/types";

const TABLE_HEADERS = ["Brand", "Collection", "Season", "Vendor", "DDP", "Progress", "Next Task"];
const INNER_HEADERS = ["Phase", "Due Date", "Business Days Left", "Status", "Assignee"];

export interface CollectionListViewProps {
  collList: CollectionGroup[];
  expandedColl: string | null;
  team: TeamMember[];
  getBrand: (brand: string) => Brand | undefined;
  setExpandedColl: (key: string | null) => void;
  setEditTask: (task: Task) => void;
}

export function CollectionListView({
  collList,
  expandedColl,
  team,
  getBrand,
  setExpandedColl,
  setEditTask,
}: CollectionListViewProps) {
  return (
    <div style={{ marginBottom: 28, border: `1px solid ${TH.border}`, borderRadius: 12, overflow: "hidden" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: "inherit" }}>
        <thead>
          <tr style={{ background: TH.header, borderBottom: `2px solid ${TH.header}` }}>
            {TABLE_HEADERS.map(h => (
              <th key={h} style={{ padding: "10px 14px", textAlign: "left", fontWeight: 700, color: "rgba(255,255,255,0.75)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {collList.map((c, ri) => {
            const brand = getBrand(c.brand) || ({ id: "unknown", name: "Unknown", color: "#6B7280", short: "?" } as Brand);
            const done = c.tasks.filter(t => ["Complete", "Approved"].includes(t.status)).length;
            const pct = c.tasks.length === 0 ? 0 : Math.round((done / c.tasks.length) * 100);
            const ddpTask = c.tasks.find(t => t.phase === "DDP");
            const next = c.tasks.filter(t => !["Complete", "Approved"].includes(t.status))
              .sort((a, b) => new Date(a.due).getTime() - new Date(b.due).getTime())[0];
            const isExpanded = expandedColl === c.key;
            const sortedTasks = [...c.tasks].sort((a, b) => new Date(a.due).getTime() - new Date(b.due).getTime());
            const rowBg = isExpanded ? "#E8EDF5" : ri % 2 === 0 ? "#FFFFFF" : "#F1F5F9";
            return (
              <Fragment key={c.key}>
                <tr
                  onClick={() => setExpandedColl(isExpanded ? null : c.key)}
                  style={{ borderBottom: `1px solid ${TH.border}`, cursor: "pointer", background: rowBg, transition: "background 0.1s" }}
                  onMouseEnter={e => ((e.currentTarget as HTMLElement).style.background = "#DDE3EE")}
                  onMouseLeave={e => ((e.currentTarget as HTMLElement).style.background = rowBg)}
                >
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
                  <td style={{ padding: "10px 14px", color: ddpTask ? TH.text : TH.textSub2, fontWeight: ddpTask ? 600 : 400 }}>
                    {ddpTask ? formatDate(ddpTask.due) : "—"}
                  </td>
                  <td style={{ padding: "10px 14px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={{ flex: 1, height: 6, background: "#CBD5E0", borderRadius: 3, minWidth: 60 }}>
                        <div style={{ width: `${pct}%`, height: "100%", background: pct === 100 ? "#10B981" : brand.color, borderRadius: 3, transition: "width 0.3s" }} />
                      </div>
                      <span style={{ fontSize: 11, color: TH.textSub2, flexShrink: 0 }}>{pct}%</span>
                    </div>
                  </td>
                  <td style={{ padding: "10px 14px", color: next ? TH.text : TH.textSub2 }}>
                    {next ? `${next.phase} · ${formatDate(next.due)}` : "All done"}
                  </td>
                </tr>
                {isExpanded && (
                  <tr>
                    <td colSpan={7} style={{ background: "#EEF2F9", padding: 0, borderBottom: `2px solid ${TH.border}` }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, fontFamily: "inherit" }}>
                        <thead>
                          <tr style={{ background: "#3A4A5C", borderBottom: `1px solid #2D3748` }}>
                            {INNER_HEADERS.map(h => (
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
                              <tr
                                key={t.id}
                                onClick={e => { e.stopPropagation(); setEditTask(t); }}
                                style={{ borderBottom: `1px solid ${TH.border}`, cursor: "pointer", background: innerBg }}
                                onMouseEnter={e => ((e.currentTarget as HTMLElement).style.background = "#E2E8F0")}
                                onMouseLeave={e => ((e.currentTarget as HTMLElement).style.background = innerBg)}
                              >
                                <td style={{ padding: "8px 14px 8px 28px", fontWeight: 600, color: TH.text }}>{t.phase}</td>
                                <td style={{ padding: "8px 14px 8px 28px", color: TH.textSub2 }}>{formatDate(t.due)}</td>
                                <td style={{ padding: "8px 14px 8px 28px", color: bd < 0 ? "#B91C1C" : bd <= 5 ? "#B45309" : TH.textSub, fontWeight: bd < 0 ? 700 : 400 }}>
                                  {t.status === "Complete" ? "Done" : fmtDays(bd)}
                                </td>
                                <td style={{ padding: "8px 14px 8px 28px" }}>
                                  <span style={{ background: sc.bg, color: sc.color, border: `1px solid ${sc.border}`, padding: "2px 8px", borderRadius: 10, fontSize: 10, fontWeight: 600 }}>
                                    {t.status}
                                  </span>
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
