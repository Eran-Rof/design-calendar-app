// Excel export of styles the totals row had to skip — i.e. SKUs with
// NO open SOs (no implied sale price), NO inventory avg cost, and NO
// open PO cost data. The planner uses this to chase down items that
// can't be costed or priced and therefore distort margin reporting.

import type { ATSRow, ATSPoEvent, ATSSoEvent } from "./types";
import { fmtDate } from "./helpers";
import {
  PALETTE, ROW_HEIGHTS,
  headerStyle, bodyTextStyle, bodyNumStyle, bodyStyleStyle,
  autofitColumns, applyOutlines, buildWorkbook, zebraFill, numOrBlank,
} from "./exportTheme";
import type { ReportPayload } from "./reportPayload";

type EventIndex = Record<string, Record<string, { pos: ATSPoEvent[]; sos: ATSSoEvent[] }>>;

export interface IncompleteSkusResult {
  count: number;
  payload: ReportPayload;
}

export function exportIncompleteSkus(
  filtered: ATSRow[],
  eventIndex: EventIndex | null,
): IncompleteSkusResult {
  // Per-SKU presence flags from event index
  const hasSO = new Set<string>();
  const hasPOCost = new Set<string>();
  if (eventIndex) {
    for (const sku of Object.keys(eventIndex)) {
      for (const buckets of Object.values(eventIndex[sku])) {
        if (!hasSO.has(sku)) {
          for (const so of buckets.sos) {
            const v = so.totalPrice || (so.unitPrice * so.qty) || 0;
            if (so.qty > 0 && v > 0) { hasSO.add(sku); break; }
          }
        }
        if (!hasPOCost.has(sku)) {
          for (const po of buckets.pos) {
            if (po.qty > 0 && po.unitCost > 0) { hasPOCost.add(sku); break; }
          }
        }
      }
    }
  }

  // Pre-aggregate avgCost across all store rows for each SKU. A SKU's
  // ROF row may carry a real avgCost while its ROF ECOM row carries 0;
  // checking only the first row encountered would falsely flag the
  // SKU as missing cost data.
  const hasAvgCost = new Set<string>();
  for (const r of filtered) {
    if (r.avgCost && r.avgCost > 0) hasAvgCost.add(r.sku);
  }

  // Pick SKUs where every signal is missing. Dedupe on SKU so each
  // appears once even when present across multiple stores.
  const seen = new Set<string>();
  const incomplete: ATSRow[] = [];
  for (const r of filtered) {
    if (seen.has(r.sku)) continue;
    if (!hasAvgCost.has(r.sku) && !hasSO.has(r.sku) && !hasPOCost.has(r.sku)) {
      seen.add(r.sku);
      incomplete.push(r);
    }
  }

  // Column layout — SKU (treated as the "style" col with bold navy
  // accent), Description, Category, Sub Cat, Color, Store, On Hand,
  // On Order, On PO. The first six get the standard text-header tier;
  // the three quantity cols get the dark tier matching the family.
  const headers = [
    { label: "SKU",         fill: PALETTE.HEADER_TEXT,   align: "left"   as const },
    { label: "Description", fill: PALETTE.HEADER_TEXT,   align: "left"   as const },
    { label: "Category",    fill: PALETTE.HEADER_TEXT,   align: "left"   as const },
    { label: "Sub Cat",     fill: PALETTE.HEADER_TEXT,   align: "left"   as const },
    { label: "Color",       fill: PALETTE.HEADER_TEXT,   align: "left"   as const },
    { label: "Warehouse",       fill: PALETTE.HEADER_TEXT,   align: "left"   as const },
    { label: "On Hand",     fill: PALETTE.HEADER_ONHAND, align: "center" as const },
    { label: "On Order",    fill: PALETTE.HEADER_DARK,   align: "center" as const },
    { label: "On PO",       fill: PALETTE.HEADER_DARK,   align: "center" as const },
  ];
  const headerRow: any[] = headers.map((h) => ({
    v: h.label, t: "s", s: headerStyle(h.fill, h.align),
  }));

  const bodyRows: any[][] = [];

  if (incomplete.length === 0) {
    // Single status row so the workbook is never empty — operators
    // expect a download every time they click.
    const fill = zebraFill(0);
    const okStyle: any = {
      ...bodyTextStyle(fill, "left"),
      font: { sz: 11, italic: true, color: { rgb: "047857" }, name: "Calibri" },
    };
    bodyRows.push([
      { v: "— None —",                                           t: "s", s: okStyle },
      { v: "All filtered SKUs have an SO, avg cost, or PO cost.", t: "s", s: okStyle },
      { v: "", t: "s", s: bodyTextStyle(fill, "left") },
      { v: "", t: "s", s: bodyTextStyle(fill, "left") },
      { v: "", t: "s", s: bodyTextStyle(fill, "left") },
      { v: "", t: "s", s: bodyTextStyle(fill, "left") },
      { v: "", t: "s", s: bodyNumStyle(PALETTE.QTY_BAND) },
      { v: "", t: "s", s: bodyNumStyle(PALETTE.QTY_BAND) },
      { v: "", t: "s", s: bodyNumStyle(PALETTE.QTY_BAND) },
    ]);
  } else {
    incomplete.forEach((r, ri) => {
      const fill = zebraFill(ri);
      bodyRows.push([
        { v: r.sku,                                          t: "s", s: bodyStyleStyle(fill) },
        { v: r.description ?? "",                            t: "s", s: bodyTextStyle(fill, "left") },
        { v: r.master_category ?? r.category ?? "",          t: "s", s: bodyTextStyle(fill, "left") },
        { v: r.master_sub_category ?? "",                    t: "s", s: bodyTextStyle(fill, "left") },
        { v: r.master_color ?? "",                           t: "s", s: bodyTextStyle(fill, "left") },
        { v: r.store ?? "ROF",                               t: "s", s: bodyTextStyle(fill, "left") },
        numOrBlank(r.onHand  ?? 0, bodyNumStyle(PALETTE.QTY_BAND)),
        numOrBlank(r.onOrder ?? 0, bodyNumStyle(PALETTE.QTY_BAND)),
        numOrBlank(r.onPO    ?? 0, bodyNumStyle(PALETTE.QTY_BAND)),
      ]);
    });
  }

  const allRows = [headerRow, ...bodyRows];
  applyOutlines({ allRows, totalColCount: headers.length });

  const cols = autofitColumns({ headerRow, bodyRows });
  const rowHeights = [
    { hpt: ROW_HEIGHTS.HEADER },
    ...bodyRows.map(() => ({ hpt: ROW_HEIGHTS.BODY })),
  ];

  const filename = `Incomplete_Styles_${fmtDate(new Date())}.xlsx`;
  const { wb } = buildWorkbook({
    allRows,
    sheetName: "Incomplete Styles",
    filename,
    cols,
    rowHeights,
  });

  return {
    count: incomplete.length,
    payload: {
      title: "Incomplete SKUs",
      aoa: allRows,
      wb,
      filename,
    },
  };
}
