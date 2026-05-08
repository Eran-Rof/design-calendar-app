// Excel export of styles the totals row had to skip — i.e. SKUs with
// NO open SOs (no implied sale price), NO inventory avg cost, and NO
// open PO cost data. The planner uses this to chase down items that
// can't be costed or priced and therefore distort margin reporting.

import XLSXStyle from "xlsx-js-style";
import type { ATSRow, ATSPoEvent, ATSSoEvent } from "./types";
import { fmtDate } from "./helpers";

type EventIndex = Record<string, Record<string, { pos: ATSPoEvent[]; sos: ATSSoEvent[] }>>;

export function exportIncompleteSkus(
  filtered: ATSRow[],
  eventIndex: EventIndex | null,
): { count: number } {
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

  // Empty result is still a download. Operators kept clicking expecting
  // a workbook and getting a blocking alert; replace it with a one-row
  // status sheet so the click always produces the expected file. Caller
  // can still react to count===0 if it wants to surface a softer toast.
  const HDR: any = {
    font: { bold: true, color: { rgb: "FFFFFF" }, sz: 11, name: "Calibri" },
    fill: { fgColor: { rgb: "B91C1C" }, patternType: "solid" },
    alignment: { horizontal: "center", vertical: "center" },
    border: {
      top: { style: "thin", color: { rgb: "7F1D1D" } },
      bottom: { style: "medium", color: { rgb: "7F1D1D" } },
      left: { style: "thin", color: { rgb: "7F1D1D" } },
      right: { style: "thin", color: { rgb: "7F1D1D" } },
    },
  };
  const cell: any = {
    alignment: { horizontal: "left", vertical: "center" },
    border: { left: { style: "thin", color: { rgb: "D0D8E4" } }, right: { style: "thin", color: { rgb: "D0D8E4" } } },
  };
  const cellNum: any = { ...cell, alignment: { horizontal: "right", vertical: "center" } };

  const headers = ["SKU", "Description", "Category", "Sub Cat", "Color", "Store", "On Hand", "On Order", "On PO"];
  const aoa: any[][] = [headers.map((h) => ({ v: h, s: HDR }))];
  if (incomplete.length === 0) {
    // Single status row spanning into the SKU column so the workbook
    // is never empty. Lets the operator file/share the run even on
    // a clean snapshot.
    const okStyle: any = {
      ...cell,
      font: { italic: true, color: { rgb: "047857" } },
      alignment: { horizontal: "left", vertical: "center" },
    };
    aoa.push([
      { v: "— None —", s: okStyle },
      { v: "All filtered SKUs have an SO, avg cost, or PO cost.", s: okStyle },
      { v: "", s: cell }, { v: "", s: cell }, { v: "", s: cell },
      { v: "", s: cell }, { v: "", s: cellNum }, { v: "", s: cellNum }, { v: "", s: cellNum },
    ]);
  } else {
    for (const r of incomplete) {
      aoa.push([
        { v: r.sku, s: cell },
        { v: r.description ?? "", s: cell },
        { v: r.master_category ?? r.category ?? "", s: cell },
        { v: r.master_sub_category ?? "", s: cell },
        { v: r.master_color ?? "", s: cell },
        { v: r.store ?? "ROF", s: cell },
        { v: r.onHand ?? 0, s: cellNum },
        { v: r.onOrder ?? 0, s: cellNum },
        { v: r.onPO ?? 0, s: cellNum },
      ]);
    }
  }

  const ws = (XLSXStyle.utils.aoa_to_sheet as any)(aoa, { skipHeader: true });
  ws["!cols"] = [
    { wch: 22 }, { wch: 36 }, { wch: 16 }, { wch: 16 }, { wch: 14 },
    { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 },
  ];
  ws["!freeze"] = { xSplit: 0, ySplit: 1 };

  const wb = XLSXStyle.utils.book_new();
  XLSXStyle.utils.book_append_sheet(wb, ws, "Incomplete Styles");
  const buf = XLSXStyle.write(wb, { bookType: "xlsx", type: "array" });
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `Incomplete_Styles_${fmtDate(new Date())}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
  return { count: incomplete.length };
}
