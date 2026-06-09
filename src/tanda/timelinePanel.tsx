import React from "react";
import { STATUS_COLORS, WIP_CATEGORIES, type XoroPO, type Milestone, type View } from "../utils/tandaTypes";
import S from "./styles";

export interface TimelinePanelCtx {
  pos: XoroPO[];
  milestones: Record<string, Milestone[]>;
  search: string;
  setSearch: (v: string) => void;
  selected: XoroPO | null;
  setSelected: (v: XoroPO | null) => void;
  setDetailMode: (v: string) => void;
  setView: (v: View) => void;
  setNewNote: (v: string) => void;
  openCategoryWithCheck: (poNum: string, cat: string, po: XoroPO, fromTimeline: boolean) => void;
}

export function timelinePanel(ctx: TimelinePanelCtx): React.ReactElement | null {
  const { pos, milestones, search, setSearch, selected, setSelected, setDetailMode, setView, setNewNote, openCategoryWithCheck } = ctx;

  const posWithMs = pos.filter(po => (milestones[po.PoNumber ?? ""] || []).length > 0);
  const s = search.toLowerCase();
  const filteredPOs = posWithMs.filter(p => !s
    || (p.PoNumber ?? "").toLowerCase().includes(s)
    || (p.VendorName ?? "").toLowerCase().includes(s)
    || (p.Memo ?? "").toLowerCase().includes(s)
    || (p.Tags ?? "").toLowerCase().includes(s)
    || (p.StatusName ?? "").toLowerCase().includes(s)
  ).sort((a, b) => {
    const da = a.DateExpectedDelivery ? new Date(a.DateExpectedDelivery).getTime() : Infinity;
    const db = b.DateExpectedDelivery ? new Date(b.DateExpectedDelivery).getTime() : Infinity;
    return da - db;
  });

  let minD = Infinity, maxD = -Infinity;
  filteredPOs.forEach(po => {
    (milestones[po.PoNumber ?? ""] || []).forEach(m => {
      if (m.expected_date) { const d = new Date(m.expected_date).getTime(); if (d < minD) minD = d; if (d > maxD) maxD = d; }
    });
  });
  if (!isFinite(minD)) { minD = Date.now(); maxD = Date.now() + 120 * 86400000; }

  const DAY = 86400000;
  const startDate = new Date(minD - 21 * DAY); startDate.setDate(startDate.getDate() - startDate.getDay());
  const endDate = new Date(maxD + 21 * DAY);
  const totalDays = Math.ceil((endDate.getTime() - startDate.getTime()) / DAY);
  const dayWidth = Math.max(6, Math.min(20, 1200 / totalDays));
  const chartWidth = totalDays * dayWidth;
  const today = new Date();
  const todayOffset = Math.floor((today.getTime() - startDate.getTime()) / DAY) * dayWidth;
  const LEFT_W = 380;
  const ROW_H = 140;

  const weeks: { date: Date; offset: number }[] = [];
  const cur = new Date(startDate);
  while (cur.getTime() < endDate.getTime()) {
    weeks.push({ date: new Date(cur), offset: Math.floor((cur.getTime() - startDate.getTime()) / DAY) * dayWidth });
    cur.setDate(cur.getDate() + 7);
  }

  const monthSpans: { label: string; left: number; width: number }[] = [];
  let prevMonth = -1;
  weeks.forEach((w, i) => {
    const m = w.date.getMonth();
    if (m !== prevMonth) {
      const nextMonthIdx = weeks.findIndex((ww, j) => j > i && ww.date.getMonth() !== m);
      const endOff = nextMonthIdx >= 0 ? weeks[nextMonthIdx].offset : chartWidth;
      monthSpans.push({ label: w.date.toLocaleDateString("en-US", { month: "long", year: "numeric" }), left: w.offset, width: endOff - w.offset });
      prevMonth = m;
    }
  });

  const toX = (d: string) => Math.floor((new Date(d).getTime() - startDate.getTime()) / DAY) * dayWidth;

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: "0 0 2px", color: "#F1F5F9", fontSize: 20, fontWeight: 700 }}>Production Timeline</h2>
          <div style={{ color: "#6B7280", fontSize: 12 }}>{filteredPOs.length} POs · {filteredPOs.reduce((s, p) => s + (milestones[p.PoNumber ?? ""] || []).filter(m => m.status !== "N/A").length, 0)} milestones</div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍 Search PO#, vendor, brand, style #…" style={{ ...S.input, width: 280, marginBottom: 0, fontSize: 14 }} />
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", gap: 12, fontSize: 12, color: "#94A3B8", alignItems: "center" }}>
              <span style={{ fontSize: 10, color: "#6B7280", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, width: 80, flexShrink: 0 }}>Milestones:</span>
              {[["linear-gradient(90deg,#6EE7B7,#047857)","Complete"],["linear-gradient(90deg,#93C5FD,#1D4ED8)","In Progress"],["linear-gradient(90deg,#FCA5A5,#7F1D1D)","Delayed"],["linear-gradient(90deg,#6B7280,#1F2937)","Not Started"]].map(([c,l]) => (
                <span key={l} style={{ display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 24, height: 14, borderRadius: 7, background: c }} />{l}</span>
              ))}
            </div>
            <div style={{ display: "flex", gap: 12, fontSize: 12, color: "#94A3B8", alignItems: "center" }}>
              <span style={{ fontSize: 10, color: "#6B7280", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, width: 80, flexShrink: 0 }}>PO Status:</span>
              {[["#3B82F6","Open"],["#8B5CF6","Released"],["#F59E0B","Pending"],["#9CA3AF","Draft"]].map(([c,l]) => (
                <span key={l} style={{ display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 10, height: 10, borderRadius: "50%", background: c }} />{l}</span>
              ))}
            </div>
          </div>
        </div>
      </div>

      <style>{`
        .tl-scroll::-webkit-scrollbar { height: 14px; width: 14px; }
        .tl-scroll::-webkit-scrollbar-track { background: #0F172A; border-radius: 7px; margin: 0 4px; }
        .tl-scroll::-webkit-scrollbar-thumb { background: #475569; border-radius: 7px; border: 2px solid #0F172A; }
        .tl-scroll::-webkit-scrollbar-thumb:hover { background: #64748B; }
        .tl-left::-webkit-scrollbar { width: 0; display: none; }
      `}</style>

      <div style={{ background: "#1E293B", borderRadius: 12, border: "1px solid #334155", overflow: "hidden", maxHeight: "calc(100vh - 180px)" }}>
        <div style={{ display: "flex", maxHeight: "calc(100vh - 180px)" }}>
          <div style={{ width: LEFT_W, flexShrink: 0, zIndex: 5, background: "#1E293B", paddingBottom: 18, overflowY: "auto", overflowX: "hidden" }} className="tl-left"
            onScroll={e => { const chart = e.currentTarget.nextElementSibling; if (chart) chart.scrollTop = e.currentTarget.scrollTop; }}>
            <div style={{ height: 44, background: "#0F172A", borderBottom: "1px solid #334155", display: "flex", alignItems: "center", padding: "0 16px", position: "sticky", top: 0, zIndex: 4 }}>
              <span style={{ fontSize: 16, fontWeight: 700, color: "#94A3B8", textTransform: "uppercase", letterSpacing: 1 }}>PO / Vendor</span>
            </div>
            <div style={{ height: 40, background: "#0F172A", borderBottom: "1px solid #334155", display: "flex", alignItems: "center", padding: "0 16px", position: "sticky", top: 44, zIndex: 4 }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: "#6B7280" }}>{filteredPOs.length} POs</span>
            </div>
            {filteredPOs.map((po, idx) => {
              const poNum = po.PoNumber ?? "";
              const poMs = milestones[poNum] || [];
              const complete = poMs.filter(m => m.status === "Complete").length;
              const active = poMs.filter(m => m.status !== "N/A").length;
              const pct = active > 0 ? Math.round((complete / active) * 100) : 0;
              const inProg = poMs.filter(m => m.status === "In Progress").length;
              const delayed = poMs.filter(m => m.status === "Delayed").length;
              const notStarted = active - complete - inProg - delayed;
              const statusColor = STATUS_COLORS[po.StatusName ?? ""] ?? "#6B7280";
              const isSelected = selected?.PoNumber === poNum;
              const statusBars = [
                [complete, "#047857", "#6EE7B7"],
                [inProg, "#1D4ED8", "#93C5FD"],
                [delayed, "#7F1D1D", "#FCA5A5"],
                [notStarted, "#374151", "#9CA3AF"],
              ].filter(([c]) => (c as number) > 0) as [number, string, string][];
              return (
                <div key={poNum}
                  onClick={() => { setDetailMode("milestones"); setNewNote(""); setSearch(""); setSelected(po); setView("list"); }}
                  style={{ height: ROW_H, display: "flex", alignItems: "center", gap: 8, padding: "0 12px", borderBottom: "1px solid #0F172A", background: isSelected ? "#334155" : idx % 2 === 0 ? "#1E293B" : "#1A2332", cursor: "pointer", borderLeft: isSelected ? "3px solid #60A5FA" : "3px solid transparent" }}
                  onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = "#334155"; }}
                  onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = idx % 2 === 0 ? "#1E293B" : "#1A2332"; }}>
                  <div style={{ width: 12, height: 12, borderRadius: "50%", background: statusColor, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color: "#60A5FA", fontFamily: "monospace" }}>{poNum}</div>
                    <div style={{ fontSize: 15, color: "#94A3B8", lineHeight: 1.3 }}>{po.VendorName ?? ""}</div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3, flexShrink: 0, width: 110 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 11, color: "#9CA3AF", fontFamily: "monospace" }}>{complete}/{active}</span>
                      <span style={{ fontSize: 12, color: "#10B981", fontWeight: 700, fontFamily: "monospace" }}>{pct}%</span>
                    </div>
                    {statusBars.map(([count, dark, light], i) => {
                      const sPct = active > 0 ? Math.round(((count as number) / active) * 100) : 0;
                      return (
                        <div key={i} style={{ width: 110, height: 6, borderRadius: 3, background: "#0F172A", overflow: "hidden" }}>
                          <div style={{ width: `${sPct}%`, height: "100%", background: `linear-gradient(90deg, ${light}, ${dark})`, borderRadius: 3, minWidth: (count as number) > 0 ? 3 : 0 }} />
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="tl-scroll" style={{ flex: 1, overflowX: "auto", overflowY: "auto", borderLeft: "2px solid #334155", paddingBottom: 4 }}
            onScroll={e => { const left = e.currentTarget.previousElementSibling; if (left) left.scrollTop = e.currentTarget.scrollTop; }}>
            <div style={{ width: chartWidth, minWidth: "100%" }}>
              <div style={{ height: 44, position: "sticky", top: 0, zIndex: 4, background: "#0F172A", borderBottom: "1px solid #334155" }}>
                {monthSpans.map((ms, i) => (
                  <div key={i} style={{ position: "absolute", left: ms.left, width: ms.width, height: "100%", display: "flex", alignItems: "center", justifyContent: "center", borderRight: "1px solid #334155" }}>
                    <span style={{ fontSize: 17, fontWeight: 700, color: "#D1D5DB", letterSpacing: 0.5 }}>{ms.label}</span>
                  </div>
                ))}
              </div>
              <div style={{ height: 40, position: "sticky", top: 44, zIndex: 4, background: "#0F172A", borderBottom: "1px solid #334155" }}>
                {weeks.map((w, i) => {
                  const wWidth = i < weeks.length - 1 ? weeks[i + 1].offset - w.offset : 7 * dayWidth;
                  const isThisWeek = today.getTime() >= w.date.getTime() && today.getTime() < w.date.getTime() + 7 * DAY;
                  return (
                    <div key={i} style={{ position: "absolute", left: w.offset, width: wWidth, height: "100%", display: "flex", alignItems: "center", justifyContent: "center", borderRight: "1px solid #1E293B", background: isThisWeek ? "#F59E0B15" : "transparent" }}>
                      <span style={{ fontSize: 15, color: isThisWeek ? "#F59E0B" : "#6B7280", fontWeight: isThisWeek ? 700 : 500 }}>
                        {w.date.toLocaleDateString("en-US", { month: "numeric", day: "numeric" })}
                      </span>
                    </div>
                  );
                })}
              </div>

              {filteredPOs.length === 0 ? (
                <div style={{ padding: 40, textAlign: "center", color: "#6B7280" }}>No POs with milestones</div>
              ) : filteredPOs.map((po, idx) => {
                const poNum = po.PoNumber ?? "";
                const poMs = milestones[poNum] || [];
                return (
                  <div key={poNum} style={{ height: ROW_H, position: "relative", borderBottom: "1px solid #0F172A", background: selected?.PoNumber === poNum ? "#334155" : idx % 2 === 0 ? "#1E293B" : "#1A2332", cursor: "pointer" }}
                    onClick={() => { setDetailMode("milestones"); setNewNote(""); setSearch(""); setSelected(po); setView("list"); }}>
                    {weeks.map((w, i) => (
                      <div key={i} style={{ position: "absolute", left: w.offset, top: 0, bottom: 0, borderLeft: "1px solid #0F172A33" }} />
                    ))}
                    <div style={{ position: "absolute", left: todayOffset, top: 0, bottom: 0, width: 2, background: "#F59E0B", zIndex: 2, opacity: 0.7 }} />
                    {WIP_CATEGORIES.map((cat, catIdx) => {
                      const catMs = poMs.filter(m => m.category === cat);
                      if (catMs.length === 0) return null;
                      const dates = catMs.map(m => m.expected_date).filter(Boolean) as string[];
                      if (dates.length === 0) return null;
                      const catStart = dates.reduce((min, d) => d < min ? d : min, dates[0]);
                      const catEnd = dates.reduce((max, d) => d > max ? d : max, dates[0]);
                      const x1 = toX(catStart);
                      const x2 = toX(catEnd);
                      const barW = Math.max(x2 - x1, dayWidth);
                      const allDone = catMs.every(m => m.status === "Complete" || m.status === "N/A");
                      const hasDelayed = catMs.some(m => m.status === "Delayed");
                      const hasInProg = catMs.some(m => m.status === "In Progress");
                      const barGradient = allDone ? "linear-gradient(90deg, #6EE7B7, #047857)" : hasDelayed ? "linear-gradient(90deg, #FCA5A5, #7F1D1D)" : hasInProg ? "linear-gradient(90deg, #93C5FD, #1D4ED8)" : "linear-gradient(90deg, #6B7280, #1F2937)";
                      const barH = 24;
                      const barY = 6 + catIdx * (barH + 3);
                      const catDone = catMs.filter(m => m.status === "Complete").length;
                      const catActive = catMs.filter(m => m.status !== "N/A").length;
                      return (
                        <div key={cat} title={`${cat}: ${catDone}/${catActive} complete\n${catStart} → ${catEnd}`}
                          onClick={e => { e.stopPropagation(); openCategoryWithCheck(poNum, cat, po, true); }}
                          style={{ position: "absolute", left: x1, width: barW, top: barY, height: barH, borderRadius: barH / 2, background: barGradient, minWidth: 6, zIndex: 3, display: "flex", alignItems: "center", overflow: "hidden", boxShadow: "0 2px 6px rgba(0,0,0,0.35)", cursor: "pointer", transition: "filter 0.15s" }}
                          onMouseEnter={e => e.currentTarget.style.filter = "brightness(1.2)"}
                          onMouseLeave={e => e.currentTarget.style.filter = "none"}>
                          <span style={{ fontSize: 13, color: "#fff", fontWeight: 700, paddingLeft: 6, whiteSpace: "nowrap", opacity: 0.95 }}>{cat}</span>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
