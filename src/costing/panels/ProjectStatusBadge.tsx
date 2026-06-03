// Costing Module — project status badge + transition menu.
//
// Extracted from PlanFlowWidget so it can live in the ProjectEditView header
// (top-left, where the old "← Projects" back-link was). Clicking opens a small
// menu of allowed status transitions. Persisting the change goes through
// updateProject, which the auto-advance effect treats as a manual override.

import React, { useState } from "react";
import { useCostingStore } from "../store/costingStore";
import { ALL_STATUSES, statusLabel, statusColor } from "../helpers";
import type { CostingStatus } from "../types";

const ALLOWED_TRANSITIONS: Record<CostingStatus, CostingStatus[]> = {
  draft:       ["in_progress", "cancelled"],
  in_progress: ["quoted", "draft", "cancelled"],
  quoted:      ["awarded", "in_progress", "cancelled"],
  awarded:     ["closed", "quoted", "cancelled"],
  closed:      ["awarded"],
  cancelled:   ["draft"],
};

export default function ProjectStatusBadge() {
  const project = useCostingStore((s) => s.project);
  const update  = useCostingStore((s) => s.updateProject);
  const [menuOpen, setMenuOpen] = useState(false);

  if (!project) return null;

  const onTransition = async (next: CostingStatus) => {
    setMenuOpen(false);
    try {
      await update(project.id, { status: next });
    } catch (e) {
      useCostingStore.getState().setNotice(`Status change failed: ${(e as Error).message}`);
    }
  };

  const transitions = ALLOWED_TRANSITIONS[project.status] || [];
  const projSc = statusColor(project.status);

  return (
    <div style={{ position: "relative" }}>
      <button
        onClick={() => setMenuOpen((m) => !m)}
        title="Change project status"
        style={{
          background: projSc.bg, color: projSc.fg,
          border: `1px solid ${projSc.border}`, borderRadius: 6,
          padding: "6px 12px", fontSize: 12, fontWeight: 700,
          cursor: "pointer", letterSpacing: ".04em",
          display: "flex", alignItems: "center", gap: 6,
        }}
      >
        {statusLabel(project.status)} <span style={{ fontSize: 10, opacity: 0.6 }}>▾</span>
      </button>

      {menuOpen && (
        <div style={{
          position: "absolute", top: 36, left: 0, zIndex: 30,
          background: "#0F172A", border: "1px solid #334155", borderRadius: 6,
          padding: 6, minWidth: 160, boxShadow: "0 10px 28px rgba(0,0,0,0.4)",
        }}>
          <div style={{ fontSize: 10, color: "#94A3B8", padding: "4px 8px", letterSpacing: ".08em", textTransform: "uppercase" }}>Transition to</div>
          {transitions.length === 0 ? (
            <div style={{ fontSize: 12, color: "#64748B", padding: "6px 8px" }}>No transitions available.</div>
          ) : transitions.map((t) => {
            const sc = statusColor(t);
            return (
              <button
                key={t}
                onClick={() => onTransition(t)}
                style={{
                  display: "block", width: "100%", textAlign: "left",
                  background: "transparent", color: "#E2E8F0", border: "none",
                  padding: "6px 8px", fontSize: 12, cursor: "pointer", borderRadius: 4,
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "#334155")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <span style={{ display: "inline-block", width: 8, height: 8, background: sc.fg, borderRadius: 2, marginRight: 8 }} />
                {ALL_STATUSES.includes(t) ? statusLabel(t) : t}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
