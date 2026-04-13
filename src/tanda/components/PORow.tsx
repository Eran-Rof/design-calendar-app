import React from "react";
import S from "../styles";
import { type XoroPO, type Milestone, STATUS_COLORS, poTotal, fmtDate, fmtCurrency } from "../../utils/tandaTypes";

function daysUntil(d?: string) {
  if (!d) return null;
  const target = new Date(d + "T00:00:00");
  return Math.ceil((target.getTime() - Date.now()) / 86400000);
}

interface PORowProps {
  po: XoroPO;
  onClick: () => void;
  detailed?: boolean;
  milestones: Milestone[];
  today: string;
  weekFromNow: string;
}

export const PORow: React.FC<PORowProps> = ({ po, onClick, detailed, milestones: poMs, today, weekFromNow }) => {
  const color = STATUS_COLORS[po.StatusName ?? ""] ?? "#6B7280";
  const days = daysUntil(po.DateExpectedDelivery);
  const total = poTotal(po);
  const items = po.Items ?? po.PoLineArr ?? [];
  const msComplete = poMs.filter(m => m.status === "Complete").length;
  const msActive = poMs.filter(m => m.status !== "N/A").length;
  const msInProg = poMs.filter(m => m.status === "In Progress").length;
  const msDelayed = poMs.filter(m => m.status === "Delayed").length;
  const msNotStarted = msActive - msComplete - msInProg - msDelayed;
  const msOverdue = poMs.some(m => m.expected_date && m.expected_date < today && m.status !== "Complete" && m.status !== "N/A");
  const msApproaching = poMs.some(m => m.expected_date && m.expected_date >= today && m.expected_date <= weekFromNow && m.status !== "Complete" && m.status !== "N/A");
  const msDotColor = msActive === 0 ? "#6B7280" : msOverdue ? "#EF4444" : msApproaching ? "#F59E0B" : "#10B981";
  const msPercent = msActive > 0 ? Math.round((msComplete / msActive) * 100) : 0;
  const statusBars = [
    [msComplete, "#047857", "#6EE7B7"],
    [msInProg, "#1D4ED8", "#93C5FD"],
    [msDelayed, "#7F1D1D", "#FCA5A5"],
    [msNotStarted, "#374151", "#9CA3AF"],
  ].filter(([c]) => (c as number) > 0) as [number, string, string][];

  return (
    <div style={{ ...S.poRow, borderLeft: `3px solid ${color}` }} onClick={onClick}>
      <div style={{ flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
          <span style={S.poNumber}>{po.PoNumber ?? "—"}</span>
          <span style={{ ...S.badge, background: color + "22", color, border: `1px solid ${color}44` }}>
            {po.StatusName ?? "Unknown"}
          </span>
          {days !== null && days < 0 && <span style={{ ...S.badge, background: "#EF444422", color: "#EF4444", border: "1px solid #EF444444" }}>Overdue</span>}
          {days !== null && days >= 0 && days <= 7 && <span style={{ ...S.badge, background: "#F59E0B22", color: "#F59E0B", border: "1px solid #F59E0B44" }}>Due Soon</span>}
        </div>
        <div style={{ color: "#D1D5DB", fontWeight: 600 }}>{po.VendorName ?? "Unknown Vendor"}</div>
        {detailed && po.Memo && <div style={{ color: "#6B7280", fontSize: 12, marginTop: 2 }}>{po.Memo}</div>}
      </div>
      {msActive > 0 && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3, minWidth: 110 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ color: "#9CA3AF", fontSize: 11, fontFamily: "monospace" }}>{msComplete}/{msActive}</span>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: msDotColor }} />
            <span style={{ color: "#10B981", fontSize: 12, fontWeight: 700, fontFamily: "monospace" }}>{msPercent}%</span>
          </div>
          {statusBars.map(([count, dark, light], i) => {
            const sPct = msActive > 0 ? Math.round(((count as number) / msActive) * 100) : 0;
            return (
              <div key={i} style={{ width: 110, height: 6, borderRadius: 3, background: "#0F172A", overflow: "hidden" }}>
                <div style={{ width: `${sPct}%`, height: "100%", background: `linear-gradient(90deg, ${light}, ${dark})`, borderRadius: 3, minWidth: (count as number) > 0 ? 3 : 0 }} />
              </div>
            );
          })}
        </div>
      )}
      <div style={{ textAlign: "right", minWidth: 160 }}>
        <div style={{ color: "#10B981", fontWeight: 700, fontSize: 16 }}>{fmtCurrency(total, (po as any).CurrencyCode)}</div>
        {detailed && <div style={{ color: "#6B7280", fontSize: 12 }}>{items.length} line items</div>}
        {detailed && <div style={{ color: "#9CA3AF", fontSize: 12, marginTop: 4 }}>
          Created: <span style={{ color: "#94A3B8" }}>{fmtDate(po.DateOrder) || "—"}</span>
        </div>}
        <div style={{ color: "#9CA3AF", fontSize: 12, marginTop: 2 }}>
          DDP Date: <span style={{ color: "#60A5FA" }}>{fmtDate(po.DateExpectedDelivery) || "—"}</span>
        </div>
      </div>
    </div>
  );
};
