import React from "react";
import { type Milestone, MILESTONE_STATUSES, MILESTONE_STATUS_COLORS } from "../../utils/tandaTypes";
import { MilestoneDateInput } from "./MilestoneDateInput";
import type { DetailPanelCtx } from "../detailPanel";

/**
 * Flat spreadsheet view of every milestone for the selected PO. Designed for
 * quick bulk entry — no category collapsing, all phases visible at once,
 * inline-editable due date / status / status date / notes count.
 */
export function MilestoneGridTab({ ctx }: { ctx: DetailPanelCtx }): React.ReactElement | null {
  const { selected, detailMode, milestones, user, saveMilestone, ensureMilestones, vendorHasTemplate } = ctx;

  if (!selected) return null;
  if (!(detailMode === "grid" || detailMode === "all")) return null;

  const poNum = selected.PoNumber ?? "";
  const ddp = selected.DateExpectedDelivery;
  const vendorN = selected.VendorName ?? "";
  const hasVendorTpl = vendorHasTemplate(vendorN);
  const poMs = (milestones[poNum] || []).slice().sort((a, b) => {
    if (a.expected_date && b.expected_date) {
      const d = a.expected_date.localeCompare(b.expected_date);
      if (d !== 0) return d;
    }
    if (a.expected_date && !b.expected_date) return -1;
    if (!a.expected_date && b.expected_date) return 1;
    return a.sort_order - b.sort_order;
  });

  if (poMs.length === 0) {
    return (
      <div style={{ padding: 24, color: "#6B7280", fontSize: 13, textAlign: "center" }}>
        {!ddp
          ? "No expected delivery date — cannot generate milestones."
          : !hasVendorTpl
            ? "No template configured for this vendor yet."
            : (
              <>
                <p style={{ marginBottom: 12 }}>No milestones yet.</p>
                <button onClick={() => ensureMilestones(selected)} style={{ padding: "6px 14px", borderRadius: 6, border: "none", background: "#3B82F6", color: "#fff", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                  Generate Milestones
                </button>
              </>
            )}
      </div>
    );
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const colTpl = "1.2fr 1fr 130px 130px 130px 70px 60px";

  const updateField = (m: Milestone, patch: Partial<Milestone>) => {
    saveMilestone({ ...m, ...patch, updated_at: new Date().toISOString(), updated_by: user?.name || "" });
  };

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ background: "#0F172A", borderRadius: 8, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: colTpl, gap: 6, padding: "8px 14px", background: "#1E293B", color: "#6B7280", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 600 }}>
          <span>Phase</span>
          <span>Category</span>
          <span style={{ textAlign: "center" }}>Due Date</span>
          <span style={{ textAlign: "center" }}>Status</span>
          <span style={{ textAlign: "center" }}>Status Date</span>
          <span style={{ textAlign: "right" }}>Days</span>
          <span style={{ textAlign: "center" }}>Notes</span>
        </div>
        {poMs.map(m => {
          const daysRem = m.expected_date ? Math.ceil((new Date(m.expected_date + "T00:00:00").getTime() - today.getTime()) / 86400000) : null;
          const daysColor =
            m.status === "Complete" ? "#10B981"
            : m.status === "N/A" ? "#6B7280"
            : daysRem === null ? "#6B7280"
            : daysRem < 0 ? "#EF4444"
            : daysRem <= 7 ? "#F59E0B"
            : "#10B981";
          const statusDateVal = (m.status_dates || {})[m.status] || m.status_date || "";
          const noteCount = m.note_entries?.length || (m.notes ? 1 : 0);
          return (
            <div key={m.id} style={{ display: "grid", gridTemplateColumns: colTpl, gap: 6, padding: "8px 14px", borderTop: "1px solid #1E293B", alignItems: "center" }}>
              <span style={{ color: "#D1D5DB", fontSize: 13, fontWeight: 600 }}>{m.phase}</span>
              <span style={{ color: "#9CA3AF", fontSize: 12 }}>{m.category}</span>
              <MilestoneDateInput
                value={m.expected_date || ""}
                onCommit={v => updateField(m, { expected_date: v || null })}
                style={{ background: "#1E293B", border: "1px solid #334155", borderRadius: 6, color: "#9CA3AF", fontSize: 12, padding: "4px 6px", width: "100%", boxSizing: "border-box", outline: "none" }}
              />
              <select
                value={m.status}
                onChange={e => {
                  const newStatus = e.target.value;
                  const dates = { ...(m.status_dates || {}) };
                  const today2 = new Date().toISOString().split("T")[0];
                  if (newStatus !== "Not Started" && !dates[newStatus]) dates[newStatus] = today2;
                  updateField(m, { status: newStatus, status_date: dates[newStatus] || null, status_dates: Object.keys(dates).length > 0 ? dates : null });
                }}
                style={{ background: "#1E293B", border: "1px solid #334155", borderRadius: 6, color: MILESTONE_STATUS_COLORS[m.status] || "#6B7280", fontSize: 12, padding: "5px 6px", width: "100%", boxSizing: "border-box", fontWeight: 600 }}
              >
                {MILESTONE_STATUSES.map(s => <option key={s} value={s} style={{ color: MILESTONE_STATUS_COLORS[s] }}>{s}</option>)}
              </select>
              <input
                type="date"
                value={statusDateVal}
                onChange={e => {
                  const val = e.target.value || null;
                  const dates = { ...(m.status_dates || {}) };
                  if (val) dates[m.status] = val; else delete dates[m.status];
                  updateField(m, { status_date: val, status_dates: Object.keys(dates).length > 0 ? dates : null });
                }}
                style={{ background: "#1E293B", border: "1px solid #334155", borderRadius: 6, color: statusDateVal ? "#60A5FA" : "#334155", fontSize: 12, padding: "5px 6px", width: "100%", boxSizing: "border-box" }}
              />
              <span style={{ color: daysColor, fontWeight: 700, textAlign: "right", fontSize: 12 }}>
                {m.status === "Complete" ? "Done" : m.status === "N/A" ? "—" : daysRem === null ? "—" : daysRem < 0 ? `${Math.abs(daysRem)}d late` : daysRem === 0 ? "Today" : `${daysRem}d`}
              </span>
              <span style={{ textAlign: "center", color: noteCount > 0 ? "#60A5FA" : "#4B5563", fontSize: 12, fontWeight: 600 }} title={m.notes || "No notes"}>
                📝 {noteCount > 0 ? noteCount : ""}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
