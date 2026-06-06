// Costing Module — Plan Flow hook (per-LINE status).
//
// Status is a STORED, event-driven lifecycle on costing_lines.status:
//   draft   — new line, nothing sent
//   sent    — line is on a published RFQ (vendor invited)        [publish.js]
//   quoted  — the invited vendor submitted a quote                [submit.js]
//   awarded — formally awarded via the RFQ award flow             [award/[vendor].js]
//   lost    — a sibling row (same project+style) won              [award/[vendor].js]
//   revised — Stage B (edit-forks-a-Sent-row mechanic)
//   closed  — manual terminal close (operator)
//
// NOTE: selecting a vendor quote on a line (selected_vendor_quote_id) is NOT
// the same as awarding. Vendor selection tracks the intended vendor for RFQ
// generation; awarded is set only by the formal RFQ award handler.

import { useMemo } from "react";
import { useCostingStore } from "../store/costingStore";
import type { CostingLine, CostingLineStatus } from "../types";

export type PlanFlowStage = CostingLineStatus;

export const PLAN_FLOW_STAGES: PlanFlowStage[] = [
  "draft", "sent", "quoted", "awarded", "lost", "revised", "closed",
];

const STAGE_LABEL: Record<PlanFlowStage, string> = {
  draft:   "Draft",
  sent:    "Sent",
  quoted:  "Quoted",
  awarded: "Awarded",
  lost:    "Lost",
  revised: "Revised",
  closed:  "Closed",
};

const STAGE_ICON: Record<PlanFlowStage, string> = {
  draft:   "✏️",
  sent:    "📤",
  quoted:  "💬",
  awarded: "🏆",
  lost:    "❌",
  revised: "🔁",
  closed:  "🔒",
};

// GREEN reserved for awarded. Other stages: draft gray, sent blue, quoted amber,
// lost red, revised muted slate, closed indigo.
const STAGE_COLOR: Record<PlanFlowStage, { bg: string; fg: string; bar: string }> = {
  draft:   { bg: "#33415533", fg: "#CBD5E1", bar: "#64748B" },
  sent:    { bg: "#1E3A8A33", fg: "#93C5FD", bar: "#3B82F6" },
  quoted:  { bg: "#78350F33", fg: "#FBBF24", bar: "#F59E0B" },
  awarded: { bg: "#064E3B33", fg: "#34D399", bar: "#10B981" },
  lost:    { bg: "#7F1D1D33", fg: "#FCA5A5", bar: "#EF4444" },
  revised: { bg: "#33415533", fg: "#94A3B8", bar: "#64748B" },
  closed:  { bg: "#3730A333", fg: "#A5B4FC", bar: "#6366F1" },
};

export function stageLabel(s: PlanFlowStage): string { return STAGE_LABEL[s] ?? s; }
export function stageIcon(s: PlanFlowStage): string  { return STAGE_ICON[s] ?? ""; }
export function stageColor(s: PlanFlowStage)         { return STAGE_COLOR[s] ?? STAGE_COLOR.draft; }

const KNOWN_STAGES = new Set<string>(PLAN_FLOW_STAGES);

// Effective per-line status reads directly from the stored DB column.
// Vendor selection (selected_vendor_quote_id) is NOT treated as awarded;
// only a formal RFQ award sets status='awarded'.
export function effectiveLineStatus(line: CostingLine): PlanFlowStage {
  const s = line.status;
  if (s && KNOWN_STAGES.has(s)) return s as PlanFlowStage;
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
    const buckets = {} as Record<PlanFlowStage, PlanFlowBucket>;
    for (const stage of PLAN_FLOW_STAGES) {
      buckets[stage] = { stage, count: 0, totalCost: 0, totalSales: 0, lineIds: [] };
    }

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
