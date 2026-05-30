// Costing Module — Plan Flow widget.
//
// 5-stage strip mounted at the top of ProjectEditView. Stages: Draft →
// In Progress → Quoted → Awarded → Closed. Each stage shows count + $ rollup
// from the per-line stage derivation in usePlanFlow. Clicking a stage chip
// filters the grid below by calling onStageFilterChange. The project-level
// status badge on the left edge opens a small status-change menu (allowed
// transitions only).

import React, { useState } from "react";
import { useCostingStore } from "../store/costingStore";
import { usePlanFlow, PLAN_FLOW_STAGES, stageLabel, stageIcon, stageColor, type PlanFlowStage } from "../hooks/usePlanFlow";
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

const $fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export default function PlanFlowWidget() {
  const project = useCostingStore((s) => s.project);
  const update  = useCostingStore((s) => s.updateProject);
  const stageFilter = useCostingStore((s) => s.stageFilter) as PlanFlowStage | null;
  const setStageFilter = useCostingStore((s) => s.setStageFilter);
  const flow    = usePlanFlow();
  const [menuOpen, setMenuOpen] = useState(false);

  if (!project) return null;

  const activeStageFilter = stageFilter;
  const onChip = (stage: PlanFlowStage) => {
    setStageFilter(activeStageFilter === stage ? null : stage);
  };
  const onStageFilterChange = (s: PlanFlowStage | null) => setStageFilter(s);

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
    <div style={{
      background: "#1E293B", border: "1px solid #334155", borderRadius: 8,
      padding: "12px 16px", marginBottom: 16, position: "relative",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {/* Project status badge (left edge) — click to open transition menu */}
        <button
          onClick={() => setMenuOpen((m) => !m)}
          title="Change project status"
          style={{
            background: projSc.bg, color: projSc.fg,
            border: "none", borderRadius: 6,
            padding: "8px 14px", fontSize: 12, fontWeight: 700,
            cursor: "pointer", letterSpacing: ".04em",
            display: "flex", alignItems: "center", gap: 6,
          }}
        >
          {statusLabel(project.status)} <span style={{ fontSize: 10, opacity: 0.6 }}>▾</span>
        </button>

        {menuOpen && (
          <div style={{
            position: "absolute", top: 50, left: 14, zIndex: 30,
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
                  <span style={{ display: "inline-block", width: 8, height: 8, background: sc.bar || sc.fg, borderRadius: 2, marginRight: 8 }} />
                  {ALL_STATUSES.includes(t) ? statusLabel(t) : t}
                </button>
              );
            })}
            {ALL_STATUSES.length === 0 && null /* keep import alive in case future stages added */}
          </div>
        )}

        {/* Stage strip */}
        <div style={{ display: "flex", flex: 1, gap: 6, marginLeft: 8 }}>
          {PLAN_FLOW_STAGES.map((stage, idx) => {
            const b = flow.buckets[stage];
            const sc = stageColor(stage);
            const isActive = activeStageFilter === stage;
            const isLast = idx === PLAN_FLOW_STAGES.length - 1;
            return (
              <React.Fragment key={stage}>
                <button
                  onClick={() => onChip(stage)}
                  title={`Filter grid to ${stageLabel(stage)} lines`}
                  style={{
                    flex: 1,
                    background: isActive ? sc.bar : sc.bg,
                    color:      isActive ? "#fff"  : sc.fg,
                    border: `1px solid ${sc.bar}`,
                    borderRadius: 6, padding: "8px 10px",
                    cursor: "pointer", textAlign: "left",
                    display: "flex", flexDirection: "column", gap: 2,
                    transition: "all 0.15s",
                    opacity: b.count === 0 && !isActive ? 0.5 : 1,
                  }}
                >
                  <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase", display: "flex", alignItems: "center", gap: 4 }}>
                    <span style={{ fontSize: 13 }}>{stageIcon(stage)}</span>
                    {stageLabel(stage)}
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 2 }}>
                    <span style={{ fontSize: 18, fontWeight: 700 }}>{b.count}</span>
                    <span style={{ fontSize: 11, opacity: 0.75 }}>{$fmt.format(b.totalCost)}</span>
                  </div>
                </button>
                {!isLast && (
                  <div style={{ alignSelf: "center", color: "#475569", fontSize: 14 }}>→</div>
                )}
              </React.Fragment>
            );
          })}
        </div>

        {activeStageFilter && (
          <button
            onClick={() => onStageFilterChange(null)}
            style={{
              background: "transparent", color: "#94A3B8",
              border: "1px solid #334155", borderRadius: 4,
              padding: "5px 10px", fontSize: 11, cursor: "pointer",
            }}
            title="Clear stage filter"
          >
            Clear filter
          </button>
        )}
      </div>
    </div>
  );
}
