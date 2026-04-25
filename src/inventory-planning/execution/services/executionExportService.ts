// Export a batch to xlsx. Default, safest execution path.

import XLSXStyle from "xlsx-js-style";
import type { IpCategory, IpItem } from "../../types/entities";
import type { IpPlanningRun } from "../../types/wholesale";
import type { IpExecutionAction, IpExecutionBatch } from "../types/execution";
import { mapActionToXoroPayload } from "../utils/payloadMappers";
import { executionRepo } from "./executionRepo";

function slug(s: string): string { return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }
function today(): string { return new Date().toISOString().slice(0, 10); }

const HDR: XLSXStyle.CellStyle = {
  font: { bold: true, color: { rgb: "FFFFFF" } },
  fill: { fgColor: { rgb: "1F497D" }, patternType: "solid" },
  alignment: { horizontal: "center" },
};

function sheet(rows: Record<string, unknown>[]): XLSXStyle.WorkSheet {
  if (rows.length === 0) return XLSXStyle.utils.aoa_to_sheet([["(no rows)"]]);
  const headers = Object.keys(rows[0]);
  const aoa: unknown[][] = [headers, ...rows.map((r) => headers.map((h) => r[h]))];
  const ws = XLSXStyle.utils.aoa_to_sheet(aoa);
  for (let c = 0; c < headers.length; c++) {
    const cell = XLSXStyle.utils.encode_cell({ r: 0, c });
    if (ws[cell]) ws[cell].s = HDR;
  }
  ws["!cols"] = headers.map((h) => ({ wch: Math.min(40, Math.max(12, h.length + 2)) }));
  return ws;
}

function metaSheet(args: {
  batch: IpExecutionBatch;
  run: IpPlanningRun;
  rowCount: number;
}): XLSXStyle.WorkSheet {
  return XLSXStyle.utils.aoa_to_sheet([
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
  ]);
}

function download(wb: XLSXStyle.WorkBook, fileName: string): void {
  const buf = XLSXStyle.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
  const blob = new Blob([buf], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = fileName; a.click();
  URL.revokeObjectURL(url);
}

export async function exportExecutionBatch(args: {
  batch: IpExecutionBatch;
  actions: IpExecutionAction[];
  run: IpPlanningRun;
  items: IpItem[];
  categories: IpCategory[];
  actor?: string | null;
}): Promise<{ file_name: string; row_count: number }> {
  const { batch, actions, run, items } = args;
  const itemById = new Map(items.map((i) => [i.id, i]));
  const rows = actions.map((a) => {
    const item = itemById.get(a.sku_id);
    const payload = mapActionToXoroPayload(a);
    return {
      action_id: a.id.slice(0, 8),
      action_type: a.action_type,
      sku_code: item?.sku_code ?? "",
      description: item?.description ?? "",
      po_number: a.po_number ?? "",
      vendor_id: a.vendor_id ?? "",
      customer_id: a.customer_id ?? "",
      channel_id: a.channel_id ?? "",
      period: a.period_start ?? "",
      suggested_qty: a.suggested_qty,
      approved_qty: a.approved_qty ?? "",
      execution_method: a.execution_method,
      execution_status: a.execution_status,
      reason: a.action_reason ?? "",
      payload_type: payload.type,
    };
  });

  const wb = XLSXStyle.utils.book_new();
  XLSXStyle.utils.book_append_sheet(wb, sheet(rows), "Actions");
  XLSXStyle.utils.book_append_sheet(wb, metaSheet({ batch, run, rowCount: rows.length }), "Meta");

  const fileName = `execution_${batch.batch_type}_${slug(batch.batch_name)}_${today()}.xlsx`;
  download(wb, fileName);

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
