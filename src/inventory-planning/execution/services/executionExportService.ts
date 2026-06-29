// Export a batch to xlsx. Default, safest execution path.

import type { IpCategory, IpItem } from "../../types/entities";
import type { IpPlanningRun } from "../../types/wholesale";
import type { IpExecutionAction, IpExecutionBatch } from "../types/execution";
import { mapActionToXoroPayload } from "../utils/payloadMappers";
import { executionRepo } from "./executionRepo";
import { newWorkbook, addObjectGridSheet, addMetaSheet, downloadExcelWorkbook } from "../../../shared/excelLogo";

function slug(s: string): string { return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }
function today(): string { return new Date().toISOString().slice(0, 10); }

const QTY_KEYS = ["suggested_qty", "approved_qty"];

function metaPairs(args: { batch: IpExecutionBatch; run: IpPlanningRun; rowCount: number }): Array<[string, unknown]> {
  return [
    ["Generated at", new Date().toISOString()],
    ["Batch id", args.batch.id],
    ["Batch name", args.batch.batch_name],
    ["Batch type", args.batch.batch_type],
    ["Batch status", args.batch.status],
    ["Created by", args.batch.created_by ?? ""],
    ["Approved by", args.batch.approved_by ?? ""],
    ["Approved at", args.batch.approved_at ?? ""],
    ["Planning run", args.run.name],
    ["Run snapshot", args.run.source_snapshot_date],
    ["Horizon", `${args.run.horizon_start} → ${args.run.horizon_end}`],
    ["Actions", args.rowCount],
    ["Export note", "Export-first execution — manual ERP entry unless a writeback run was submitted."],
  ];
}

// id → name lookups for the vendor / customer / channel export columns. The
// caller (ExecutionBatchManager) already loads these; pass them in. Falls back
// to fetching from the repo so the export is never left showing raw UUIDs.
export interface ExecutionExportNameMaps {
  vendor: Map<string, string>;
  customer: Map<string, string>;
  channel: Map<string, string>;
}

export async function exportExecutionBatch(args: {
  batch: IpExecutionBatch;
  actions: IpExecutionAction[];
  run: IpPlanningRun;
  items: IpItem[];
  categories: IpCategory[];
  names?: ExecutionExportNameMaps;
  actor?: string | null;
}): Promise<{ file_name: string; row_count: number }> {
  const { batch, actions, run, items } = args;
  const itemById = new Map(items.map((i) => [i.id, i]));
  const names = args.names ?? (await executionRepo.listNameMaps());
  // Resolve an id through a name map, never surfacing a raw UUID. Empty/missing → "—".
  const nameOf = (map: Map<string, string>, id: string | null): string =>
    (id ? map.get(id) : "") || "—";
  const rows = actions.map((a) => {
    const item = itemById.get(a.sku_id);
    const payload = mapActionToXoroPayload(a);
    return {
      action_type: a.action_type,
      sku_code: item?.sku_code ?? "—",
      description: item?.description ?? "",
      vendor: nameOf(names.vendor, a.vendor_id),
      customer: nameOf(names.customer, a.customer_id),
      channel: nameOf(names.channel, a.channel_id),
      po_number: a.po_number ?? "",
      period: a.period_start ?? "",
      suggested_qty: a.suggested_qty,
      approved_qty: a.approved_qty ?? "",
      execution_method: a.execution_method,
      execution_status: a.execution_status,
      reason: a.action_reason ?? "",
      payload_type: payload.type,
    };
  });

  const wb = newWorkbook();
  addObjectGridSheet(wb, "Actions", rows, {
    title: "Execution Batch",
    subtitle: `${batch.batch_name} · ${run.name}`,
    qtyKeys: QTY_KEYS,
  });
  addMetaSheet(wb, "Meta", metaPairs({ batch, run, rowCount: rows.length }));

  const fileName = `execution_${batch.batch_type}_${slug(batch.batch_name)}_${today()}.xlsx`;
  await downloadExcelWorkbook(wb, fileName);

  // Audit the export.
  await executionRepo.insertAudit({
    execution_batch_id: batch.id,
    execution_action_id: null,
    event_type: "batch_exported",
    old_status: batch.status,
    new_status: "exported",
    event_message: `xlsx: ${fileName} (${rows.length} actions)`,
    actor: args.actor ?? null,
  });

  return { file_name: fileName, row_count: rows.length };
}
