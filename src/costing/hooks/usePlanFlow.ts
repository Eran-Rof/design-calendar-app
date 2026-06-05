// Costing Module — Plan Flow hook (per-LINE status).
//
// Status is a STORED, event-driven lifecycle on costing_lines.status:
//   draft   — new line, nothing sent
//   sent    — line is on a published RFQ (vendor invited)        [publish.js]
//   quoted  — the invited vendor submitted a quote                [submit.js]
//   awarded — a vendor quote was selected for the line            [award/[vendor].js]
//   lost    — a sibling row (same project+style) won              [award/[vendor].js]
//   revised — reserved for Stage B (edit-forks-a-Sent-row)
//   closed  — manual terminal close (operator)
// effectiveLineStatus returns the STORED status when present, falling back to
// the legacy derivation (selected_vendor_quote_id / _on_rfq) for null rows.
// The strip rolls these up into per-status counts + $ totals.

import { useMemo } from "react";
import { useCostingStore } from "../store/costingStore";
import type { CostingLine, CostingLineEffectiveStatus } from "../types";

export type PlanFlowStage = CostingLineEffectiveStatus;

// Lifecycle stages shown in the Plan Flow strip / used as grid buckets, in flow
// order. ('on_rfq' is a legacy derived value kept in the union + color map for
// the projects-list buckets, but it is NOT a lifecycle stage chip.)
export const PLAN_FLOW_STAGES: PlanFlowStage[] = [
  "draft", "sent", "quoted", "awarded", "lost", "revised", "closed",
];

const STAGE_LABEL: Record<PlanFlowStage, string> = {
  draft:   "Draft",
  on_rfq:  "On RFQ",
  sent:    "Sent",
  quoted:  "Quoted",
  awarded: "Awarded",
  lost:    "Lost",
  revised: "Revised",
  closed:  "Closed",
};

const STAGE_ICON: Record<PlanFlowStage, string> = {
  draft:   "✏️",
  on_rfq:  "📤",
  sent:    "📤",
  quoted:  "💬",
  awarded: "🏆",
  lost:    "❌",
  revised: "🔁",
  closed:  "🔒",
};

// GREEN is reserved for `awarded` only. Other stages use distinct hues so the
// grid reads at a glance: draft gray, sent blue, quoted amber, lost red,
// revised muted slate, closed indigo.
const STAGE_COLOR: Record<PlanFlowStage, { bg: string; fg: string; bar: string }> = {
  draft:   { bg: "#33415533", fg: "#CBD5E1", bar: "#64748B" },
  on_rfq:  { bg: "#78350F33", fg: "#FBBF24", bar: "#F59E0B" },
  sent:    { bg: "#1E3A8A33", fg: "#93C5FD", bar: "#3B82F6" },
  quoted:  { bg: "#78350F33", fg: "#FBBF24", bar: "#F59E0B" },
  awarded: { bg: "#064E3B33", fg: "#34D399", bar: "#10B981" },
  lost:    { bg: "#7F1D1D33", fg: "#FCA5A5", bar: "#EF4444" },
  revised: { bg: "#33415533", fg: "#94A3B8", bar: "#64748B" },
  closed:  { bg: "#3730A333", fg: "#A5B4FC", bar: "#6366F1" },
};

export function stageLabel(s: PlanFlowStage): string { return STAGE_LABEL[s]; }
export function stageIcon(s: PlanFlowStage): string  { return STAGE_ICON[s]; }
export function stageColor(s: PlanFlowStage)         { return STAGE_COLOR[s]; }

// Lifecycle values that may appear stored in costing_lines.status.
const LIFECYCLE_STORED = new Set<string>([
  "draft", "sent", "quoted", "awarded", "lost", "revised", "closed",
]);

// Effective per-line status. Status is stored + event-driven now, so we RETURN
// the stored value when it's a recognized lifecycle state. 'closed' keeps manual
// precedence. The legacy derivation (awarded via selected_vendor_quote_id, on_rfq
// via _on_rfq) is only a fallback for null / unrecognized rows.
export function effectiveLineStatus(line: CostingLine): PlanFlowStage {
  const stored = line.status as string | null | undefined;
  if (stored === "closed") return "closed";
  if (stored && LIFECYCLE_STORED.has(stored) && stored !== "draft") {
    return stored as PlanFlowStage;
  }
  // Fallback for legacy rows with null / bare-'draft' status.
  if (line.selected_vendor_quote_id) return "awarded";
  if (line._on_rfq) return "sent";
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

function emptyBucket(stage: PlanFlowStage): PlanFlowBucket {
  return { stage, count: 0, totalCost: 0, totalSales: 0, lineIds: [] };
}

export function usePlanFlow(): PlanFlowSummary {
  const lines = useCostingStore((s) => s.lines);

  return useMemo(() => {
    const lineStageById: Record<string, PlanFlowStage> = {};
    const buckets = {} as Record<PlanFlowStage, PlanFlowBucket>;
    for (const stage of PLAN_FLOW_STAGES) buckets[stage] = emptyBucket(stage);
    // on_rfq is not a strip stage but keep a bucket so any stray reference is safe.
    if (!buckets.on_rfq) buckets.on_rfq = emptyBucket("on_rfq");

    for (const line of lines) {
      const stage = effectiveLineStatus(line);
      lineStageById[line.id] = stage;
      const b = buckets[stage] || (buckets[stage] = emptyBucket(stage));
      b.count++;
      b.totalCost  += lineCostTotal(line);
      b.totalSales += lineSalesTotal(line);
      b.lineIds.push(line.id);
    }

    const orderedBuckets = PLAN_FLOW_STAGES.map((s) => buckets[s]);
    return { buckets, orderedBuckets, lineStageById };
  }, [lines]);
}
