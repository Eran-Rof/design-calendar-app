import XLSXStyle from "xlsx-js-style";
import type { ATSRow } from "./types";
import { fmtDate, displayColor } from "./helpers";
import type { GridTotals } from "./computeTotals";

// Excel export — fixed 18-column layout matching the planner's
// reference CSV exactly. NO PPK rows, NO merges, NO rich text. Plain
// numbers everywhere. The on-screen grid still shows the PPK hint;
// the export is a clean tabular dump.
//
// Layout (18 cols when periods=5):
//   A  Category               header #3278CC, body left
//   B  Sub Cat                header #3278CC, body left
//   C  Style                  header #3278CC, body BOLD #1F497D, left
//   D  Description            header #3278CC, body left
//   E  Color                  header #3278CC, body left
//   F  spacer (1.57 wch)      header + body always #3278CC, no value
//   G  On Hand                header #4081D0, body right; =0 → #FFC7CE/#9C0006
//   H  spacer (1.57)          as F
//   I  On Order               header #1F497D, body right
//   J  spacer (1.57)          as F
//   K  On PO                  header #1F497D, body right
//   L  spacer (1.57)          as F
//   M+ monthly periods        header #1F497D, body right; low-stock → #FFEB9C/#7F6000
//   R  Total                  =SUM(L<row>:Q<row>), BOLD, no fill, right
//
// Plus a bottom Total row with =SUM formulas in every numeric column.
// Calibri 11 everywhere. Zebra body rows (even #EEF3FA, odd #FFFFFF).
// Spacers always #3278CC top to bottom regardless of zebra.
// Autofit non-spacer cols: max(len(value)) + 2, capped at 80.
// No frozen panes, no autofilter, no merged cells.
export function exportToExcel(
  rows: ATSRow[],
  periods: Array<{ endDate: string; label: string }>,
  atShip = false,
  // Kept for signature compatibility with the existing call sites.
  // The fixed 18-col layout doesn't honor hiddenColumns — drop the
  // arg if the planner's intent shifts.
  _hiddenColumns: string[] = [],
  _totals: GridTotals | null = null,
) {
  // Skip rows whose availability is zero across every visible period.
  // Negatives (shortages) and positives are kept.
  const hasAnyAvailability = (r: ATSRow): boolean => {
    for (const p of periods) {
      const v = atShip ? (r.freeMap?.[p.endDate] ?? r.dates[p.endDate]) : r.dates[p.endDate];
      if (v !== 0 && v != null) return true;
    }
    return false;
  };
  rows = rows.filter(hasAnyAvailability);

  // Column letter helper (1-based: A=1, AA=27, ...).
  const colLetter = (idx1: number): string => {
    let s = "";
    let n = idx1;
    while (n > 0) {
      const rem = (n - 1) % 26;
      s = String.fromCharCode(65 + rem) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  };

  // ── Layout (1-based column indexes) ────────────────────────────────────
  const numPeriods = periods.length;
  const COL = {
    category:    1,   // A
    subCat:      2,   // B
    style:       3,   // C
    description: 4,   // D
    color:       5,   // E
    spacerF:     6,   // F
    onHand:      7,   // G
    spacerH:     8,   // H
    onOrder:     9,   // I
    spacerJ:     10,  // J
    onPO:        11,  // K
    spacerL:     12,  // L
    firstPeriod: 13,  // M
    lastPeriod:  13 + numPeriods - 1,
    total:       13 + numPeriods,
  };
  const SPACER_COLS = new Set([COL.spacerF, COL.spacerH, COL.spacerJ, COL.spacerL]);
  const totalColumnCount = COL.total;

  // ── Style fills ────────────────────────────────────────────────────────
  const HDR_TEXT_FILL  = "3278CC"; // text headers + every spacer
  const HDR_ONHAND_FILL = "4081D0"; // On Hand only
  const HDR_DARK_FILL  = "1F497D"; // On Order, On PO, periods, Total
  const FILL_EVEN = "EEF3FA";       // zebra even data rows
  const FILL_ODD  = "FFFFFF";       // zebra odd data rows

  // ── Borders ────────────────────────────────────────────────────────────
  // Per planner: thin border around every cell PLUS a thick blue outline
  // around each column AND around each header. Implementation:
  //   - Body cells: thin top + bottom (the "regular border around each
  //     cell"), thick left + right (the "thick border around each
  //     column" — adjacent cells share the thick edge).
  //   - Header cells: thick on all four sides.
  //   - Bottom Total row cells: thick top (separator from data) and
  //     thick bottom (closes the table); thick left + right for the
  //     column outline.
  const THICK: any = { style: "medium", color: { rgb: "1F497D" } };
  const THIN: any  = { style: "thin",   color: { rgb: "4472C4" } };
  const BORDER_BODY: any   = { top: THIN,  bottom: THIN,  left: THICK, right: THICK };
  const BORDER_HEADER: any = { top: THICK, bottom: THICK, left: THICK, right: THICK };
  const BORDER_TOTAL: any  = { top: THICK, bottom: THICK, left: THICK, right: THICK };

  // ── Style factories ────────────────────────────────────────────────────
  const headerStyle = (fill: string, align: "left" | "center"): any => ({
    font:      { bold: true, color: { rgb: "FFFFFF" }, sz: 11, name: "Calibri" },
    fill:      { fgColor: { rgb: fill }, patternType: "solid" },
    alignment: { horizontal: align, vertical: "center", wrapText: false },
    border:    BORDER_HEADER,
  });
  // For non-merged rows, alignment is left/center. For prepack pairs,
  // text + qty cols are merged across the pair so the value sits in
  // the vertical CENTER of the merged region (matches the planner's
  // image — qty 0/360/4272 centered in the taller cells).
  const bodyTextStyle = (fill: string): any => ({
    font:      { sz: 11, name: "Calibri" },
    fill:      { fgColor: { rgb: fill }, patternType: "solid" },
    alignment: { horizontal: "left", vertical: "center" },
    border:    BORDER_BODY,
  });
  const bodyStyleStyle = (fill: string): any => ({
    // Style col: bold blue text, left-aligned.
    font:      { sz: 11, bold: true, color: { rgb: "1F497D" }, name: "Calibri" },
    fill:      { fgColor: { rgb: fill }, patternType: "solid" },
    alignment: { horizontal: "left", vertical: "center" },
    border:    BORDER_BODY,
  });
  const bodyNumStyle = (fill: string): any => ({
    font:      { sz: 11, name: "Calibri" },
    fill:      { fgColor: { rgb: fill }, patternType: "solid" },
    alignment: { horizontal: "center", vertical: "center" },
    border:    BORDER_BODY,
  });
  // Centered numeric (used in the period cells where qty + PPK split).
  // Qty sits at the bottom of its cell, PPK suffix at the top of the
  // cell directly below — visually flush.
  const periodQtyStyle = (fill: string): any => ({
    font:      { sz: 11, name: "Calibri" },
    fill:      { fgColor: { rgb: fill }, patternType: "solid" },
    alignment: { horizontal: "center", vertical: "bottom" },
    border:    BORDER_BODY,
  });
  // PPK suffix font: 6.6pt = 5.5pt × 1.2 per planner's "+20%" request.
  const periodPpkStyle = (fill: string): any => ({
    font:      { sz: 6.6, color: { rgb: "B0BAC9" }, name: "Calibri" },
    fill:      { fgColor: { rgb: fill }, patternType: "solid" },
    alignment: { horizontal: "center", vertical: "top" },
    border:    BORDER_BODY,
  });
  const onHandZeroStyle = (base: any): any => ({
    ...base,
    font: { ...base.font, bold: true, color: { rgb: "9C0006" } },
    fill: { fgColor: { rgb: "FFC7CE" }, patternType: "solid" },
  });
  const lowStockStyle = (base: any): any => ({
    ...base,
    font: { ...base.font, bold: true, color: { rgb: "7F6000" } },
    fill: { fgColor: { rgb: "FFEB9C" }, patternType: "solid" },
  });
  const bodyTotalStyle = (): any => ({
    font:      { bold: true, sz: 11, name: "Calibri" },
    alignment: { horizontal: "center", vertical: "center" },
    border:    BORDER_BODY,
  });
  // Spacer cell — always #3278CC top to bottom, no value. Same column-
  // outline border treatment as data cells so the spacer reads as
  // part of the column-outlined grid.
  const spacerCellStyle = (): any => ({
    fill:   { fgColor: { rgb: HDR_TEXT_FILL }, patternType: "solid" },
    border: BORDER_BODY,
  });

  // ── Header row ─────────────────────────────────────────────────────────
  const headerRow: any[] = new Array(totalColumnCount);
  headerRow[COL.category    - 1] = { v: "Category",    t: "s", s: headerStyle(HDR_TEXT_FILL, "left") };
  headerRow[COL.subCat      - 1] = { v: "Sub Cat",     t: "s", s: headerStyle(HDR_TEXT_FILL, "left") };
  headerRow[COL.style       - 1] = { v: "Style",       t: "s", s: headerStyle(HDR_TEXT_FILL, "left") };
  headerRow[COL.description - 1] = { v: "Description", t: "s", s: headerStyle(HDR_TEXT_FILL, "left") };
  headerRow[COL.color       - 1] = { v: "Color",       t: "s", s: headerStyle(HDR_TEXT_FILL, "left") };
  headerRow[COL.spacerF - 1] = { v: "", t: "s", s: headerStyle(HDR_TEXT_FILL, "center") };
  headerRow[COL.spacerH - 1] = { v: "", t: "s", s: headerStyle(HDR_TEXT_FILL, "center") };
  headerRow[COL.spacerJ - 1] = { v: "", t: "s", s: headerStyle(HDR_TEXT_FILL, "center") };
  headerRow[COL.spacerL - 1] = { v: "", t: "s", s: headerStyle(HDR_TEXT_FILL, "center") };
  headerRow[COL.onHand  - 1] = { v: "On Hand",  t: "s", s: headerStyle(HDR_ONHAND_FILL, "center") };
  headerRow[COL.onOrder - 1] = { v: "On Order", t: "s", s: headerStyle(HDR_DARK_FILL, "center") };
  headerRow[COL.onPO    - 1] = { v: "On PO",    t: "s", s: headerStyle(HDR_DARK_FILL, "center") };
  for (let i = 0; i < numPeriods; i++) {
    const ci = COL.firstPeriod + i;
    headerRow[ci - 1] = {
      v: periods[i].label.replace(/\n/g, " "),
      t: "s",
      s: headerStyle(HDR_DARK_FILL, "center"),
    };
  }
  headerRow[COL.total - 1] = { v: "Total", t: "s", s: headerStyle(HDR_DARK_FILL, "center") };

  // ── Helpers ────────────────────────────────────────────────────────────
  const periodValueOf = (r: ATSRow, endDate: string): number => {
    const v = atShip ? (r.freeMap?.[endDate] ?? r.dates[endDate]) : r.dates[endDate];
    return typeof v === "number" ? v : 0;
  };
  const sumStartLetter = colLetter(COL.spacerL);   // L (empty spacer)
  const sumEndLetter = colLetter(COL.lastPeriod);  // last period letter

  // ── Data rows ──────────────────────────────────────────────────────────
  // Each input row → one qty data row. Prepack rows ALSO produce a
  // PPK suffix row immediately below — but only the PERIOD cells
  // (M-Q) carry a suffix. Every other cell on the prepack pair (text
  // cols A-E, spacers F/H/J/L, qty cols G/I/K, Total R) MERGES across
  // the pair so the qty value sits vertically centered in the taller
  // merged cell. Matches the planner's reference image exactly.
  const dataRows: any[][] = [];
  let nextExcelRow = 2; // header is row 1
  // Merge ranges accumulated as we emit prepack pairs.
  const merges: Array<{ s: { r: number; c: number }; e: { r: number; c: number } }> = [];
  // Cols that get merged across the qty+PPK pair when the input row
  // is a prepack. Period cols are EXCLUDED — those split (qty top,
  // PPK suffix bottom).
  const MERGED_PAIR_COLS = [
    COL.category, COL.subCat, COL.style, COL.description, COL.color,
    COL.spacerF, COL.onHand, COL.spacerH, COL.onOrder, COL.spacerJ, COL.onPO, COL.spacerL,
    COL.total,
  ];

  rows.forEach((r, ri) => {
    const isEvenInputRow = (ri % 2) === 0;
    const fill = isEvenInputRow ? FILL_EVEN : FILL_ODD;
    const qtyExcelRow = nextExcelRow;
    const mult = r.ppkMult ?? 1;
    const isPrepack = mult > 1;

    // ── Qty row ──────────────────────────────────────────────────────────
    const qtyRow: any[] = new Array(totalColumnCount);
    qtyRow[COL.category    - 1] = { v: r.master_category ?? r.category ?? "", t: "s", s: bodyTextStyle(fill) };
    qtyRow[COL.subCat      - 1] = { v: r.master_sub_category ?? "",            t: "s", s: bodyTextStyle(fill) };
    qtyRow[COL.style       - 1] = { v: r.master_style ?? "",                   t: "s", s: bodyStyleStyle(fill) };
    qtyRow[COL.description - 1] = { v: r.master_description ?? r.description ?? "", t: "s", s: bodyTextStyle(fill) };
    qtyRow[COL.color       - 1] = { v: displayColor(r),                        t: "s", s: bodyTextStyle(fill) };

    qtyRow[COL.spacerF - 1] = { v: "", t: "s", s: spacerCellStyle() };
    qtyRow[COL.spacerH - 1] = { v: "", t: "s", s: spacerCellStyle() };
    qtyRow[COL.spacerJ - 1] = { v: "", t: "s", s: spacerCellStyle() };
    qtyRow[COL.spacerL - 1] = { v: "", t: "s", s: spacerCellStyle() };

    // On Hand — value 0 triggers red highlight.
    {
      const n = r.onHand ?? 0;
      const style = n === 0 ? onHandZeroStyle(bodyNumStyle(fill)) : bodyNumStyle(fill);
      qtyRow[COL.onHand - 1] = { v: n, t: "n", s: style };
    }
    qtyRow[COL.onOrder - 1] = { v: r.onOrder ?? 0, t: "n", s: bodyNumStyle(fill) };
    qtyRow[COL.onPO    - 1] = { v: r.onPO    ?? 0, t: "n", s: bodyNumStyle(fill) };

    // Period cells. For prepack rows the qty sits at the BOTTOM of
    // its cell (anchored to the bottom edge) so the PPK suffix on the
    // row below visually sits flush against it. Non-prepack rows get
    // standard center alignment.
    for (let i = 0; i < numPeriods; i++) {
      const ci = COL.firstPeriod + i;
      const n = periodValueOf(r, periods[i].endDate);
      const baseStyle = isPrepack ? periodQtyStyle(fill) : bodyNumStyle(fill);
      if (n === 0) {
        qtyRow[ci - 1] = { v: "", t: "s", s: baseStyle };
        continue;
      }
      const style = (n > 0 && n <= 10) ? lowStockStyle(baseStyle) : baseStyle;
      qtyRow[ci - 1] = { v: n, t: "n", s: style };
    }

    // Total — formula PLUS pre-computed cached value so the cell
    // shows the number immediately (Excel won't recalc until the
    // user opens the workbook with calc enabled; without `v`, the
    // cell renders empty until recalc runs).
    let rowPeriodTotal = 0;
    for (let i = 0; i < numPeriods; i++) {
      rowPeriodTotal += periodValueOf(r, periods[i].endDate);
    }
    qtyRow[COL.total - 1] = {
      v: rowPeriodTotal,
      f: `SUM(${sumStartLetter}${qtyExcelRow}:${sumEndLetter}${qtyExcelRow})`,
      t: "n",
      s: bodyTotalStyle(),
    };

    dataRows.push(qtyRow);
    nextExcelRow++;

    // ── PPK suffix follower row (only for prepack rows) ──────────────────
    if (isPrepack) {
      const ppkRow: any[] = new Array(totalColumnCount);
      // Text cols + spacers + qty cols + total: blank — they're MERGED
      // with the qty row above. Excel ignores the values in non-top
      // cells of a merge anyway, but keeping the styling consistent
      // avoids weird ghost-cell artifacts in some viewers.
      const blankFill = (s: any) => ({ v: "", t: "s", s });
      qtyRow[COL.category    - 1].s = { ...qtyRow[COL.category    - 1].s, alignment: { horizontal: "left",   vertical: "center" } };
      qtyRow[COL.subCat      - 1].s = { ...qtyRow[COL.subCat      - 1].s, alignment: { horizontal: "left",   vertical: "center" } };
      qtyRow[COL.style       - 1].s = { ...qtyRow[COL.style       - 1].s, alignment: { horizontal: "left",   vertical: "center" } };
      qtyRow[COL.description - 1].s = { ...qtyRow[COL.description - 1].s, alignment: { horizontal: "left",   vertical: "center" } };
      qtyRow[COL.color       - 1].s = { ...qtyRow[COL.color       - 1].s, alignment: { horizontal: "left",   vertical: "center" } };
      qtyRow[COL.onHand      - 1].s = { ...qtyRow[COL.onHand      - 1].s, alignment: { horizontal: "center", vertical: "center" } };
      qtyRow[COL.onOrder     - 1].s = { ...qtyRow[COL.onOrder     - 1].s, alignment: { horizontal: "center", vertical: "center" } };
      qtyRow[COL.onPO        - 1].s = { ...qtyRow[COL.onPO        - 1].s, alignment: { horizontal: "center", vertical: "center" } };
      qtyRow[COL.total       - 1].s = { ...qtyRow[COL.total       - 1].s, alignment: { horizontal: "right",  vertical: "center" } };

      ppkRow[COL.category    - 1] = blankFill(bodyTextStyle(fill));
      ppkRow[COL.subCat      - 1] = blankFill(bodyTextStyle(fill));
      ppkRow[COL.style       - 1] = blankFill(bodyTextStyle(fill));
      ppkRow[COL.description - 1] = blankFill(bodyTextStyle(fill));
      ppkRow[COL.color       - 1] = blankFill(bodyTextStyle(fill));
      ppkRow[COL.spacerF - 1] = { v: "", t: "s", s: spacerCellStyle() };
      ppkRow[COL.spacerH - 1] = { v: "", t: "s", s: spacerCellStyle() };
      ppkRow[COL.spacerJ - 1] = { v: "", t: "s", s: spacerCellStyle() };
      ppkRow[COL.spacerL - 1] = { v: "", t: "s", s: spacerCellStyle() };
      ppkRow[COL.onHand  - 1] = blankFill(bodyNumStyle(fill));
      ppkRow[COL.onOrder - 1] = blankFill(bodyNumStyle(fill));
      ppkRow[COL.onPO    - 1] = blankFill(bodyNumStyle(fill));

      // Period cells: PPK suffix only where qty > 0; otherwise blank.
      for (let i = 0; i < numPeriods; i++) {
        const ci = COL.firstPeriod + i;
        const n = periodValueOf(r, periods[i].endDate);
        if (n === 0) {
          ppkRow[ci - 1] = { v: "", t: "s", s: periodPpkStyle(fill) };
          continue;
        }
        const packs = Math.round(n / mult);
        ppkRow[ci - 1] = {
          v: `PPK${mult} × ${packs.toLocaleString()}`,
          t: "s",
          s: periodPpkStyle(fill),
        };
      }
      ppkRow[COL.total - 1] = { v: "", t: "s", s: bodyTotalStyle() };

      dataRows.push(ppkRow);
      const ppkExcelRow = nextExcelRow;
      nextExcelRow++;

      for (const ci of MERGED_PAIR_COLS) {
        merges.push({
          s: { r: qtyExcelRow - 1, c: ci - 1 },
          e: { r: ppkExcelRow - 1, c: ci - 1 },
        });
      }
    }
  });

  // ── Bottom Total row ───────────────────────────────────────────────────
  const lastDataExcelRow = nextExcelRow - 1;
  const totalRow: any[] = new Array(totalColumnCount);
  // Label "Total" goes in the Color column (E) per file 1.
  for (const ci of [COL.category, COL.subCat, COL.style, COL.description]) {
    totalRow[ci - 1] = {
      v: "",
      t: "s",
      s: { ...bodyTextStyle(FILL_EVEN), font: { bold: true, sz: 11, name: "Calibri" } },
    };
  }
  totalRow[COL.color - 1] = {
    v: "Total",
    t: "s",
    s: { ...bodyTextStyle(FILL_EVEN), font: { bold: true, sz: 11, name: "Calibri" } },
  };
  totalRow[COL.spacerF - 1] = { v: "", t: "s", s: spacerCellStyle() };
  totalRow[COL.spacerH - 1] = { v: "", t: "s", s: spacerCellStyle() };
  totalRow[COL.spacerJ - 1] = { v: "", t: "s", s: spacerCellStyle() };
  totalRow[COL.spacerL - 1] = { v: "", t: "s", s: spacerCellStyle() };

  const totalNumStyle: any = {
    font:      { bold: true, sz: 11, name: "Calibri" },
    fill:      { fgColor: { rgb: FILL_EVEN }, patternType: "solid" },
    alignment: { horizontal: "center", vertical: "center" },
    border:    BORDER_TOTAL,
  };
  function colSumFormula(colIdx1: number): string {
    const letter = colLetter(colIdx1);
    return `SUM(${letter}2:${letter}${lastDataExcelRow})`;
  }
  // Pre-computed cached sums so the cells display the value
  // immediately when the workbook opens. Excel will replace these
  // with the formula's recalculated value on any cell edit, but
  // without `v` set the cells render empty until a forced recalc.
  const onHandSum = rows.reduce((acc, r) => acc + (r.onHand ?? 0), 0);
  const onOrderSum = rows.reduce((acc, r) => acc + (r.onOrder ?? 0), 0);
  const onPOSum = rows.reduce((acc, r) => acc + (r.onPO ?? 0), 0);
  const periodSums: number[] = periods.map((p) =>
    rows.reduce((acc, r) => acc + periodValueOf(r, p.endDate), 0),
  );
  const grandTotal = periodSums.reduce((a, b) => a + b, 0);

  totalRow[COL.onHand  - 1] = { v: onHandSum,  f: colSumFormula(COL.onHand),  t: "n", s: totalNumStyle };
  totalRow[COL.onOrder - 1] = { v: onOrderSum, f: colSumFormula(COL.onOrder), t: "n", s: totalNumStyle };
  totalRow[COL.onPO    - 1] = { v: onPOSum,    f: colSumFormula(COL.onPO),    t: "n", s: totalNumStyle };
  for (let i = 0; i < numPeriods; i++) {
    const ci = COL.firstPeriod + i;
    totalRow[ci - 1] = { v: periodSums[i], f: colSumFormula(ci), t: "n", s: totalNumStyle };
  }
  totalRow[COL.total - 1] = {
    v: grandTotal,
    f: colSumFormula(COL.total),
    t: "n",
    s: totalNumStyle,
  };
  dataRows.push(totalRow);

  // ── Build worksheet ─────────────────────────────────────────────────────
  const aoa = [headerRow, ...dataRows];
  const ws  = (XLSXStyle.utils.aoa_to_sheet as any)(aoa, { skipHeader: true });

  // ── Auto-fit column widths ──────────────────────────────────────────────
  const SPACER_WCH = 1.57;
  const PAD = 2;
  const MAX_WCH = 80;
  function widthForColumn(idx1: number): number {
    if (SPACER_COLS.has(idx1)) return SPACER_WCH;
    let maxLen = 0;
    const hdrCell = headerRow[idx1 - 1];
    if (hdrCell?.v != null) maxLen = String(hdrCell.v).length;
    for (const row of dataRows) {
      const cell = row[idx1 - 1];
      if (!cell) continue;
      let s: string;
      if (cell.f) s = "999,999";
      else if (typeof cell.v === "number") s = cell.v.toLocaleString();
      else s = String(cell.v ?? "");
      if (s.length > maxLen) maxLen = s.length;
    }
    return Math.min(MAX_WCH, maxLen + PAD);
  }
  ws["!cols"] = [];
  for (let ci = 1; ci <= totalColumnCount; ci++) {
    ws["!cols"][ci - 1] = { wch: widthForColumn(ci) };
  }

  // Row heights — header taller; qty rows default; PPK follower rows
  // shorter (5.5pt suffix only); bottom Total row.
  const HEADER_HPT = 22;
  const ROW_HPT = 15;
  const PPK_ROW_HPT = 11;
  const TOTAL_HPT = 18;
  const rowsHeight: any[] = [{ hpt: HEADER_HPT }];
  for (const r of rows) {
    rowsHeight.push({ hpt: ROW_HPT });
    if ((r.ppkMult ?? 1) > 1) rowsHeight.push({ hpt: PPK_ROW_HPT });
  }
  rowsHeight.push({ hpt: TOTAL_HPT });
  ws["!rows"] = rowsHeight;

  // Merged cells for prepack pairs — text + spacers + qty cols + Total
  // span both rows; only period cols stay split (qty top, PPK bottom).
  if (merges.length > 0) {
    ws["!merges"] = merges;
  }
  // No frozen panes, no autofilter.

  const wb = XLSXStyle.utils.book_new();
  XLSXStyle.utils.book_append_sheet(wb, ws, "ATS Report");

  const buf  = XLSXStyle.write(wb, { bookType: "xlsx", type: "array" });
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `ATS_Report_${fmtDate(new Date())}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}
