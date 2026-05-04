// Excel export: "Stock Vs SO".
//
// For every open Sales Order line in scope, allocates supply in this
// order and reports how much of the line is covered by each source:
//
//   1. On-hand stock (the SKU's current inventory pool)
//   2. Open POs that arrive on or before the SO's ship date
//   3. Whatever's left → needs a NEW PO
//
// Allocation is FIFO across SOs sorted by ship date so earlier orders
// consume stock + early POs first. POs land in date order too. The
// generated workbook has one row per SO line with a clear status
// ("From Stock" / "From Incoming PO" / "Needs New PO" / a mix), the
// quantity break-down, and which PO numbers contribute when relevant.

import XLSXStyle from "xlsx-js-style";
import type { ATSRow, ATSPoEvent, ATSSoEvent } from "./types";
import { fmtDate } from "./helpers";

type EventIndex = Record<string, Record<string, { pos: ATSPoEvent[]; sos: ATSSoEvent[] }>>;

interface SoLineReport {
  sku: string;
  basePart: string;
  color: string;
  description: string;
  category: string;
  store: string;
  customerName: string;
  orderNumber: string;
  shipDate: string;
  qtyOrdered: number;
  qtyFromStock: number;
  qtyFromPO: number;
  qtyNewPO: number;
  contributingPOs: string;       // comma-separated PO numbers used
  status: "From Stock" | "From Incoming PO" | "Mixed" | "Needs New PO";
}

// "RBB1042 - Black" → { base: "RBB1042", color: "Black" }
function splitSku(sku: string): { base: string; color: string } {
  const idx = sku.indexOf(" - ");
  if (idx < 0) return { base: sku, color: "" };
  return { base: sku.slice(0, idx).trim(), color: sku.slice(idx + 3).trim() };
}

