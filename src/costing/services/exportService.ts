// Costing Module — BOYS-style xlsx export.
//
// Builds the column schema that mirrors the BOYS sample CSV's grid view so an
// ExportButton on ProjectEditView can deliver an Excel file matching the
// original template. Column order: Picture, STYLE#, STYLE NAME, DESC, SIZE,
// FABRIC, FIT, COLOR, BOTTOM CLOSURE, WAIST, COMMENT, "7/1 DDP QTN", VENDOR,
// COST, SELL TARGET, SELL, MARGIN, PRICED DATE, LY COST, LY SOLD, LY MARGIN,
// REMARKS, TOTAL COST, TOTAL SALES.
//
// Margin is recomputed at export time via computeLineMath so the exported
// value matches what was displayed in the grid (cost cascades + tier rules).

import type { CostingLine, CostingLineVendor, CostingProject } from "../types";
import { computeLineMath } from "../hooks/useCostingMath";

export interface CostingExportRow {
  style_code: string;
  style_name: string;
  description: string;
  size_scale: string;
  fabric: string;
  fit: string;
  color: string;
  bottom_closure: string;
  waist_type: string;
  comment: string;
  target_qty: number | "";
  vendor: string;
  target_cost: number | "";
  sell_target: number | "";
  sell_price: number | "";
  margin_pct: number | "";
  priced_date: string;
  ly_unit_cost: number | "";
  ly_qty: number | "";
  ly_margin_pct: number | "";
  remarks: string;
  total_cost: number | "";
  total_sales: number | "";
}

function n(v: number | null | undefined): number {
  if (v == null) return 0;
  const x = typeof v === "number" ? v : Number(v);
  return isFinite(x) ? x : 0;
}

export function buildExportRows(
  lines: CostingLine[],
  vendorQuotesByLine: Record<string, CostingLineVendor[]>,
): CostingExportRow[] {
  return lines.map((line) => {
    const m = computeLineMath(line);
    const landed = m.landed_cost > 0 ? m.landed_cost : n(line.target_cost);
    const qty = n(line.target_qty);
    const sell = n(line.sell_price);
    const selectedQuote = (vendorQuotesByLine[line.id] || []).find((q) => q.status === "selected");
    const vendor = selectedQuote?.vendor?.legal_name || selectedQuote?.vendor?.code || "";

    return {
      style_code:    line.style_code || "",
      style_name:    line.style_name || "",
      description:   line.description || "",
      size_scale:    line.size_scale_label || "",
      fabric:        Array.isArray(line.fabric_codes) && line.fabric_codes.length > 0
                       ? line.fabric_codes.join(", ")
                       : (line.fabric_code || ""),
      fit:           line.fit || "",
      color:         line.color || "",
      bottom_closure: line.bottom_closure || "",
      waist_type:    line.waist_type || "",
      comment:       line.comment || "",
      target_qty:    qty || "",
      vendor,
      target_cost:   landed || (line.target_cost ?? ""),
      sell_target:   line.sell_target ?? "",
      sell_price:    line.sell_price ?? "",
      margin_pct:    m.margin_pct ?? line.margin_pct ?? "",
      priced_date:   line.priced_date || "",
      ly_unit_cost:  line.ly_unit_cost ?? "",
      ly_qty:        line.ly_qty ?? "",
      // ly_margin_pct is stored as a FRACTION (0.20 = 20%) — matches the grid,
      // which scales it ×100 for display. Scale here too so the "LY MARGIN %"
      // column isn't off by 100× (shows 20, not 0.2).
      ly_margin_pct: line.ly_margin_pct != null ? Math.round(line.ly_margin_pct * 100 * 100) / 100 : "",
      remarks:       line.remarks || "",
      total_cost:    qty && landed ? Math.round(qty * landed * 100) / 100 : "",
      total_sales:   qty && sell ? Math.round(qty * sell * 100) / 100 : "",
    };
  });
}

// Column schema for <ExportButton> — { key, header } matches the
// useTableExport contract; xlsx serializer formats numbers natively.
export const COSTING_EXPORT_COLUMNS = [
  { key: "style_code",     header: "STYLE#" },
  { key: "style_name",     header: "STYLE NAME" },
  { key: "description",    header: "DESC" },
  { key: "size_scale",     header: "SIZE" },
  { key: "fabric",         header: "FABRIC" },
  { key: "fit",            header: "FIT" },
  { key: "color",          header: "COLOR" },
  { key: "bottom_closure", header: "BOTTOM CLOSURE" },
  { key: "waist_type",     header: "WAIST" },
  { key: "comment",        header: "COMMENT" },
  { key: "target_qty",     header: "QTY (DDP QTN)" },
  { key: "vendor",         header: "VENDOR" },
  { key: "target_cost",    header: "COST" },
  { key: "sell_target",    header: "SELL TARGET" },
  { key: "sell_price",     header: "SELL" },
  { key: "margin_pct",     header: "MARGIN %" },
  { key: "priced_date",    header: "PRICED DATE" },
  { key: "ly_unit_cost",   header: "LY COST" },
  { key: "ly_qty",         header: "LY SOLD" },
  { key: "ly_margin_pct",  header: "LY MARGIN %" },
  { key: "remarks",        header: "REMARKS" },
  { key: "total_cost",     header: "TOTAL COST" },
  { key: "total_sales",    header: "TOTAL SALES" },
] as const;

// Column schema for <ExportButton>, gated by margin-export rights. Pass
// includeMargins=false (from useCanSeeMargins().canExport) to strip the two
// margin columns (MARGIN %, LY MARGIN %) so a caller without `margins:export`
// gets a file with no margin data. Defaults to TRUE for backward-compat — the
// exported COSTING_EXPORT_COLUMNS const remains the full, un-gated set.
const MARGIN_EXPORT_KEYS = new Set(["margin_pct", "ly_margin_pct"]);
export function costingExportColumns(includeMargins = true) {
  return includeMargins
    ? COSTING_EXPORT_COLUMNS
    : COSTING_EXPORT_COLUMNS.filter((c) => !MARGIN_EXPORT_KEYS.has(c.key));
}

// Footer totals for the grid (sum qty, weighted margin, sum cost, sum sales).
// includeMargins=false zeroes the weighted-margin footer so it never lands in a
// no-margin export; default TRUE preserves prior behavior.
export function computeExportTotals(rows: CostingExportRow[], includeMargins = true) {
  let totalQty = 0, totalCost = 0, totalSales = 0;
  for (const r of rows) {
    if (typeof r.target_qty === "number") totalQty += r.target_qty;
    if (typeof r.total_cost === "number") totalCost += r.total_cost;
    if (typeof r.total_sales === "number") totalSales += r.total_sales;
  }
  const weightedMargin = includeMargins && totalSales > 0 ? ((totalSales - totalCost) / totalSales) * 100 : 0;
  return {
    totalQty,
    totalCost: Math.round(totalCost * 100) / 100,
    totalSales: Math.round(totalSales * 100) / 100,
    weightedMargin: Math.round(weightedMargin * 100) / 100,
  };
}

export function buildExportFilename(project: CostingProject | null): string {
  if (!project) return "costing-project";
  const safe = project.project_name.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return `costing-${safe || "project"}`;
}
