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

import type { ATSRow, ATSPoEvent, ATSSoEvent } from "./types";
import { fmtDate, fmtDateDisplay } from "./helpers";
import {
  PALETTE, ROW_HEIGHTS, colLetter,
  headerStyle, bodyTextStyle, bodyNumStyle, bodyStyleStyle,
  subtotalTextStyle, subtotalNumStyle,
  autofitColumns, applyOutlines, buildWorkbook, zebraFill, numOrBlank,
} from "./exportTheme";
import type { ReportPayload } from "./reportPayload";

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

export type StockVsSoResult =
  | { kind: "no-events" }
  | { kind: "no-orders" }
  | { kind: "ok"; rows: number; payload: ReportPayload };

export function exportStockVsSo(
  filtered: ATSRow[],
  eventIndex: EventIndex | null,
): StockVsSoResult {
  if (!eventIndex) {
    return { kind: "no-events" };
  }

  const reports: SoLineReport[] = [];

  for (const r of filtered) {
    const skuEvents = eventIndex[r.sku];
    if (!skuEvents) continue;
    const store = r.store ?? "ROF";

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

    let stockLeft = r.onHand || 0;
    const poRemaining = allPOs.map((po) => ({ po, left: po.qty }));

    const { base, color } = splitSku(r.sku);

    for (const so of allSOs) {
      let need = so.qty;
      let fromStock = 0;
      let fromPO = 0;
      const contributingPOSet = new Set<string>();

      if (stockLeft > 0 && need > 0) {
        const take = Math.min(stockLeft, need);
        stockLeft -= take;
        fromStock += take;
        need -= take;
      }

      if (need > 0) {
        for (const slot of poRemaining) {
          if (slot.left <= 0) continue;
          if (slot.po.date > so.date) break;
          const take = Math.min(slot.left, need);
          slot.left -= take;
          fromPO += take;
          need -= take;
          if (slot.po.poNumber) contributingPOSet.add(slot.po.poNumber);
          if (need <= 0) break;
        }
      }

      const newPO = need;
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
    return { kind: "no-orders" };
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

  // ── Status fill / font (semantic — kept) ─────────────────────────────────
  // Green / yellow / orange / red triage colors. The body cells around
  // the Status cell still pick up the zebra fill — only the Status cell
  // itself flashes the triage color.
  const statusFill = (status: SoLineReport["status"]): string =>
    status === "From Stock"        ? "C6EFCE" :
    status === "From Incoming PO"  ? "FFF2CC" :
    status === "Mixed"             ? "FCE4D6" :
                                     "FFC7CE";
  const statusFont = (status: SoLineReport["status"]): string =>
    status === "From Stock"        ? "006100" :
    status === "From Incoming PO"  ? "9C5700" :
    status === "Mixed"             ? "9C4D00" :
                                     "9C0006";
  const NEEDS_PO_RED = "9C0006";

  // ── Header row ──────────────────────────────────────────────────────────
  const headers = [
    { label: "Status",            fill: PALETTE.HEADER_DARK,   align: "center" as const },
    { label: "Base Part",         fill: PALETTE.HEADER_TEXT,   align: "left"   as const },
    { label: "Color",             fill: PALETTE.HEADER_TEXT,   align: "left"   as const },
    { label: "SKU",               fill: PALETTE.HEADER_TEXT,   align: "left"   as const },
    { label: "Description",       fill: PALETTE.HEADER_TEXT,   align: "left"   as const },
    { label: "Category",          fill: PALETTE.HEADER_TEXT,   align: "left"   as const },
    { label: "Warehouse",             fill: PALETTE.HEADER_TEXT,   align: "left"   as const },
    { label: "Customer",          fill: PALETTE.HEADER_TEXT,   align: "left"   as const },
    { label: "Order #",           fill: PALETTE.HEADER_TEXT,   align: "left"   as const },
    { label: "Ship Date",         fill: PALETTE.HEADER_TEXT,   align: "center" as const },
    { label: "Qty Ordered",       fill: PALETTE.HEADER_ONHAND, align: "center" as const },
    { label: "From Stock",        fill: PALETTE.HEADER_DARK,   align: "center" as const },
    { label: "From Incoming PO",  fill: PALETTE.HEADER_DARK,   align: "center" as const },
    { label: "Needs New PO",      fill: PALETTE.HEADER_DARK,   align: "center" as const },
    { label: "Contributing POs",  fill: PALETTE.HEADER_TEXT,   align: "left"   as const },
  ];
  const headerRow: any[] = headers.map((h) => ({
    v: h.label, t: "s", s: headerStyle(h.fill, h.align),
  }));

  // ── Body rows ───────────────────────────────────────────────────────────
  const bodyRows: any[][] = [];
  reports.forEach((r, ri) => {
    const fill = zebraFill(ri);
    const statusStyle: any = {
      ...bodyTextStyle(fill, "center"),
      font: { sz: 11, bold: true, color: { rgb: statusFont(r.status) }, name: "Calibri" },
      fill: { fgColor: { rgb: statusFill(r.status) }, patternType: "solid" },
    };
    // Highlight Needs-New-PO qty cell in red when > 0 so it pops in the
    // triage scan even before the analyst sorts.
    const newPoStyle: any = r.qtyNewPO > 0
      ? {
          ...bodyNumStyle(PALETTE.QTY_BAND),
          font: { sz: 11, bold: true, color: { rgb: NEEDS_PO_RED }, name: "Calibri" },
        }
      : bodyNumStyle(PALETTE.QTY_BAND);

    bodyRows.push([
      { v: r.status,          t: "s", s: statusStyle },
      { v: r.basePart,        t: "s", s: bodyStyleStyle(fill) },
      { v: r.color,           t: "s", s: bodyTextStyle(fill, "left") },
      { v: r.sku,             t: "s", s: bodyTextStyle(fill, "left") },
      { v: r.description,     t: "s", s: bodyTextStyle(fill, "left") },
      { v: r.category,        t: "s", s: bodyTextStyle(fill, "left") },
      { v: r.store,           t: "s", s: bodyTextStyle(fill, "left") },
      { v: r.customerName,    t: "s", s: bodyTextStyle(fill, "left") },
      { v: r.orderNumber,     t: "s", s: bodyTextStyle(fill, "left") },
      { v: fmtDateDisplay(r.shipDate),        t: "s", s: bodyTextStyle(fill, "center") },
      numOrBlank(r.qtyOrdered,   bodyNumStyle(PALETTE.QTY_BAND)),
      numOrBlank(r.qtyFromStock, bodyNumStyle(PALETTE.QTY_BAND)),
      numOrBlank(r.qtyFromPO,    bodyNumStyle(PALETTE.QTY_BAND)),
      numOrBlank(r.qtyNewPO,     newPoStyle),
      { v: r.contributingPOs, t: "s", s: bodyTextStyle(fill, "left") },
    ]);
  });

  // ── Summary block ──────────────────────────────────────────────────────
  // Single empty separator row, then a "Summary" sub-header (HEADER_DARK
  // band spanning the full width), then a stack of label/value rows.
  // Status-counted lines pick up their triage color; the "needs new"
  // metrics render in red bold (semantic).
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

  const blankRow: any[] = new Array(headers.length).fill(null).map(() => ({ v: "", t: "s", s: bodyTextStyle(PALETTE.ZEBRA_ODD) }));
  bodyRows.push(blankRow);

  const summaryHeaderRow: any[] = new Array(headers.length).fill(null).map((_, ci) => ({
    v: ci === 0 ? "Summary" : "",
    t: "s",
    s: headerStyle(PALETTE.HEADER_DARK, "left"),
  }));
  bodyRows.push(summaryHeaderRow);

  function pushSummary(label: string, value: number, red = false) {
    const row: any[] = new Array(headers.length).fill(null).map(() => ({ v: "", t: "s", s: subtotalTextStyle() }));
    const labelStyle: any = red
      ? { ...subtotalTextStyle(), font: { sz: 12.1, bold: true, color: { rgb: NEEDS_PO_RED }, name: "Calibri" } }
      : subtotalTextStyle();
    const valueStyle: any = red
      ? { ...subtotalNumStyle(), font: { sz: 12.1, bold: true, color: { rgb: NEEDS_PO_RED }, name: "Calibri" } }
      : subtotalNumStyle();
    row[0] = { v: label, t: "s", s: labelStyle };
    row[1] = numOrBlank(value, valueStyle);
    bodyRows.push(row);
  }

  pushSummary("Total SO lines",                  totals.lines);
  pushSummary("From Stock (lines)",              totals.byStatus["From Stock"]       ?? 0);
  pushSummary("From Incoming PO (lines)",        totals.byStatus["From Incoming PO"] ?? 0);
  pushSummary("Mixed (lines)",                   totals.byStatus["Mixed"]            ?? 0);
  pushSummary("Needs New PO (lines)",            totals.byStatus["Needs New PO"]     ?? 0, true);
  pushSummary("Total Qty Ordered",               totals.qtyOrdered);
  pushSummary("Qty fillable from Stock",         totals.fromStock);
  pushSummary("Qty fillable from incoming POs",  totals.fromPO);
  pushSummary("Qty needing new POs",             totals.newPO, true);

  // ── Outlines ──────────────────────────────────────────────────────────
  // Outer rectangle around the whole sheet; no style-group outlining
  // (each report row is its own thing — no aggregation).
  const allRows = [headerRow, ...bodyRows];
  applyOutlines({ allRows, totalColCount: headers.length });

  // ── Cols + row heights ────────────────────────────────────────────────
  const cols = autofitColumns({ headerRow, bodyRows });
  const rowHeights: Array<{ hpt: number }> = [{ hpt: ROW_HEIGHTS.HEADER }];
  for (let i = 0; i < bodyRows.length; i++) {
    // Summary block lines (after the blank row + summary header) get
    // SUBTOTAL height for the value rows; the summary header itself
    // gets HEADER height; blank separator gets BODY height.
    const r = bodyRows[i];
    const isBlank = r.every((c) => !c?.v);
    const isSummaryHdr = r[0]?.v === "Summary";
    const isSummaryRow = i > reports.length + 1; // after data rows + blank + summary hdr
    if (isBlank) rowHeights.push({ hpt: ROW_HEIGHTS.BODY });
    else if (isSummaryHdr) rowHeights.push({ hpt: ROW_HEIGHTS.HEADER });
    else if (isSummaryRow) rowHeights.push({ hpt: ROW_HEIGHTS.SUBTOTAL });
    else rowHeights.push({ hpt: ROW_HEIGHTS.BODY });
  }

  // Autofilter spans only the report table (header + data rows), not
  // the summary block — applying filter past the table boundary in
  // Excel produces awkward dropdown behavior on the summary key/value
  // rows.
  const lastDataAoaRow = 1 + reports.length;  // Excel 1-based: header row 1, data rows 2..N+1
  const lastColLetter = colLetter(headers.length);

  const filename = `Stock_Vs_SO_${fmtDate(new Date())}.xlsx`;
  const { wb } = buildWorkbook({
    allRows,
    sheetName: "Stock Vs SO",
    filename,
    cols,
    rowHeights,
    autofilter: `A1:${lastColLetter}${lastDataAoaRow}`,
    freeze: { xSplit: 0, ySplit: 1 },
  });

  return {
    kind: "ok",
    rows: reports.length,
    payload: {
      title: "Stock vs Sales Orders",
      aoa: allRows,
      wb,
      filename,
    },
  };
}
