// Costing Module — Plan Flow hook (per-LINE status).
//
// Status is per line now (not per project). Each line's EFFECTIVE status is
// derived with this precedence:
//   closed  (manual)  — costing_lines.status = 'closed'
//   awarded (auto)    — selected_vendor_quote_id IS NOT NULL
//   on_rfq  (auto)    — line is on a generated RFQ (_on_rfq from the lines GET)
//   draft   (default) — manual status, the fallback
// The strip rolls these up into per-status counts + $ totals.

import { useMemo } from "react";
import { useCostingStore } from "../store/costingStore";
import type { CostingLine, CostingLineEffectiveStatus } from "../types";

export type PlanFlowStage = CostingLineEffectiveStatus; // draft | on_rfq | awarded | closed

export const PLAN_FLOW_STAGES: PlanFlowStage[] = ["draft", "on_rfq", "awarded", "closed"];

const STAGE_LABEL: Record<PlanFlowStage, string> = {
  draft:   "Draft",
  on_rfq:  "On RFQ",
  awarded: "Awarded",
  closed:  "Closed",
};

const STAGE_ICON: Record<PlanFlowStage, string> = {
  draft:   "✏️",
  on_rfq:  "📤",
  awarded: "🏆",
  closed:  "🔒",
};

const STAGE_COLOR: Record<PlanFlowStage, { bg: string; fg: string; bar: string }> = {
  draft:   { bg: "#33415533", fg: "#CBD5E1", bar: "#64748B" },
  on_rfq:  { bg: "#78350F33", fg: "#FBBF24", bar: "#F59E0B" },
  awarded: { bg: "#064E3B33", fg: "#34D399", bar: "#10B981" },
  closed:  { bg: "#3730A333", fg: "#A5B4FC", bar: "#6366F1" },
};

export function stageLabel(s: PlanFlowStage): string { return STAGE_LABEL[s]; }
export function stageIcon(s: PlanFlowStage): string  { return STAGE_ICON[s]; }
export function stageColor(s: PlanFlowStage)         { return STAGE_COLOR[s]; }

// Effective per-line status (precedence: closed > awarded > on_rfq > draft).
export function effectiveLineStatus(line: CostingLine): PlanFlowStage {
  if (line.status === "closed") return "closed";
  if (line.selected_vendor_quote_id) return "awarded";
  if (line._on_rfq) return "on_rfq";
  return "draft";
}

export interface PlanFlowBucket {
  stage: PlanFlowStage;
  count: number;
  totalCost: number;
  totalSales: number;
  lineIds: string[];
}

export interface PlanFlowSummary {
  buckets: Record<PlanFlowStage, PlanFlowBucket>;
  orderedBuckets: PlanFlowBucket[];
  lineStageById: Record<string, PlanFlowStage>;
}

function lineCostTotal(line: CostingLine): number {
  const qty = Number(line.target_qty) || 0;
  const unit = Number(line.landed_cost) || Number(line.target_cost) || 0;
  return qty * unit;
}

function lineSalesTotal(line: CostingLine): number {
  const qty = Number(line.target_qty) || 0;
  const unit = Number(line.sell_price) || Number(line.sell_target) || 0;
  return qty * unit;
}

export function usePlanFlow(): PlanFlowSummary {
  const lines = useCostingStore((s) => s.lines);

  return useMemo(() => {
    const lineStageById: Record<string, PlanFlowStage> = {};
    const buckets: Record<PlanFlowStage, PlanFlowBucket> = {
      draft:   { stage: "draft",   count: 0, totalCost: 0, totalSales: 0, lineIds: [] },
      on_rfq:  { stage: "on_rfq",  count: 0, totalCost: 0, totalSales: 0, lineIds: [] },
      awarded: { stage: "awarded", count: 0, totalCost: 0, totalSales: 0, lineIds: [] },
      closed:  { stage: "closed",  count: 0, totalCost: 0, totalSales: 0, lineIds: [] },
    };

    for (const line of lines) {
      const stage = effectiveLineStatus(line);
      lineStageById[line.id] = stage;
      const b = buckets[stage];
      b.count++;
      b.totalCost  += lineCostTotal(line);
      b.totalSales += lineSalesTotal(line);
      b.lineIds.push(line.id);
    }

    const orderedBuckets = PLAN_FLOW_STAGES.map((s) => buckets[s]);
    return { buckets, orderedBuckets, lineStageById };
  }, [lines]);
}
