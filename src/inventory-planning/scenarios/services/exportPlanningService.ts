// Phase 4 exports. Reuses xlsx-js-style (already in the app for ATS).
//
// Six export types:
//   wholesale_buy_plan        — recs of type buy/expedite from wholesale
//   ecom_buy_plan             — same for ecom channels
//   shortage_report           — all shortages in projected_inventory
//   excess_report             — all excesses
//   recommendations_report    — full recommendation list
//   scenario_comparison       — base vs scenario grid + totals sheet
//
// Naming: "<type>_<run-slug>_<YYYY-MM-DD>.xlsx"

import XLSXStyle from "xlsx-js-style";
import type {
  IpInventoryRecommendation,
  IpProjectedInventory,
} from "../../supply/types/supply";
import type { IpItem, IpCategory } from "../../types/entities";
import type { IpPlanningRun } from "../../types/wholesale";
import type { IpExportJob, IpExportType, ScenarioComparisonRow, ScenarioComparisonTotals } from "../types/scenarios";
import { wholesaleRepo } from "../../services/wholesalePlanningRepository";
import { supplyRepo } from "../../supply/services/supplyReconciliationRepo";
import { scenarioRepo } from "./scenarioRepo";
import { logChange } from "./auditLogService";

// Shared styles — keep them modest; this isn't the ATS deck.
const HDR: any = {
  font: { bold: true, color: { rgb: "FFFFFF" }, sz: 11, name: "Calibri" },
  fill: { fgColor: { rgb: "1F497D" }, patternType: "solid" },
  alignment: { horizontal: "center", vertical: "center" },
};
const CELL: any = {
  font: { sz: 10, name: "Calibri" },
  alignment: { horizontal: "left", vertical: "center" },
};
const NUM: any = { ...CELL, alignment: { horizontal: "right", vertical: "center" } };

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function sheet(rowsOfObjects: Record<string, unknown>[]): XLSXStyle.WorkSheet {
  if (rowsOfObjects.length === 0) {
    return XLSXStyle.utils.aoa_to_sheet([["(no rows)"]]);
  }
  const headers = Object.keys(rowsOfObjects[0]);
  const aoa: unknown[][] = [headers, ...rowsOfObjects.map((r) => headers.map((h) => r[h]))];
  const ws = XLSXStyle.utils.aoa_to_sheet(aoa);
  // Apply light styles.
  for (let c = 0; c < headers.length; c++) {
    const cell = XLSXStyle.utils.encode_cell({ r: 0, c });
    if (ws[cell]) ws[cell].s = HDR;
  }
  ws["!cols"] = headers.map((h) => ({ wch: Math.min(40, Math.max(12, h.length + 2)) }));
  return ws;
}

function metaSheet(args: {
  run: IpPlanningRun;
  exportType: IpExportType;
  rowCount: number;
  notes?: string[];
}): XLSXStyle.WorkSheet {
  const meta = [
    ["Generated at", new Date().toISOString()],
    ["Export type", args.exportType],
    ["Planning run id", args.run.id],
    ["Planning run name", args.run.name],
    ["Planning scope", args.run.planning_scope],
    ["Run status", args.run.status],
    ["Snapshot date", args.run.source_snapshot_date],
    ["Horizon", `${args.run.horizon_start} → ${args.run.horizon_end}`],
    ["Row count", args.rowCount],
    ...(args.notes ?? []).map((n) => ["Note", n]),
  ];
  return XLSXStyle.utils.aoa_to_sheet(meta);
}

