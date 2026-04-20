// Client-side orchestrator for ERP writeback. Calls the server-side
// /api/xoro/writeback/* routes — those do the actual (dry-run) work and
// return a structured result per action.
//
// Safety controls in this layer:
//   • Batch must be 'approved' (or 'exported') before submit. Submit
//     from any other state throws.
//   • Each action consults ip_erp_writeback_config.enabled before hitting
//     the endpoint. Disabled config → result is marked 'failed' with a
//     clear message; endpoint never fires.
//   • dry_run defaults to `dry_run_default` on the config row. Caller can
//     override per-batch but we record which mode ran.
//   • Every result writes an audit row.

import type {
  IpExecutionAction,
  IpExecutionBatch,
  WritebackResult,
} from "../types/execution";
import { mapActionToXoroPayload } from "../utils/payloadMappers";
import { hasBlockingErrors, validateAction } from "../utils/validation";
import { executionRepo } from "./executionRepo";
import { markActionStatus, transitionBatch } from "./executionBatchService";

export interface SubmitArgs {
  batch: IpExecutionBatch;
  actions: IpExecutionAction[];
  // true → endpoint runs in dry-run mode regardless of config default
  forceDryRun?: boolean;
  actor?: string | null;
}

export async function submitBatch(args: SubmitArgs): Promise<{
  results: WritebackResult[];
  batch: IpExecutionBatch;
}> {
  const { batch, actions, forceDryRun, actor } = args;
  if (batch.status !== "approved" && batch.status !== "exported") {
    throw new Error(`Batch must be 'approved' to submit. Current status: ${batch.status}`);
  }

  const configRows = await executionRepo.listWritebackConfig("xoro");
  const configByType = new Map(configRows.map((c) => [c.action_type, c]));
  const results: WritebackResult[] = [];

  let anySucceeded = false;
  let anyFailed = false;

  for (const action of actions) {
    if (action.execution_method !== "api_writeback") {
      // Skip non-API-writeback actions — they belong in the exported
      // workbook, not submitted over the wire.
      continue;
    }

    const config = configByType.get(action.action_type);
    if (!config) {
      const r: WritebackResult = {
        action_id: action.id, ok: false, dry_run: false,
        status: "failed",
        message: `No writeback config for action_type=${action.action_type}`,
      };
      results.push(r);
      await markActionStatus({ batch, action, status: "failed", message: r.message, actor });
      anyFailed = true;
      continue;
    }
    if (!config.enabled) {
      const r: WritebackResult = {
        action_id: action.id, ok: false, dry_run: false,
        status: "failed",
        message: `Writeback disabled for ${config.system_name}/${action.action_type}. Enable via ip_erp_writeback_config + server env.`,
      };
      results.push(r);
      await markActionStatus({ batch, action, status: "failed", message: r.message, actor });
      anyFailed = true;
      continue;
    }
    const dryRun = forceDryRun ?? config.dry_run_default;

    // Pre-validate — bail per-action on blocking errors.
    const issues = validateAction(action);
    if (hasBlockingErrors(issues)) {
      const msg = issues.filter((i) => i.severity === "error").map((i) => i.message).join("; ");
      const r: WritebackResult = {
        action_id: action.id, ok: false, dry_run: dryRun, status: "failed",
        message: `Validation: ${msg}`,
      };
      results.push(r);
      await markActionStatus({ batch, action, status: "failed", message: r.message, actor });
      anyFailed = true;
      continue;
    }

    const endpoint = config.endpoint_reference;
    if (!endpoint) {
      const r: WritebackResult = {
        action_id: action.id, ok: false, dry_run: dryRun, status: "failed",
        message: `No endpoint configured for ${action.action_type} — use export-only.`,
      };
      results.push(r);
      await markActionStatus({ batch, action, status: "failed", message: r.message, actor });
      anyFailed = true;
      continue;
    }

    try {
      const payload = mapActionToXoroPayload(action);
      const url = `${endpoint}${endpoint.includes("?") ? "&" : "?"}dry_run=${dryRun ? "1" : "0"}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action_id: action.id, payload }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        const status = dryRun ? "submitted" : "succeeded";
        const r: WritebackResult = {
          action_id: action.id, ok: true, dry_run: dryRun, status,
          message: dryRun ? "Dry-run OK" : "Submitted",
          response: body,
        };
        results.push(r);
        await markActionStatus({ batch, action, status, message: r.message, response: body, actor });
        if (!dryRun) anySucceeded = true;
      } else {
        const r: WritebackResult = {
          action_id: action.id, ok: false, dry_run: dryRun, status: "failed",
          message: `HTTP ${res.status}: ${body?.error ?? body?.message ?? res.statusText}`,
          response: body,
        };
        results.push(r);
        await markActionStatus({ batch, action, status: "failed", message: r.message, response: body, error: r.message, actor });
        anyFailed = true;
      }
    } catch (e) {
      const r: WritebackResult = {
        action_id: action.id, ok: false, dry_run: dryRun, status: "failed",
        message: "Network error: " + (e instanceof Error ? e.message : String(e)),
      };
      results.push(r);
      await markActionStatus({ batch, action, status: "failed", message: r.message, error: r.message, actor });
      anyFailed = true;
    }
  }

  // Decide batch-level status.
  let next: IpExecutionBatch["status"] = batch.status;
  const inputHadApi = actions.some((a) => a.execution_method === "api_writeback");
  if (!inputHadApi) {
    // nothing submitted — just mark exported if caller reached here
    next = "exported";
  } else if (anySucceeded && anyFailed) {
    next = "partially_executed";
  } else if (anySucceeded) {
    next = "executed";
  } else {
    next = "failed";
  }
  const updated = next !== batch.status
    ? await transitionBatch({ batch, to: next, actor, message: `Submit pass — succ=${anySucceeded} fail=${anyFailed}` })
    : batch;

  return { results, batch: updated };
}

// runWritebackDryRun: convenience wrapper that forces dry-run.
export async function runWritebackDryRun(args: Omit<SubmitArgs, "forceDryRun">) {
  return submitBatch({ ...args, forceDryRun: true });
}

// Pure check — handy for the UI to decide whether the Submit button is live.
export function isBatchSubmittable(batch: IpExecutionBatch): boolean {
  return batch.status === "approved" || batch.status === "exported";
}
