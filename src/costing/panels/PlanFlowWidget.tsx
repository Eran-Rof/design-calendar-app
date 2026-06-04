// Costing Module — Plan Flow widget.
//
// Compact 5-stage strip below the Details header in ProjectEditView. Stages:
// Draft → In Progress → Quoted → Awarded → Closed. Each chip shows count + $
// rollup from the per-line stage derivation in usePlanFlow; clicking a chip
// filters the grid below. Collapsible (state persisted in localStorage) — the
// project status badge lives in the page header now (ProjectStatusBadge).

import React, { useState } from "react";
import { useCostingStore } from "../store/costingStore";
import { usePlanFlow, PLAN_FLOW_STAGES, stageLabel, stageIcon, stageColor, type PlanFlowStage } from "../hooks/usePlanFlow";

const $fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

const COLLAPSE_KEY = "costing:planflow:collapsed";

export default function PlanFlowWidget() {
  const project = useCostingStore((s) => s.project);
  const stageFilter = useCostingStore((s) => s.stageFilter) as PlanFlowStage | null;
  const setStageFilter = useCostingStore((s) => s.setStageFilter);
  const flow    = usePlanFlow();
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === "1"; } catch { return false; }
  });

  if (!project) return null;

  const activeStageFilter = stageFilter;
  const onChip = (stage: PlanFlowStage) => {
    setStageFilter(activeStageFilter === stage ? null : stage);
  };
  const toggleCollapsed = () => {
    setCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  };

  return (
    <div style={{
      background: "#1E293B", border: "1px solid #334155", borderRadius: 8,
      padding: collapsed ? "6px 10px 6px 12px" : "8px 12px", marginBottom: 12, position: "relative",
    }}>
      {/* Collapse toggle (down/right chevron) — top-right corner */}
      <button
        onClick={toggleCollapsed}
        title={collapsed ? "Expand stages" : "Collapse stages"}
        style={{
          position: "absolute", top: 6, right: 8, zIndex: 2,
          background: "transparent", border: "none", color: "#94A3B8",
          fontSize: 12, cursor: "pointer", lineHeight: 1, padding: 4,
        }}
      >
        {collapsed ? "▸" : "▾"}
      </button>

      {collapsed ? (
        // Compact one-line summary when collapsed.
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", paddingRight: 24, fontSize: 12 }}>
          {PLAN_FLOW_STAGES.map((stage) => {
            const b = flow.buckets[stage];
            const sc = stageColor(stage);
            return (
              <button
                key={stage}
                onClick={() => onChip(stage)}
                title={`Filter grid to ${stageLabel(stage)} lines`}
                style={{
                  background: "transparent", border: "none", cursor: "pointer",
                  display: "flex", alignItems: "center", gap: 5, padding: 0,
                  color: activeStageFilter === stage ? "#fff" : sc.fg,
                  opacity: b.count === 0 && activeStageFilter !== stage ? 0.5 : 1,
                  fontWeight: activeStageFilter === stage ? 700 : 500,
                }}
              >
                <span>{stageIcon(stage)}</span>
                <span style={{ fontWeight: 700, textTransform: "uppercase", letterSpacing: ".03em", fontSize: 11 }}>{stageLabel(stage)}</span>
                <span style={{ fontWeight: 700 }}>{b.count}</span>
                {b.totalCost > 0 && <span style={{ opacity: 0.7 }}>{$fmt.format(b.totalCost)}</span>}
              </button>
            );
          })}
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 6, paddingRight: 24 }}>
          {/* Stage strip */}
          <div style={{ display: "flex", flex: 1, gap: 6 }}>
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
                      borderRadius: 6, padding: "6px 9px",
                      cursor: "pointer", textAlign: "left",
                      display: "flex", flexDirection: "column", gap: 1,
                      transition: "all 0.15s",
                      opacity: b.count === 0 && !isActive ? 0.5 : 1,
                    }}
                  >
                    <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase", display: "flex", alignItems: "center", gap: 4 }}>
                      <span style={{ fontSize: 12 }}>{stageIcon(stage)}</span>
                      {stageLabel(stage)}
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                      <span style={{ fontSize: 15, fontWeight: 700 }}>{b.count}</span>
                      <span style={{ fontSize: 10, opacity: 0.75 }}>{$fmt.format(b.totalCost)}</span>
                    </div>
                  </button>
                  {!isLast && (
                    <div style={{ alignSelf: "center", color: "#475569", fontSize: 13 }}>→</div>
                  )}
                </React.Fragment>
              );
            })}
          </div>

          {activeStageFilter && (
            <button
              onClick={() => setStageFilter(null)}
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
      )}
    </div>
  );
}
