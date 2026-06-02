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
  po_id?: string;
  po_status?: string;
  line_count: number;
  total_cents: number;
  expected_date?: string | null;
  preview?: boolean;
}
export interface TangerinePoSkipped { action_id: string; reason: string }
export interface TangerinePoWarning { action_id: string; message: string }
export interface TangerinePoResult {
  dry_run: boolean;
  created: TangerinePoCreated[];
  skipped: TangerinePoSkipped[];
  warnings: TangerinePoWarning[];
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
    message: json.message || "",
  };
}
