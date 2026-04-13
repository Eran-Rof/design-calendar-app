import React from "react";
import { useTandaStore } from "../store/index";
import { useDashboardData } from "../hooks/useDashboardData";
import {
  type XoroPO,
  type Milestone,
  type View,
  STATUS_OPTIONS,
  STATUS_COLORS,
  WIP_CATEGORIES,
  fmtDate,
  fmtCurrency,
} from "../../utils/tandaTypes";
import S from "../styles";
import { StatCard } from "../components/StatCard";
import { PORow } from "../components/PORow";

// ── Types ──────────────────────────────────────────────────────────────────────

interface DashboardViewProps {
  pos: XoroPO[];
  filtered: XoroPO[];
  search: string;
  setSearch: (v: string) => void;
  milestones: Record<string, Milestone[]>;
  loading: boolean;
  syncing: boolean;
  lastSync: string;
  setView: (v: View) => void;
  setFilterStatus: (v: string) => void;
  setDetailMode: (v: "header" | "po" | "milestones" | "notes" | "history" | "matrix" | "email" | "attachments" | "all") => void;
  setNewNote: (v: string) => void;
  setSelected: (v: XoroPO | null) => void;
  setShowSyncModal: (v: boolean) => void;
  loadVendors: () => void;
  openCategoryWithCheck: (poNum: string, cat: string, po?: XoroPO | null, switchView?: boolean) => void;
}

// ── Component ──────────────────────────────────────────────────────────────────

