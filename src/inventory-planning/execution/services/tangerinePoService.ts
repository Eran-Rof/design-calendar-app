// M31 (direction A) — client orchestrator for turning an approved buy plan into
// DRAFT native Tangerine purchase orders. POSTs the whole batch to
// /api/internal/planning/buy-plan-to-po; the server groups create_buy_request
// actions by vendor and creates one draft PO each. Mirrors the safety posture
// of executionWritebackService (x-user-email header, dry-run preview first).

import type { IpExecutionBatch } from "../types/execution";
import { currentUserEmail } from "../../governance/services/permissionService";

export interface TangerinePoCreated {
  vendor_id: string;
  vendor_name?: string | null;
  // "build" when the PO vendor came from the planning build-stage selection
  // (ip_planning_runs.build_vendor_id, #1857); "action" when it came from the
  // buy action's planning-vendor link.
  vendor_source?: "build" | "action";
  po_id?: string;
  po_status?: string;
  line_count: number;
  total_cents: number;
  expected_date?: string | null;
  preview?: boolean;
}
export interface TangerinePoSkipped { action_id: string; reason: string; code?: string; planning_vendor_id?: string; po_id?: string; sku_code?: string }
export interface TangerinePoWarning { action_id: string; message: string }
export interface TangerineVendorCandidate { id: string; name: string; code?: string | null; match_on: string }
export interface TangerineVendorSuggestion {
  planning_vendor_id: string;
  vendor_code?: string | null;
  name?: string | null;
  candidates: TangerineVendorCandidate[];
}
export interface TangerinePoDiagnostics {
  actions_total: number;
  vendors: number;
  eligible_lines: number;
  skipped: number;
  warnings: number;
  skip_breakdown: Record<string, number>;
}
export interface TangerinePoResult {
  dry_run: boolean;
  created: TangerinePoCreated[];
  skipped: TangerinePoSkipped[];
  warnings: TangerinePoWarning[];
  vendor_suggestions: TangerineVendorSuggestion[];
  diagnostics: TangerinePoDiagnostics | null;
  message: string;
}

export async function createTangerinePos(args: { batch: IpExecutionBatch; dryRun?: boolean }): Promise<TangerinePoResult> {
  const res = await fetch("/api/internal/planning/buy-plan-to-po", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-user-email": currentUserEmail() },
    body: JSON.stringify({ batch_id: args.batch.id, dry_run: args.dryRun === true }),
  });
  const json = (await res.json().catch(() => ({}))) as Partial<TangerinePoResult> & { error?: string };
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return {
    dry_run: !!json.dry_run,
    created: json.created || [],
    skipped: json.skipped || [],
    warnings: json.warnings || [],
    vendor_suggestions: json.vendor_suggestions || [],
    diagnostics: json.diagnostics || null,
    message: json.message || "",
  };
}

// One-click resolver for an unlinked planning vendor — sets
// ip_vendor_master.portal_vendor_id so future buy-plan→PO runs can route its
// actions. Backs the "Link" affordance on a vendor suggestion.
export async function linkPlanningVendor(args: { planningVendorId: string; tangerineVendorId: string }): Promise<{ message: string }> {
  const res = await fetch("/api/internal/planning/link-planning-vendor", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-user-email": currentUserEmail() },
    body: JSON.stringify({ planning_vendor_id: args.planningVendorId, tangerine_vendor_id: args.tangerineVendorId }),
  });
  const json = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return { message: json.message || "Linked." };
}
