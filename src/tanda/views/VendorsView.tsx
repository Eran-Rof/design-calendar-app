import React from "react";
import { type XoroPO, type Milestone, type View } from "../../utils/tandaTypes";

export interface VendorsViewProps {
  pos: XoroPO[];
  archivedPos: XoroPO[];
  milestones: Record<string, Milestone[]>;
  setSearch: (v: string) => void;
  setView: (v: View) => void;
}

export function VendorsView({ pos, archivedPos, milestones, setSearch, setView }: VendorsViewProps) {
  // Include both active + archived POs for complete vendor performance history
  const allPOsForVendors = [...pos, ...archivedPos];
  const vendorStats: { vendor: string; totalMs: number; completed: number; onTime: number; late: number; avgDaysLate: number; poCount: number }[] = [];
  const vendorNames = [...new Set(allPOsForVendors.map(p => p.VendorName ?? "").filter(Boolean))].sort();
  vendorNames.forEach(vendor => {
    const vPOs = allPOsForVendors.filter(p => (p.VendorName ?? "") === vendor);
    const vMs = vPOs.flatMap(p => milestones[p.PoNumber ?? ""] || []).filter(m => m.status !== "N/A");
    const completed = vMs.filter(m => m.status === "Complete");
    let onTime = 0, late = 0, totalDaysLate = 0;
    completed.forEach(m => {
      const done = m.status_date || m.status_dates?.["Complete"];
      if (done && m.expected_date) {
        if (done <= m.expected_date) onTime++;
        else { late++; totalDaysLate += Math.ceil((new Date(done).getTime() - new Date(m.expected_date).getTime()) / 86400000); }
      } else { onTime++; }
    });
    if (vMs.length > 0) vendorStats.push({ vendor, totalMs: vMs.length, completed: completed.length, onTime, late, avgDaysLate: late > 0 ? Math.round(totalDaysLate / late) : 0, poCount: vPOs.length });
  });
  vendorStats.sort((a, b) => { const aPct = a.completed > 0 ? a.onTime / a.completed : 0; const bPct = b.completed > 0 ? b.onTime / b.completed : 0; return bPct - aPct; });

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2 style={{ margin: 0, color: "#F1F5F9", fontSize: 20, fontWeight: 700 }}>Vendor Scorecard</h2>
        <span style={{ color: "#6B7280", fontSize: 12 }}>{vendorStats.length} vendors</span>
      </div>
      <div style={{ background: "#1E293B", borderRadius: 12, border: "1px solid #334155", overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 80px 80px 80px 80px 90px 100px", gap: 8, padding: "12px 16px", background: "#0F172A", borderBottom: "1px solid #334155" }}>
          <span style={{ color: "#6B7280", fontSize: 11, fontWeight: 700, textTransform: "uppercase" }}>Vendor</span>
          <span style={{ color: "#6B7280", fontSize: 11, fontWeight: 700, textTransform: "uppercase", textAlign: "center" }}>POs</span>
          <span style={{ color: "#6B7280", fontSize: 11, fontWeight: 700, textTransform: "uppercase", textAlign: "center" }}>Milestones</span>
          <span style={{ color: "#6B7280", fontSize: 11, fontWeight: 700, textTransform: "uppercase", textAlign: "center" }}>On Time</span>
          <span style={{ color: "#6B7280", fontSize: 11, fontWeight: 700, textTransform: "uppercase", textAlign: "center" }}>Late</span>
          <span style={{ color: "#6B7280", fontSize: 11, fontWeight: 700, textTransform: "uppercase", textAlign: "center" }}>Avg Late</span>
          <span style={{ color: "#6B7280", fontSize: 11, fontWeight: 700, textTransform: "uppercase", textAlign: "center" }}>On-Time %</span>
        </div>
        {vendorStats.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: "#6B7280" }}>No milestone data yet</div>
        ) : vendorStats.map((v, i) => {
          const pct = v.completed > 0 ? Math.round((v.onTime / v.completed) * 100) : 0;
          const pctColor = pct >= 90 ? "#10B981" : pct >= 70 ? "#F59E0B" : "#EF4444";
          return (
            <div key={v.vendor} style={{ display: "grid", gridTemplateColumns: "1fr 80px 80px 80px 80px 90px 100px", gap: 8, padding: "12px 16px", borderBottom: "1px solid #0F172A", background: i % 2 === 0 ? "#1E293B" : "#1A2332", cursor: "pointer" }}
              onClick={() => { setSearch(v.vendor); setView("list"); }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#F1F5F9" }}>{v.vendor}</div>
              </div>
              <span style={{ textAlign: "center", color: "#94A3B8", fontSize: 14, fontFamily: "monospace" }}>{v.poCount}</span>
              <span style={{ textAlign: "center", color: "#94A3B8", fontSize: 14, fontFamily: "monospace" }}>{v.completed}/{v.totalMs}</span>
              <span style={{ textAlign: "center", color: "#10B981", fontSize: 14, fontWeight: 700, fontFamily: "monospace" }}>{v.onTime}</span>
              <span style={{ textAlign: "center", color: v.late > 0 ? "#EF4444" : "#6B7280", fontSize: 14, fontWeight: 700, fontFamily: "monospace" }}>{v.late}</span>
              <span style={{ textAlign: "center", color: v.avgDaysLate > 0 ? "#F59E0B" : "#6B7280", fontSize: 14, fontFamily: "monospace" }}>{v.avgDaysLate > 0 ? `${v.avgDaysLate}d` : "—"}</span>
              <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "center" }}>
                <div style={{ width: 50, height: 8, borderRadius: 4, background: "#0F172A", overflow: "hidden" }}>
                  <div style={{ width: `${pct}%`, height: "100%", background: pctColor, borderRadius: 4 }} />
                </div>
                <span style={{ color: pctColor, fontSize: 14, fontWeight: 800, fontFamily: "monospace" }}>{v.completed > 0 ? `${pct}%` : "—"}</span>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