function download(workbook: XLSXStyle.WorkBook, fileName: string): void {
  const buf = XLSXStyle.write(workbook, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
  const blob = new Blob([buf], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Public API ────────────────────────────────────────────────────────────
export interface ExportContext {
  run: IpPlanningRun;
  scenarioId?: string | null;
  items: IpItem[];
  categories: IpCategory[];
  createdBy?: string | null;
}

async function recordExport(
  ctx: ExportContext,
  type: IpExportType,
  fileName: string,
  rowCount: number,
): Promise<IpExportJob> {
  const job = await scenarioRepo.createExport({
    planning_run_id: ctx.run.id,
    scenario_id: ctx.scenarioId ?? null,
    export_type: type,
    export_status: "completed",
    file_name: fileName,
    row_count: rowCount,
    note: null,
    created_by: ctx.createdBy ?? null,
  });
  await logChange({
    entity_type: "planning_run",
    entity_id: ctx.run.id,
    changed_field: "exported",
    new_value: `${type}:${fileName}:${rowCount}`,
    planning_run_id: ctx.run.id,
    scenario_id: ctx.scenarioId ?? null,
  });
  return job;
}

export async function exportWholesaleBuyPlan(ctx: ExportContext): Promise<IpExportJob> {
  const recs = await supplyRepo.listRecommendations(ctx.run.id);
  const itemById = new Map(ctx.items.map((i) => [i.id, i]));
  const rows = recs
    .filter((r) => r.recommendation_type === "buy" || r.recommendation_type === "expedite")
    .map((r) => ({
      sku_code: itemById.get(r.sku_id)?.sku_code ?? r.sku_id.slice(0, 8),
      description: itemById.get(r.sku_id)?.description ?? "",
      period: r.period_code,
      action: r.recommendation_type,
      qty: r.recommendation_qty ?? 0,
      priority: r.priority_level,
      service_risk: r.service_risk_flag,
      reason: r.action_reason ?? "",
    }));
  const wb = XLSXStyle.utils.book_new();
  XLSXStyle.utils.book_append_sheet(wb, sheet(rows), "Buy Plan");
  XLSXStyle.utils.book_append_sheet(wb, metaSheet({ run: ctx.run, exportType: "wholesale_buy_plan", rowCount: rows.length }), "Meta");
  const fileName = `wholesale_buy_plan_${slug(ctx.run.name)}_${today()}.xlsx`;
  download(wb, fileName);
  return recordExport(ctx, "wholesale_buy_plan", fileName, rows.length);
}

export async function exportEcomBuyPlan(ctx: ExportContext): Promise<IpExportJob> {
  const recs = await supplyRepo.listRecommendations(ctx.run.id);
  const itemById = new Map(ctx.items.map((i) => [i.id, i]));
  const rows = recs
    .filter((r) => r.recommendation_type === "buy" || r.recommendation_type === "expedite" || r.recommendation_type === "protect_inventory")
    .map((r) => ({
      sku_code: itemById.get(r.sku_id)?.sku_code ?? r.sku_id.slice(0, 8),
      description: itemById.get(r.sku_id)?.description ?? "",
      period: r.period_code,
      action: r.recommendation_type,
      qty: r.recommendation_qty ?? 0,
      priority: r.priority_level,
      reason: r.action_reason ?? "",
    }));
  const wb = XLSXStyle.utils.book_new();
  XLSXStyle.utils.book_append_sheet(wb, sheet(rows), "Ecom Buy Plan");
  XLSXStyle.utils.book_append_sheet(wb, metaSheet({ run: ctx.run, exportType: "ecom_buy_plan", rowCount: rows.length }), "Meta");
  const fileName = `ecom_buy_plan_${slug(ctx.run.name)}_${today()}.xlsx`;
  download(wb, fileName);
  return recordExport(ctx, "ecom_buy_plan", fileName, rows.length);
}

export async function exportShortageReport(ctx: ExportContext): Promise<IpExportJob> {
  const projected = await supplyRepo.listProjected(ctx.run.id);
  const itemById = new Map(ctx.items.map((i) => [i.id, i]));
  const rows = projected
    .filter((p: IpProjectedInventory) => p.shortage_qty > 0)
    .sort((a, b) => b.shortage_qty - a.shortage_qty)
    .map((p: IpProjectedInventory) => ({
      sku_code: itemById.get(p.sku_id)?.sku_code ?? p.sku_id.slice(0, 8),
      period: p.period_code,
      demand: p.wholesale_demand_qty + p.ecom_demand_qty,
      supply: p.total_available_supply_qty,
      shortage: p.shortage_qty,
      stockout: p.projected_stockout_flag,
    }));
  const wb = XLSXStyle.utils.book_new();
  XLSXStyle.utils.book_append_sheet(wb, sheet(rows), "Shortages");
  XLSXStyle.utils.book_append_sheet(wb, metaSheet({ run: ctx.run, exportType: "shortage_report", rowCount: rows.length }), "Meta");
  const fileName = `shortage_report_${slug(ctx.run.name)}_${today()}.xlsx`;
  download(wb, fileName);
  return recordExport(ctx, "shortage_report", fileName, rows.length);
}

export async function exportExcessReport(ctx: ExportContext): Promise<IpExportJob> {
  const projected = await supplyRepo.listProjected(ctx.run.id);
  const itemById = new Map(ctx.items.map((i) => [i.id, i]));
  const rows = projected
    .filter((p: IpProjectedInventory) => p.excess_qty > 0)
    .sort((a, b) => b.excess_qty - a.excess_qty)
    .map((p: IpProjectedInventory) => ({
      sku_code: itemById.get(p.sku_id)?.sku_code ?? p.sku_id.slice(0, 8),
      period: p.period_code,
      demand: p.wholesale_demand_qty + p.ecom_demand_qty,
      supply: p.total_available_supply_qty,
      excess: p.excess_qty,
    }));
  const wb = XLSXStyle.utils.book_new();
  XLSXStyle.utils.book_append_sheet(wb, sheet(rows), "Excess");
  XLSXStyle.utils.book_append_sheet(wb, metaSheet({ run: ctx.run, exportType: "excess_report", rowCount: rows.length }), "Meta");
  const fileName = `excess_report_${slug(ctx.run.name)}_${today()}.xlsx`;
  download(wb, fileName);
  return recordExport(ctx, "excess_report", fileName, rows.length);
}

export async function exportRecommendationsReport(ctx: ExportContext): Promise<IpExportJob> {
  const recs = await supplyRepo.listRecommendations(ctx.run.id);
  const itemById = new Map(ctx.items.map((i) => [i.id, i]));
  const rows = recs.map((r: IpInventoryRecommendation) => ({
    sku_code: itemById.get(r.sku_id)?.sku_code ?? r.sku_id.slice(0, 8),
    period: r.period_code,
    action: r.recommendation_type,
    qty: r.recommendation_qty ?? 0,
    priority: r.priority_level,
    shortage: r.shortage_qty ?? 0,
    excess: r.excess_qty ?? 0,
    service_risk: r.service_risk_flag,
    reason: r.action_reason ?? "",
  }));
  const wb = XLSXStyle.utils.book_new();
  XLSXStyle.utils.book_append_sheet(wb, sheet(rows), "Recommendations");
  XLSXStyle.utils.book_append_sheet(wb, metaSheet({ run: ctx.run, exportType: "recommendations_report", rowCount: rows.length }), "Meta");
  const fileName = `recommendations_${slug(ctx.run.name)}_${today()}.xlsx`;
  download(wb, fileName);
  return recordExport(ctx, "recommendations_report", fileName, rows.length);
}

export async function exportScenarioComparison(
  ctx: ExportContext,
  comparison: { rows: ScenarioComparisonRow[]; totals: ScenarioComparisonTotals },
): Promise<IpExportJob> {
  const rows = comparison.rows.map((r) => ({
    sku_code: r.sku_code,
    category: r.category_name ?? "",
    period: r.period_code,
    base_demand: r.base_demand,
    scenario_demand: r.scenario_demand,
    demand_delta: r.demand_delta,
    base_supply: r.base_supply,
    scenario_supply: r.scenario_supply,
    supply_delta: r.supply_delta,
    base_ending: r.base_ending,
    scenario_ending: r.scenario_ending,
    ending_delta: r.ending_delta,
    base_shortage: r.base_shortage,
    scenario_shortage: r.scenario_shortage,
    shortage_delta: r.shortage_delta,
    base_excess: r.base_excess,
    scenario_excess: r.scenario_excess,
    excess_delta: r.excess_delta,
    base_stockout: r.base_stockout,
    scenario_stockout: r.scenario_stockout,
    base_top_rec: r.base_top_rec ?? "",
    scenario_top_rec: r.scenario_top_rec ?? "",
  }));
  const totalsRows = [
    { metric: "base_row_count", value: comparison.totals.base_row_count },
    { metric: "scenario_row_count", value: comparison.totals.scenario_row_count },
    { metric: "demand_delta_sum", value: comparison.totals.demand_delta_sum },
    { metric: "supply_delta_sum", value: comparison.totals.supply_delta_sum },
    { metric: "shortage_delta_sum", value: comparison.totals.shortage_delta_sum },
    { metric: "excess_delta_sum", value: comparison.totals.excess_delta_sum },
    { metric: "stockouts_added", value: comparison.totals.stockouts_added },
    { metric: "stockouts_removed", value: comparison.totals.stockouts_removed },
    { metric: "recs_changed", value: comparison.totals.recs_changed },
  ];
  const wb = XLSXStyle.utils.book_new();
  XLSXStyle.utils.book_append_sheet(wb, sheet(totalsRows), "Totals");
  XLSXStyle.utils.book_append_sheet(wb, sheet(rows), "By SKU/Period");
  XLSXStyle.utils.book_append_sheet(wb, metaSheet({ run: ctx.run, exportType: "scenario_comparison", rowCount: rows.length }), "Meta");
  const fileName = `scenario_comparison_${slug(ctx.run.name)}_${today()}.xlsx`;
  download(wb, fileName);
  return recordExport(ctx, "scenario_comparison", fileName, rows.length);
}

function today(): string { return new Date().toISOString().slice(0, 10); }

// ── Isolated interface for future ERP writeback ───────────────────────────
// Phase 4 explicitly does NOT write back to the ERP. This is the seam
// where a Phase 6 adapter can plug in — keep the signature minimal so
// changes to either side don't ripple.
export interface ErpWritebackAdapter {
  pushBuyPlan(rows: Array<{ sku_id: string; qty: number; period_code: string }>): Promise<void>;
}
export const NO_OP_ERP_WRITEBACK: ErpWritebackAdapter = {
  async pushBuyPlan() { /* intentionally no-op */ },
};
