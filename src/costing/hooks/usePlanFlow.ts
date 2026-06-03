// Costing Module — Plan Flow widget hook.
//
// Derives per-line stage from store state (no extra DB columns) and rolls up
// per-stage counts + $ totals for the 5-stage strip.
//
// Stages:
//   draft       — line has no style_master_id yet (free-typed placeholder)
//   in_progress — style chosen, but no vendor quotes yet
//   quoted      — ≥1 vendor quote with status pending or received
//   awarded     — selected_vendor_quote_id IS NOT NULL
//   closed      — parent project status='closed' or 'cancelled'

import { useMemo } from "react";
import { useCostingStore } from "../store/costingStore";
import type { CostingLine, CostingStatus, CostingLineVendor } from "../types";

export type PlanFlowStage = "draft" | "in_progress" | "quoted" | "awarded" | "closed";

export const PLAN_FLOW_STAGES: PlanFlowStage[] = [
  "draft", "in_progress", "quoted", "awarded", "closed",
];

const STAGE_LABEL: Record<PlanFlowStage, string> = {
  draft:       "Draft",
  in_progress: "In Progress",
  quoted:      "Quoted",
  awarded:     "Awarded",
  closed:      "Closed",
};

const STAGE_ICON: Record<PlanFlowStage, string> = {
  draft:       "✏️",
  in_progress: "🔧",
  quoted:      "💬",
  awarded:     "🏆",
  closed:      "🔒",
};

const STAGE_COLOR: Record<PlanFlowStage, { bg: string; fg: string; bar: string }> = {
  draft:       { bg: "#E5E7EB", fg: "#374151", bar: "#9CA3AF" },
  in_progress: { bg: "#DBEAFE", fg: "#1E40AF", bar: "#3B82F6" },
  quoted:      { bg: "#FEF3C7", fg: "#92400E", bar: "#F59E0B" },
  awarded:     { bg: "#DCFCE7", fg: "#166534", bar: "#10B981" },
  closed:      { bg: "#E0E7FF", fg: "#3730A3", bar: "#6366F1" },
};

export function stageLabel(s: PlanFlowStage): string { return STAGE_LABEL[s]; }
export function stageIcon(s: PlanFlowStage): string  { return STAGE_ICON[s]; }
export function stageColor(s: PlanFlowStage)         { return STAGE_COLOR[s]; }

const STAGE_RANK: Record<PlanFlowStage, number> = {
  draft: 0, in_progress: 1, quoted: 2, awarded: 3, closed: 4,
};

// Project-level derived stage = the highest line stage present (any awarded
// line ⇒ "awarded", any live quote ⇒ "quoted", any style chosen ⇒
// "in_progress", else "draft"). Project-level closed/cancelled are terminal and
// handled by the caller, so we pass projectStatus=null to get the pure line
// stage. Empty project ⇒ "draft". Used to auto-advance costing_projects.status
// so the Projects list (buckets by status) agrees with the in-project strip.
export function deriveProjectStage(
  lines: CostingLine[],
  vendorQuotes: Record<string, CostingLineVendor[] | undefined>,
): PlanFlowStage {
  let best: PlanFlowStage = "draft";
  for (const line of lines) {
    const st = deriveLineStage(line, vendorQuotes[line.id], null);
    if (STAGE_RANK[st] > STAGE_RANK[best]) best = st;
  }
  return best;
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
  projectStatus: CostingStatus | null;
  lineStageById: Record<string, PlanFlowStage>;
}

function deriveLineStage(
  line: CostingLine,
  quotes: CostingLineVendor[] | undefined,
  projectStatus: CostingStatus | null,
): PlanFlowStage {
  if (projectStatus === "closed" || projectStatus === "cancelled") return "closed";
  if (line.selected_vendor_quote_id) return "awarded";
  const liveQuotes = (quotes || []).filter((q) => q.status === "pending" || q.status === "received" || q.status === "selected");
  if (liveQuotes.length > 0) return "quoted";
  if (line.style_master_id) return "in_progress";
  return "draft";
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
  const project      = useCostingStore((s) => s.project);
  const lines        = useCostingStore((s) => s.lines);
  const vendorQuotes = useCostingStore((s) => s.vendorQuotes);

  return useMemo(() => {
    const projectStatus = project?.status ?? null;
    const lineStageById: Record<string, PlanFlowStage> = {};
    const buckets: Record<PlanFlowStage, PlanFlowBucket> = {
      draft:       { stage: "draft",       count: 0, totalCost: 0, totalSales: 0, lineIds: [] },
      in_progress: { stage: "in_progress", count: 0, totalCost: 0, totalSales: 0, lineIds: [] },
      quoted:      { stage: "quoted",      count: 0, totalCost: 0, totalSales: 0, lineIds: [] },
      awarded:     { stage: "awarded",     count: 0, totalCost: 0, totalSales: 0, lineIds: [] },
      closed:      { stage: "closed",      count: 0, totalCost: 0, totalSales: 0, lineIds: [] },
    };

    for (const line of lines) {
      const stage = deriveLineStage(line, vendorQuotes[line.id], projectStatus);
      lineStageById[line.id] = stage;
      const b = buckets[stage];
      b.count++;
      b.totalCost  += lineCostTotal(line);
      b.totalSales += lineSalesTotal(line);
      b.lineIds.push(line.id);
    }

    const orderedBuckets = PLAN_FLOW_STAGES.map((s) => buckets[s]);
    return { buckets, orderedBuckets, projectStatus, lineStageById };
  }, [project, lines, vendorQuotes]);
}