export function exportStockVsSo(
  filtered: ATSRow[],
  eventIndex: EventIndex | null,
): { rows: number } {
  if (!eventIndex) {
    alert("No event data loaded — open the ATS report and let the data finish loading first.");
    return { rows: 0 };
  }

  // Index filtered rows by SKU::store so we can read on_hand / metadata.
  const rowKey = (r: ATSRow) => `${r.sku}::${r.store ?? "ROF"}`;
  const rowByKey = new Map<string, ATSRow>();
  for (const r of filtered) rowByKey.set(rowKey(r), r);

  const reports: SoLineReport[] = [];

  // Walk every (SKU, store) bucket the user has in scope. Allocation is
  // bucket-local: stock and POs for store=ROF cover SOs for store=ROF
  // but not for ROF ECOM (which has its own pool — same constraint the
  // grid uses).
  for (const r of filtered) {
    const skuEvents = eventIndex[r.sku];
    if (!skuEvents) continue;
    const store = r.store ?? "ROF";

    // Gather all POs and SOs for this SKU+store, sorted by date.
    const allPOs: ATSPoEvent[] = [];
    const allSOs: ATSSoEvent[] = [];
    for (const buckets of Object.values(skuEvents)) {
      for (const po of buckets.pos) {
        if ((po.store ?? "ROF") !== store) continue;
        if (po.qty > 0 && po.date) allPOs.push(po);
      }
      for (const so of buckets.sos) {
        if ((so.store ?? "ROF") !== store) continue;
        if (so.qty > 0 && so.date) allSOs.push(so);
      }
    }
    if (allSOs.length === 0) continue;

    allSOs.sort((a, b) => a.date.localeCompare(b.date));
    allPOs.sort((a, b) => a.date.localeCompare(b.date));

    // Mutable supply pools — `stockLeft` is the current inventory; each
    // PO has a remaining qty that gets drawn down as it covers SOs.
    let stockLeft = r.onHand || 0;
    const poRemaining = allPOs.map((po) => ({ po, left: po.qty }));

    const { base, color } = splitSku(r.sku);

    for (const so of allSOs) {
      let need = so.qty;
      let fromStock = 0;
      let fromPO = 0;
      const contributingPOSet = new Set<string>();

      // 1. Burn stock first.
      if (stockLeft > 0 && need > 0) {
        const take = Math.min(stockLeft, need);
        stockLeft -= take;
        fromStock += take;
        need -= take;
      }

      // 2. Burn POs that land on or before this SO's ship date.
      if (need > 0) {
        for (const slot of poRemaining) {
          if (slot.left <= 0) continue;
          if (slot.po.date > so.date) break; // sorted, nothing later qualifies either
          const take = Math.min(slot.left, need);
          slot.left -= take;
          fromPO += take;
          need -= take;
          if (slot.po.poNumber) contributingPOSet.add(slot.po.poNumber);
          if (need <= 0) break;
        }
      }

      const newPO = need; // anything still uncovered
      const status: SoLineReport["status"] =
        fromStock > 0 && fromPO === 0 && newPO === 0 ? "From Stock"
        : fromStock === 0 && fromPO > 0 && newPO === 0 ? "From Incoming PO"
        : newPO > 0 && fromStock === 0 && fromPO === 0 ? "Needs New PO"
        : "Mixed";

      reports.push({
        sku: r.sku,
        basePart: base,
        color,
        description: r.description ?? "",
        category: r.master_category ?? r.category ?? "",
        store,
        customerName: so.customerName ?? "",
        orderNumber: so.orderNumber ?? "",
        shipDate: so.date,
        qtyOrdered: so.qty,
        qtyFromStock: fromStock,
        qtyFromPO: fromPO,
        qtyNewPO: newPO,
        contributingPOs: Array.from(contributingPOSet).sort().join(", "),
        status,
      });
    }
  }

  if (reports.length === 0) {
    alert("No open SOs in the filtered set to report on.");
    return { rows: 0 };
  }

  // Sort the report: status (worst first — Needs New PO), then customer, ship date.
  const statusOrder: Record<SoLineReport["status"], number> = {
    "Needs New PO": 0,
    "Mixed": 1,
    "From Incoming PO": 2,
    "From Stock": 3,
  };
  reports.sort((a, b) => {
    const so = statusOrder[a.status] - statusOrder[b.status];
    if (so !== 0) return so;
    const c = a.customerName.localeCompare(b.customerName);
    if (c !== 0) return c;
    return a.shipDate.localeCompare(b.shipDate);
  });

  // ── Workbook ───────────────────────────────────────────────────────
  const HDR: any = {
    font: { bold: true, color: { rgb: "FFFFFF" }, sz: 11, name: "Calibri" },
    fill: { fgColor: { rgb: "1F497D" }, patternType: "solid" },
    alignment: { horizontal: "center", vertical: "center", wrapText: true },
    border: {
      top:    { style: "thin",   color: { rgb: "1F497D" } },
      bottom: { style: "medium", color: { rgb: "1F497D" } },
      left:   { style: "thin",   color: { rgb: "1F497D" } },
      right:  { style: "thin",   color: { rgb: "1F497D" } },
    },
  };
  const cellEvenL: any = {
    font: { sz: 10, name: "Calibri" },
    fill: { fgColor: { rgb: "EEF3FA" }, patternType: "solid" },
    alignment: { horizontal: "left", vertical: "center" },
    border: { left: { style: "thin", color: { rgb: "D0D8E4" } }, right: { style: "thin", color: { rgb: "D0D8E4" } } },
  };
  const cellOddL: any = {
    font: { sz: 10, name: "Calibri" },
    fill: { fgColor: { rgb: "FFFFFF" }, patternType: "solid" },
    alignment: { horizontal: "left", vertical: "center" },
    border: { left: { style: "thin", color: { rgb: "D0D8E4" } }, right: { style: "thin", color: { rgb: "D0D8E4" } } },
  };
  const cellEvenN: any = { ...cellEvenL, alignment: { horizontal: "right", vertical: "center" } };
  const cellOddN:  any = { ...cellOddL,  alignment: { horizontal: "right", vertical: "center" } };
  const statusFill = (status: SoLineReport["status"]): string =>
    status === "From Stock"        ? "C6EFCE" :
    status === "From Incoming PO"  ? "FFF2CC" :
    status === "Mixed"             ? "FCE4D6" :
                                     "FFC7CE";  // Needs New PO
  const statusFont = (status: SoLineReport["status"]): string =>
    status === "From Stock"        ? "006100" :
    status === "From Incoming PO"  ? "9C5700" :
    status === "Mixed"             ? "9C4D00" :
                                     "9C0006";  // Needs New PO

  const headers = [
    "Status", "Base Part", "Color", "SKU", "Description", "Category", "Store",
    "Customer", "Order #", "Ship Date", "Qty Ordered",
    "From Stock", "From Incoming PO", "Needs New PO", "Contributing POs",
  ];
  const aoa: any[][] = [headers.map((h) => ({ v: h, s: HDR }))];

  for (let i = 0; i < reports.length; i++) {
    const r = reports[i];
    const even = i % 2 === 0;
    const L = even ? cellEvenL : cellOddL;
    const N = even ? cellEvenN : cellOddN;
    const statusStyle: any = {
      ...L,
      font: { ...L.font, bold: true, color: { rgb: statusFont(r.status) } },
      fill: { fgColor: { rgb: statusFill(r.status) }, patternType: "solid" },
      alignment: { horizontal: "center", vertical: "center" },
    };
    aoa.push([
      { v: r.status, s: statusStyle },
      { v: r.basePart, s: L },
      { v: r.color, s: L },
      { v: r.sku, s: L },
      { v: r.description, s: L },
      { v: r.category, s: L },
      { v: r.store, s: L },
      { v: r.customerName, s: L },
      { v: r.orderNumber, s: L },
      { v: r.shipDate, s: L },
      { v: r.qtyOrdered, s: N, t: "n" },
      { v: r.qtyFromStock, s: N, t: "n" },
      { v: r.qtyFromPO, s: N, t: "n" },
      { v: r.qtyNewPO, s: { ...N, font: { ...N.font, bold: r.qtyNewPO > 0, color: r.qtyNewPO > 0 ? { rgb: "9C0006" } : undefined } }, t: "n" },
      { v: r.contributingPOs, s: L },
    ]);
  }

  // ── Summary block at the bottom (one row per status) ────────────
  const totals = reports.reduce(
    (acc, r) => {
      acc.qtyOrdered += r.qtyOrdered;
      acc.fromStock  += r.qtyFromStock;
      acc.fromPO     += r.qtyFromPO;
      acc.newPO      += r.qtyNewPO;
      acc.lines      += 1;
      acc.byStatus[r.status] = (acc.byStatus[r.status] ?? 0) + 1;
      return acc;
    },
    { qtyOrdered: 0, fromStock: 0, fromPO: 0, newPO: 0, lines: 0, byStatus: {} as Record<string, number> },
  );

  const summaryHdr: any = { ...HDR, fill: { fgColor: { rgb: "305496" }, patternType: "solid" } };
  const sumLabel: any  = { ...cellEvenL, font: { sz: 11, bold: true, color: { rgb: "1F497D" } } };
  const sumValue: any  = { ...cellEvenN, font: { sz: 11, bold: true, color: { rgb: "1F497D" } } };

  aoa.push([]);
  aoa.push([{ v: "Summary", s: summaryHdr }]);
  aoa.push([
    { v: "Total SO lines",         s: sumLabel },
    { v: totals.lines,             s: sumValue, t: "n" },
  ]);
  aoa.push([
    { v: "From Stock (lines)",     s: sumLabel },
    { v: totals.byStatus["From Stock"]       ?? 0, s: sumValue, t: "n" },
  ]);
  aoa.push([
    { v: "From Incoming PO (lines)", s: sumLabel },
    { v: totals.byStatus["From Incoming PO"] ?? 0, s: sumValue, t: "n" },
  ]);
  aoa.push([
    { v: "Mixed (lines)",          s: sumLabel },
    { v: totals.byStatus["Mixed"]            ?? 0, s: sumValue, t: "n" },
  ]);
  aoa.push([
    { v: "Needs New PO (lines)",   s: { ...sumLabel, font: { ...sumLabel.font, color: { rgb: "9C0006" } } } },
    { v: totals.byStatus["Needs New PO"]     ?? 0, s: { ...sumValue, font: { ...sumValue.font, color: { rgb: "9C0006" } } }, t: "n" },
  ]);
  aoa.push([
    { v: "Total Qty Ordered",      s: sumLabel },
    { v: totals.qtyOrdered, s: sumValue, t: "n" },
  ]);
  aoa.push([
    { v: "Qty fillable from Stock", s: sumLabel },
    { v: totals.fromStock,         s: sumValue, t: "n" },
  ]);
  aoa.push([
    { v: "Qty fillable from incoming POs", s: sumLabel },
    { v: totals.fromPO,            s: sumValue, t: "n" },
  ]);
  aoa.push([
    { v: "Qty needing new POs",    s: { ...sumLabel, font: { ...sumLabel.font, color: { rgb: "9C0006" } } } },
    { v: totals.newPO,             s: { ...sumValue, font: { ...sumValue.font, color: { rgb: "9C0006" } } }, t: "n" },
  ]);

  const ws = (XLSXStyle.utils.aoa_to_sheet as any)(aoa, { skipHeader: true });
  ws["!cols"] = [
    { wch: 18 }, { wch: 16 }, { wch: 14 }, { wch: 22 }, { wch: 32 }, { wch: 14 }, { wch: 10 },
    { wch: 26 }, { wch: 14 }, { wch: 12 }, { wch: 12 },
    { wch: 12 }, { wch: 16 }, { wch: 14 }, { wch: 24 },
  ];
  ws["!freeze"] = { xSplit: 0, ySplit: 1 };
  ws["!autofilter"] = { ref: `A1:O${reports.length + 1}` };

  const wb = XLSXStyle.utils.book_new();
  XLSXStyle.utils.book_append_sheet(wb, ws, "Stock Vs SO");
  const buf = XLSXStyle.write(wb, { bookType: "xlsx", type: "array" });
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `Stock_Vs_SO_${fmtDate(new Date())}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
  return { rows: reports.length };
}