export function DashboardView({
  pos,
  filtered,
  search,
  setSearch,
  milestones,
  loading,
  syncing,
  lastSync,
  setView,
  setFilterStatus,
  setDetailMode,
  setNewNote,
  setSelected,
  setShowSyncModal,
  loadVendors,
  openCategoryWithCheck,
}: DashboardViewProps) {
  const {
    dashPOs, dashPoNums,
    dashMs, dashOverdueMilestones, dashDueThisWeekMilestones,
    dashUpcomingMilestones, dashMilestoneCompletionRate,
    dashTotalValue, dashOverduePOs, dashDueThisWeekPOs,
    cascadeAlerts,
  } = useDashboardData({ pos, filtered, search, milestones });

  const today = new Date().toISOString().slice(0, 10);
  const weekFromNow = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

  return (
    <>
      {/* Search bar -- top of dashboard, same as All POs */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input
          style={{ ...S.input, flex: 1, marginBottom: 0 }}
          placeholder="🔍 Search PO#, vendor, brand, style #…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        {search && (
          <button style={S.btnSecondary} onClick={() => setSearch("")}>✕ Clear</button>
        )}
      </div>

      {/* Row 1: Production Health Score + Key Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "280px 1fr", gap: 16, marginBottom: 16 }}>
        {/* Health Score Ring */}
        {(() => {
          const active = dashMs.filter(m => m.status !== "N/A").length;
          const complete = dashMs.filter(m => m.status === "Complete").length;
          const delayed = dashMs.filter(m => m.status === "Delayed").length;
          const onTimePct = active > 0 ? Math.round(((complete) / active) * 100) : 0;
          const delayPenalty = active > 0 ? Math.round((delayed / active) * 50) : 0;
          const healthScore = Math.max(0, Math.min(100, onTimePct - delayPenalty));
          const healthColor = healthScore >= 80 ? "#10B981" : healthScore >= 60 ? "#F59E0B" : "#EF4444";
          const circumference = 2 * Math.PI * 54;
          const strokeDash = (healthScore / 100) * circumference;
          return (
            <div style={{ background: "#1E293B", borderRadius: 12, padding: 20, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", cursor: "pointer", transition: "transform 0.15s" }}
              onClick={() => setView("timeline")}
              onMouseEnter={e => e.currentTarget.style.transform = "translateY(-2px)"}
              onMouseLeave={e => e.currentTarget.style.transform = "none"}>
              <div style={{ position: "relative", width: 130, height: 130, marginBottom: 12 }}>
                <svg width="130" height="130" viewBox="0 0 130 130">
                  <circle cx="65" cy="65" r="54" fill="none" stroke="#0F172A" strokeWidth="12" />
                  <circle cx="65" cy="65" r="54" fill="none" stroke={healthColor} strokeWidth="12" strokeLinecap="round"
                    strokeDasharray={`${strokeDash} ${circumference}`} transform="rotate(-90 65 65)" style={{ transition: "stroke-dasharray 0.5s" }} />
                </svg>
                <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                  <span style={{ fontSize: 32, fontWeight: 800, color: healthColor, fontFamily: "monospace" }}>{healthScore}</span>
                  <span style={{ fontSize: 10, color: "#6B7280", textTransform: "uppercase", letterSpacing: 1 }}>Health</span>
                </div>
              </div>
              <span style={{ fontSize: 12, color: "#94A3B8", fontWeight: 600 }}>Production Health Score</span>
              <span style={{ fontSize: 10, color: "#6B7280", marginTop: 2 }}>{complete}/{active} complete · {delayed} delayed</span>
            </div>
          );
        })()}

        {/* Key Stats Grid */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
          <StatCard label="Total POs" value={dashPOs.length} color="#3B82F6" icon="📋" onClick={() => setView("list")} />
          <StatCard label="Total Value" value={fmtCurrency(dashTotalValue)} color="#10B981" icon="💰" onClick={() => setView("list")} />
          <StatCard label="Overdue POs" value={dashOverduePOs} color="#EF4444" icon="⚠️" onClick={() => { setFilterStatus("All"); setView("list"); }} />
          <StatCard label="Due This Week" value={dashDueThisWeekPOs} color="#F59E0B" icon="📅" onClick={() => setView("list")} />
          <StatCard label="Overdue Milestones" value={dashOverdueMilestones.length} color="#EF4444" icon="🚨" onClick={() => setView("timeline")} />
          <StatCard label="Due This Week" value={dashDueThisWeekMilestones.length} color="#F59E0B" icon="📌" onClick={() => setView("timeline")} />
          <StatCard label="Completion Rate" value={`${dashMilestoneCompletionRate}%`} color="#10B981" icon="📊" onClick={() => setView("vendors")} />
          <StatCard label="Cascade Alerts" value={cascadeAlerts.filter(a => dashPoNums.has(a.poNum)).length} color="#F59E0B" icon="⚡" onClick={() => setView("timeline")} />
        </div>
      </div>

      {/* Row 2: Milestone Pipeline + Status Breakdown */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
        {/* Milestone Pipeline */}
        <div style={{ ...S.card, cursor: "pointer" }} onClick={() => setView("timeline")}>
          <h3 style={S.cardTitle}>Milestone Pipeline</h3>
          {(() => {
            const active = dashMs.filter(m => m.status !== "N/A").length;
            const statuses = [
              { label: "Not Started", count: dashMs.filter(m => m.status === "Not Started").length, color: "#6B7280", gradLight: "#6B7280", gradDark: "#1F2937" },
              { label: "In Progress", count: dashMs.filter(m => m.status === "In Progress").length, color: "#3B82F6", gradLight: "#93C5FD", gradDark: "#1D4ED8" },
              { label: "Delayed", count: dashMs.filter(m => m.status === "Delayed").length, color: "#EF4444", gradLight: "#FCA5A5", gradDark: "#7F1D1D" },
              { label: "Complete", count: dashMs.filter(m => m.status === "Complete").length, color: "#10B981", gradLight: "#6EE7B7", gradDark: "#047857" },
            ];
            return (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {statuses.map(s => {
                  const pct = active > 0 ? Math.round((s.count / active) * 100) : 0;
                  return (
                    <div key={s.label} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ width: 85, fontSize: 12, color: s.color, fontWeight: 600, textAlign: "right", flexShrink: 0 }}>{s.label}</span>
                      <div style={{ flex: 1, height: 14, borderRadius: 7, background: "#0F172A", overflow: "hidden" }}>
                        <div style={{ width: `${pct}%`, height: "100%", background: `linear-gradient(90deg, ${s.gradLight}, ${s.gradDark})`, borderRadius: 7, transition: "width 0.3s", minWidth: s.count > 0 ? 6 : 0 }} />
                      </div>
                      <span style={{ width: 60, fontSize: 12, color: "#94A3B8", fontFamily: "monospace", flexShrink: 0 }}>{s.count} ({pct}%)</span>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>

        {/* Category Progress */}
        <div style={{ ...S.card, cursor: "pointer" }} onClick={() => setView("timeline")}>
          <h3 style={S.cardTitle}>Progress by Category</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {WIP_CATEGORIES.map(cat => {
              const catMs = dashMs.filter(m => m.category === cat && m.status !== "N/A");
              const catDone = catMs.filter(m => m.status === "Complete").length;
              const catDelayed = catMs.filter(m => m.status === "Delayed").length;
              const pct = catMs.length > 0 ? Math.round((catDone / catMs.length) * 100) : 0;
              const color = pct === 100 ? "#10B981" : catDelayed > 0 ? "#EF4444" : pct > 0 ? "#3B82F6" : "#6B7280";
              return (
                <div key={cat} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ width: 100, fontSize: 12, color: "#D1D5DB", fontWeight: 600, flexShrink: 0 }}>{cat}</span>
                  <div style={{ flex: 1, height: 12, borderRadius: 6, background: "#0F172A", overflow: "hidden" }}>
                    <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 6, transition: "width 0.3s" }} />
                  </div>
                  <span style={{ width: 70, fontSize: 11, color: "#94A3B8", fontFamily: "monospace", flexShrink: 0, textAlign: "right" }}>{catDone}/{catMs.length}</span>
                  {catDelayed > 0 && <span style={{ fontSize: 10, color: "#EF4444", fontWeight: 600, flexShrink: 0 }}>⚠{catDelayed}</span>}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Row 3: PO Status + Top Vendors */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
        {/* PO Status */}
        <div style={S.card}>
          <h3 style={S.cardTitle}>POs by Status</h3>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {STATUS_OPTIONS.map(s => {
              const count = dashPOs.filter((p: XoroPO) => p.StatusName === s).length;
              if (!count) return null;
              const color = STATUS_COLORS[s] ?? "#6B7280";
              return (
                <div key={s} style={{ ...S.statusChip, background: color + "22", border: `1px solid ${color}44`, cursor: "pointer" }}
                  onClick={() => { setFilterStatus(s); setView("list"); }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: color }} />
                  <span style={{ color, fontWeight: 600 }}>{count}</span>
                  <span style={{ color: "#9CA3AF" }}>{s}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Top Vendors */}
        <div style={S.card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <h3 style={{ ...S.cardTitle, margin: 0 }}>Top Vendors</h3>
            <button style={{ ...S.btnSecondary, fontSize: 10, padding: "4px 10px" }} onClick={() => setView("vendors")}>View All →</button>
          </div>
          {(() => {
            const vendorNames = [...new Set(dashPOs.map((p: XoroPO) => p.VendorName ?? "").filter(Boolean))];
            const vendorData = vendorNames.map(v => {
              const vPOs = dashPOs.filter((p: XoroPO) => (p.VendorName ?? "") === v);
              const vMs = vPOs.flatMap(p => milestones[p.PoNumber ?? ""] || []).filter(m => m.status !== "N/A");
              const done = vMs.filter(m => m.status === "Complete");
              let onTime = 0;
              done.forEach(m => { const d = m.status_date || m.status_dates?.["Complete"]; if (d && m.expected_date && d <= m.expected_date) onTime++; else onTime++; });
              const pct = done.length > 0 ? Math.round((onTime / done.length) * 100) : 0;
              return { vendor: v, poCount: vPOs.length, msTotal: vMs.length, done: done.length, pct };
            }).filter(v => v.msTotal > 0).sort((a, b) => b.pct - a.pct).slice(0, 5);
            return vendorData.length === 0 ? (
              <div style={{ color: "#6B7280", fontSize: 13, textAlign: "center", padding: 16 }}>No milestone data yet</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {vendorData.map(v => {
                  const pctColor = v.pct >= 90 ? "#10B981" : v.pct >= 70 ? "#F59E0B" : "#EF4444";
                  return (
                    <div key={v.vendor} style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }} onClick={() => { setSearch(v.vendor); setView("list"); }}>
                      <span style={{ flex: 1, fontSize: 13, color: "#D1D5DB", fontWeight: 600 }}>{v.vendor}</span>
                      <span style={{ fontSize: 11, color: "#6B7280" }}>{v.poCount} POs</span>
                      <div style={{ width: 50, height: 6, borderRadius: 3, background: "#0F172A", overflow: "hidden" }}>
                        <div style={{ width: `${v.pct}%`, height: "100%", background: pctColor, borderRadius: 3 }} />
                      </div>
                      <span style={{ fontSize: 12, fontWeight: 700, color: pctColor, fontFamily: "monospace", width: 36, textAlign: "right" }}>{v.pct}%</span>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>
      </div>

      {/* Row 4: Cascade Alerts (if any) */}
      {cascadeAlerts.filter(a => dashPoNums.has(a.poNum)).length > 0 && (
        <div style={{ ...S.card, marginBottom: 16, borderLeft: "3px solid #F59E0B" }}>
          <h3 style={{ ...S.cardTitle, color: "#F59E0B" }}>⚠ Cascade Alerts — {cascadeAlerts.length} Blocked</h3>
          <div style={{ fontSize: 12 }}>
            <div style={{ display: "grid", gridTemplateColumns: "110px 1fr 120px 120px 70px", padding: "8px 12px", background: "#0F172A", borderRadius: "8px 8px 0 0", gap: 8 }}>
              <span style={{ color: "#6B7280", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5 }}>PO #</span>
              <span style={{ color: "#6B7280", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5 }}>Vendor</span>
              <span style={{ color: "#6B7280", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5 }}>Blocked</span>
              <span style={{ color: "#6B7280", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5 }}>Delayed By</span>
              <span style={{ color: "#6B7280", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, textAlign: "right" }}>Days Late</span>
            </div>
            {cascadeAlerts.filter(a => dashPoNums.has(a.poNum)).sort((a, b) => b.daysLate - a.daysLate).slice(0, 10).map((a, i) => (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "110px 1fr 120px 120px 70px", padding: "8px 12px", borderTop: "1px solid #1E293B", gap: 8, cursor: "pointer", background: "#0F172A" }}
                onClick={() => { const p = pos.find(x => x.PoNumber === a.poNum); if (p) openCategoryWithCheck(a.poNum, a.blockedCat, p); }}>
                <span style={{ color: "#60A5FA", fontFamily: "monospace", fontSize: 11 }}>{a.poNum}</span>
                <span style={{ color: "#D1D5DB" }}>{a.vendor}</span>
                <span style={{ color: "#F59E0B", fontWeight: 600 }}>{a.blockedCat}</span>
                <span style={{ color: "#EF4444" }}>{a.delayedCat}</span>
                <span style={{ color: "#EF4444", fontWeight: 700, textAlign: "right" }}>{a.daysLate}d</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Row 5: Upcoming + Overdue side by side */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
        {/* Upcoming */}
        <div style={S.card}>
          <h3 style={S.cardTitle}>Upcoming Milestones</h3>
          {dashUpcomingMilestones.length === 0 ? (
            <div style={{ color: "#6B7280", fontSize: 13, textAlign: "center", padding: 16 }}>No upcoming milestones</div>
          ) : (
            <div style={{ fontSize: 12 }}>
              <div style={{ display: "grid", gridTemplateColumns: "100px 1fr 80px 60px", padding: "6px 10px", color: "#6B7280", fontWeight: 600, borderBottom: "1px solid #334155", textTransform: "uppercase", letterSpacing: 1, fontSize: 9 }}>
                <span>PO #</span><span>Phase</span><span>Due</span><span style={{ textAlign: "right" }}>Days</span>
              </div>
              {dashUpcomingMilestones.slice(0, 10).map(m => {
                const daysRem = m.expected_date ? Math.ceil((new Date(m.expected_date).getTime() - Date.now()) / 86400000) : null;
                return (
                  <div key={m.id} style={{ display: "grid", gridTemplateColumns: "100px 1fr 80px 60px", padding: "6px 10px", borderBottom: "1px solid #1E293B", cursor: "pointer", alignItems: "center" }}
                    onClick={() => { const p = pos.find(x => x.PoNumber === m.po_number); if (p) { setDetailMode("milestones"); setNewNote(""); setSearch(""); setSelected(p); } }}>
                    <span style={{ color: "#60A5FA", fontFamily: "monospace", fontSize: 10 }}>{m.po_number}</span>
                    <span style={{ color: "#D1D5DB", fontSize: 11 }}>{m.phase}</span>
                    <span style={{ color: "#9CA3AF", fontSize: 10 }}>{fmtDate(m.expected_date ?? undefined)}</span>
                    <span style={{ color: daysRem !== null && daysRem <= 3 ? "#F59E0B" : "#10B981", fontWeight: 600, textAlign: "right", fontSize: 11 }}>{daysRem !== null ? `${daysRem}d` : "—"}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Overdue */}
        <div style={{ ...S.card, borderLeft: dashOverdueMilestones.length > 0 ? "3px solid #EF4444" : undefined }}>
          <h3 style={{ ...S.cardTitle, color: dashOverdueMilestones.length > 0 ? "#EF4444" : undefined }}>Overdue Milestones ({dashOverdueMilestones.length})</h3>
          {dashOverdueMilestones.length === 0 ? (
            <div style={{ color: "#10B981", fontSize: 13, textAlign: "center", padding: 16 }}>✓ No overdue milestones</div>
          ) : (
            <div style={{ fontSize: 12 }}>
              <div style={{ display: "grid", gridTemplateColumns: "100px 1fr 80px 60px", padding: "6px 10px", color: "#6B7280", fontWeight: 600, borderBottom: "1px solid #334155", textTransform: "uppercase", letterSpacing: 1, fontSize: 9 }}>
                <span>PO #</span><span>Phase</span><span>Due</span><span style={{ textAlign: "right" }}>Late</span>
              </div>
              {dashOverdueMilestones.sort((a, b) => (a.expected_date ?? "").localeCompare(b.expected_date ?? "")).slice(0, 10).map(m => {
                const daysLate = m.expected_date ? Math.abs(Math.ceil((new Date(m.expected_date).getTime() - Date.now()) / 86400000)) : 0;
                return (
                  <div key={m.id} style={{ display: "grid", gridTemplateColumns: "100px 1fr 80px 60px", padding: "6px 10px", borderBottom: "1px solid #1E293B", cursor: "pointer", alignItems: "center" }}
                    onClick={() => { const p = pos.find(x => x.PoNumber === m.po_number); if (p) { setDetailMode("milestones"); setNewNote(""); setSearch(""); setSelected(p); } }}>
                    <span style={{ color: "#60A5FA", fontFamily: "monospace", fontSize: 10 }}>{m.po_number}</span>
                    <span style={{ color: "#D1D5DB", fontSize: 11 }}>{m.phase}</span>
                    <span style={{ color: "#9CA3AF", fontSize: 10 }}>{fmtDate(m.expected_date ?? undefined)}</span>
                    <span style={{ color: "#EF4444", fontWeight: 700, textAlign: "right", fontSize: 11 }}>{daysLate}d</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Row 6: Recent POs / Search Results */}
      <div style={S.card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h3 style={{ ...S.cardTitle, marginBottom: 0 }}>
            {search ? `Search Results (${filtered.length})` : "Recent Purchase Orders"}
          </h3>
          {!search && (
            <button style={S.btnSecondary} onClick={() => setView("list")}>View All →</button>
          )}
        </div>
        {loading && <p style={{ color: "#6B7280" }}>Loading…</p>}
        {!loading && pos.length === 0 && (
          <div style={S.emptyState}>
            <p>No purchase orders loaded.</p>
            <button style={S.btnPrimary} onClick={() => { setShowSyncModal(true); loadVendors(); }} disabled={syncing}>
              {syncing ? "Syncing…" : "🔄 Sync from Xoro"}
            </button>
          </div>
        )}
        {search ? (
          filtered.length === 0
            ? <p style={{ color: "#6B7280", fontSize: 13 }}>No POs match "{search}"</p>
            : filtered.map((po, i) => <PORow key={i} po={po} milestones={milestones[po.PoNumber ?? ""] || []} today={today} weekFromNow={weekFromNow} onClick={() => { setDetailMode("milestones"); setNewNote(""); setSelected(po); }} detailed />)
        ) : (
          pos.slice(0, 8).map((po, i) => <PORow key={i} po={po} milestones={milestones[po.PoNumber ?? ""] || []} today={today} weekFromNow={weekFromNow} onClick={() => { setDetailMode("milestones"); setNewNote(""); setSelected(po); }} />)
        )}
      </div>
    </>
  );
}
