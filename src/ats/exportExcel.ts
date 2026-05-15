import XLSXStyle from "xlsx-js-style";
import type { ATSRow } from "./types";
import { fmtDate, displayColor } from "./helpers";
import type { GridTotals } from "./computeTotals";
import { periodAvail } from "./compute";
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
  // Negatives (shortages) and positives are kept. Uses periodAvail so
  // the "any availability" test honors the same delta-when-atShip
  // semantic the cells render with — a row whose only non-zero free is
  // carried-over (no new receipts) still counts as having availability
  // because period-0 is cumulative under that helper.
  const hasAnyAvailability = (r: ATSRow): boolean => {
    for (let i = 0; i < periods.length; i++) {
      const v = periodAvail(r, periods, i, atShip);
      if (v !== 0) return true;
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
  const FILL_EVEN = "EEF3FA";       // zebra even data rows (text + period cols)
  const FILL_ODD  = "FFFFFF";       // zebra odd data rows (text + period cols)
  // Single fill for the three qty-col data cells (On Hand, On Order,
  // On PO). Sits between the very-light zebra (FILL_EVEN/FILL_ODD)
  // and the Color column header (#3278CC) — clearly darker than the
  // body zebra, well lighter than the text headers, and no zebra
  // alternation in those cols so the qty block reads as a coherent
  // band.
  const FILL_QTY_COL = "B4C7E7";    // medium-light blue (Accent 1 Lighter 60%)

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
  // Header column dividers use THIN so the joints between period header
  // cells read lighter (planner asked for lighter / less heavy header
  // dividers); top + bottom stay thick so the header band frames clearly.
  const BORDER_HEADER: any = { top: THICK, bottom: THICK, left: THIN, right: THIN };
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
  const lowStockStyle = (base: any): any => ({
    ...base,
    font: { ...base.font, bold: true, color: { rgb: "7F6000" } },
    fill: { fgColor: { rgb: "FFEB9C" }, patternType: "solid" },
  });
  // Total column body cells now zebra-stripe like the text + period
  // cols — same row's zebra fill applied to col R per planner.
  const bodyTotalStyle = (fill: string): any => ({
    font:      { bold: true, sz: 11, name: "Calibri" },
    fill:      { fgColor: { rgb: fill }, patternType: "solid" },
    alignment: { horizontal: "center", vertical: "center" },
    border:    BORDER_BODY,
  });
  // Spacer cell — always #3278CC top to bottom, no value. NO borders —
  // spacers read as a clean colored gap between column groups (planner
  // asked for the spacer-column vertical borders to be removed).
  const spacerCellStyle = (): any => ({
    fill:   { fgColor: { rgb: HDR_TEXT_FILL }, patternType: "solid" },
    border: {},
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
  // Index-aware accessor — periodAvail handles the atShip=delta case
  // (cumulative free at period 0; per-period new-receipt delta after).
  const periodValueOf = (r: ATSRow, i: number): number => {
    return periodAvail(r, periods, i, atShip);
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

  // Detect whether the export spans more than one style. When yes,
  // we'll emit a subtotal row at the end of each style group; when
  // no (single style), the bottom Total row alone is enough.
  const distinctStyles = new Set<string>();
  for (const r of rows) {
    const s = (r.master_style ?? "").trim();
    if (s) distinctStyles.add(s);
  }
  const multiStyle = distinctStyles.size > 1;

  // Subtotal row factory. Sums the given qty / period totals across a
  // style group; styled blue + bold + 12.1pt (= 11pt qty × 1.1, the
  // planner's "+10%" request).
  function buildSubtotalRow(styleLabel: string, group: ATSRow[]): any[] {
    const subtotalFontSize = 12.1;
    const SUB_FILL = FILL_QTY_COL;  // sit on the qty band so the row
                                    // anchors visually against the qty cols
    const subTextStyle: any = {
      font:      { bold: true, sz: subtotalFontSize, color: { rgb: "1F497D" }, name: "Calibri" },
      fill:      { fgColor: { rgb: SUB_FILL }, patternType: "solid" },
      alignment: { horizontal: "left", vertical: "center" },
      border:    BORDER_BODY,
    };
    const subNumStyle: any = {
      font:      { bold: true, sz: subtotalFontSize, color: { rgb: "1F497D" }, name: "Calibri" },
      fill:      { fgColor: { rgb: SUB_FILL }, patternType: "solid" },
      alignment: { horizontal: "center", vertical: "center" },
      border:    BORDER_BODY,
    };
    const onH = group.reduce((a, x) => a + (x.onHand ?? 0), 0);
    const onO = group.reduce((a, x) => a + (x.onOrder ?? 0), 0);
    const onP = group.reduce((a, x) => a + (x.onPO ?? 0), 0);
    const perPeriod = periods.map((_p, i) => group.reduce((a, x) => a + periodValueOf(x, i), 0));
    const grand = perPeriod.reduce((a, b) => a + b, 0);

    const r2: any[] = new Array(totalColumnCount);
    for (const ci of [COL.category, COL.subCat, COL.style, COL.description]) {
      r2[ci - 1] = { v: "", t: "s", s: subTextStyle };
    }
    r2[COL.color - 1] = { v: `${styleLabel} Subtotal`, t: "s", s: subTextStyle };
    r2[COL.spacerF - 1] = { v: "", t: "s", s: spacerCellStyle() };
    r2[COL.spacerH - 1] = { v: "", t: "s", s: spacerCellStyle() };
    r2[COL.spacerJ - 1] = { v: "", t: "s", s: spacerCellStyle() };
    r2[COL.spacerL - 1] = { v: "", t: "s", s: spacerCellStyle() };
    r2[COL.onHand  - 1] = { v: onH, t: "n", s: subNumStyle };
    r2[COL.onOrder - 1] = { v: onO, t: "n", s: subNumStyle };
    r2[COL.onPO    - 1] = { v: onP, t: "n", s: subNumStyle };
    for (let i = 0; i < numPeriods; i++) {
      const ci = COL.firstPeriod + i;
      r2[ci - 1] = { v: perPeriod[i], t: "n", s: subNumStyle };
    }
    r2[COL.total - 1] = { v: grand, t: "n", s: subNumStyle };
    return r2;
  }

  // Track the rows in the current style group so the subtotal row at
  // the boundary can sum across them.
  let currentGroup: ATSRow[] = [];
  let currentGroupStyle = "";

  function flushGroupSubtotal() {
    if (!multiStyle) { currentGroup = []; return; }
    if (currentGroup.length === 0) return;
    dataRows.push(buildSubtotalRow(currentGroupStyle, currentGroup));
    nextExcelRow++;
    currentGroup = [];
  }

  rows.forEach((r, ri) => {
    const rowStyle = (r.master_style ?? "").trim();
    // If style changed from the previous row, close the previous
    // group with a subtotal (when applicable) before emitting this
    // row into the new group.
    if (multiStyle && currentGroup.length > 0 && rowStyle !== currentGroupStyle) {
      flushGroupSubtotal();
    }
    currentGroupStyle = rowStyle;
    currentGroup.push(r);

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

    // On Hand / On Order / On PO — single shared fill (FILL_QTY_COL),
    // not zebra. Reads as a coherent qty band between the zebra text
    // cols on the left and the period cols on the right. Per planner,
    // zero values in any of the three qty cols render with the SAME
    // blue fill + same font as non-zero cells — no red highlight on
    // On Hand zeros (the live grid has its own visual cues for zero
    // stock; the export stays uniform).
    qtyRow[COL.onHand  - 1] = { v: r.onHand  ?? 0, t: "n", s: bodyNumStyle(FILL_QTY_COL) };
    qtyRow[COL.onOrder - 1] = { v: r.onOrder ?? 0, t: "n", s: bodyNumStyle(FILL_QTY_COL) };
    qtyRow[COL.onPO    - 1] = { v: r.onPO    ?? 0, t: "n", s: bodyNumStyle(FILL_QTY_COL) };

    // Period cells. For prepack rows the qty sits at the BOTTOM of
    // its cell (anchored to the bottom edge) so the PPK suffix on the
    // row below visually sits flush against it. Non-prepack rows get
    // standard center alignment.
    for (let i = 0; i < numPeriods; i++) {
      const ci = COL.firstPeriod + i;
      const n = periodValueOf(r, i);
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
      rowPeriodTotal += periodValueOf(r, i);
    }
    qtyRow[COL.total - 1] = {
      v: rowPeriodTotal,
      f: `SUM(${sumStartLetter}${qtyExcelRow}:${sumEndLetter}${qtyExcelRow})`,
      t: "n",
      s: bodyTotalStyle(fill),
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
      ppkRow[COL.onHand  - 1] = blankFill(bodyNumStyle(FILL_QTY_COL));
      ppkRow[COL.onOrder - 1] = blankFill(bodyNumStyle(FILL_QTY_COL));
      ppkRow[COL.onPO    - 1] = blankFill(bodyNumStyle(FILL_QTY_COL));

      // Period cells: PPK suffix only where qty > 0; otherwise blank.
      for (let i = 0; i < numPeriods; i++) {
        const ci = COL.firstPeriod + i;
        const n = periodValueOf(r, i);
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
      ppkRow[COL.total - 1] = { v: "", t: "s", s: bodyTotalStyle(fill) };

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
  // Final group's subtotal (no next-row to trigger the boundary).
  flushGroupSubtotal();

  // ── Bottom totals ──────────────────────────────────────────────────────
  // Mirrors the on-screen TOTALS row exactly: when the planner has the
  // toggle on, the export emits a 5-row stack (TOTAL Qty / Cost $ /
  // Sale $ / Mrgn $ / Mrgn %) AFTER the last data row. When the toggle
  // is off, no bottom totals row is added at all — the export ends on
  // the last data row (or per-style subtotal). The previous "always
  // emit a simple Total row" path was dropped per planner: the toggle
  // controls visibility for both surfaces uniformly.
  const totalNumStyle: any = {
    font:      { bold: true, sz: 11, name: "Calibri" },
    fill:      { fgColor: { rgb: FILL_EVEN }, patternType: "solid" },
    alignment: { horizontal: "center", vertical: "center" },
    border:    BORDER_TOTAL,
  };
  const totalLabelStyle: any = {
    ...bodyTextStyle(FILL_EVEN),
    font: { bold: true, sz: 11, name: "Calibri" },
  };
  const periodSums: number[] = periods.map((_p, i) =>
    rows.reduce((acc, r) => acc + periodValueOf(r, i), 0),
  );

  if (_totals !== null) {
    // Totals stack: 5 rows pulled from the supplied GridTotals.
    const t = _totals;
    const fmtUSD = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const safePct = (sale: number, mrgn: number) =>
      sale > 0 ? `${((mrgn / sale) * 100).toFixed(1)}%` : "—";

    function buildStackRow(label: string, getQty: (k: "onHand" | "onOrder" | "onPO") => string | number, getPeriod: (key: string) => string | number, getRowTotal: () => string | number) {
      const cells: any[] = new Array(totalColumnCount);
      for (const ci of [COL.category, COL.subCat, COL.style, COL.description]) {
        cells[ci - 1] = { v: "", t: "s", s: totalLabelStyle };
      }
      cells[COL.color - 1] = { v: label, t: "s", s: totalLabelStyle };
      cells[COL.spacerF - 1] = { v: "", t: "s", s: spacerCellStyle() };
      cells[COL.spacerH - 1] = { v: "", t: "s", s: spacerCellStyle() };
      cells[COL.spacerJ - 1] = { v: "", t: "s", s: spacerCellStyle() };
      cells[COL.spacerL - 1] = { v: "", t: "s", s: spacerCellStyle() };
      const cellFor = (v: string | number) => ({ v, t: typeof v === "number" ? "n" : "s", s: totalNumStyle });
      cells[COL.onHand  - 1] = cellFor(getQty("onHand"));
      cells[COL.onOrder - 1] = cellFor(getQty("onOrder"));
      cells[COL.onPO    - 1] = cellFor(getQty("onPO"));
      for (let i = 0; i < numPeriods; i++) {
        const ci = COL.firstPeriod + i;
        // GridTotals.periodQty is keyed by period.endDate (== key).
        cells[ci - 1] = cellFor(getPeriod(periods[i].endDate));
      }
      cells[COL.total - 1] = cellFor(getRowTotal());
      return cells;
    }

    const periodCostSum = periods.reduce((a, p) => a + (t.periodCost[p.endDate] ?? 0), 0);
    const periodSaleSum = periods.reduce((a, p) => a + (t.periodSale[p.endDate] ?? 0), 0);

    dataRows.push(buildStackRow(
      "TOTAL Qty",
      (k) => t[k].qty,
      (key) => t.periodQty[key] ?? 0,
      () => periodSums.reduce((a, b) => a + b, 0),
    ));
    dataRows.push(buildStackRow(
      "TOTAL Cost",
      (k) => fmtUSD(t[k].cost),
      (key) => fmtUSD(t.periodCost[key] ?? 0),
      () => fmtUSD(periodCostSum),
    ));
    dataRows.push(buildStackRow(
      "TOTAL Sale",
      (k) => fmtUSD(t[k].sale),
      (key) => fmtUSD(t.periodSale[key] ?? 0),
      () => fmtUSD(periodSaleSum),
    ));
    dataRows.push(buildStackRow(
      "TOTAL Mrgn $",
      (k) => fmtUSD(t[k].sale - t[k].cost),
      (key) => fmtUSD((t.periodSale[key] ?? 0) - (t.periodCost[key] ?? 0)),
      () => fmtUSD(periodSaleSum - periodCostSum),
    ));
    dataRows.push(buildStackRow(
      "TOTAL Mrgn %",
      (k) => safePct(t[k].sale, t[k].sale - t[k].cost),
      (key) => safePct(t.periodSale[key] ?? 0, (t.periodSale[key] ?? 0) - (t.periodCost[key] ?? 0)),
      () => safePct(periodSaleSum, periodSaleSum - periodCostSum),
    ));
  }

  // ── Outer + style-group thick borders ──────────────────────────────────
  // Two extra-heavy outlines on top of the per-cell base borders:
  //   (a) one EXTRA-THICK rectangle around the entire output —
  //       top of header, bottom of total row, left of col A, right
  //       of last column.
  //   (b) one EXTRA-THICK rectangle around each STYLE group's row
  //       block (e.g. all variants of RYB153330PPK) spanning every
  //       column from Category to Total.
  // Excel's "thick" border style is the heaviest single line —
  // visibly heavier than the "medium" we use for the column
  // outline + header / total borders, so the outer + style outlines
  // stand out clearly.
  const EXTRA_THICK: any = { style: "thick", color: { rgb: "1F497D" } };

  // Identify style-group boundaries from the qty-row Style cells.
  // Walk all data rows (excluding the bottom Total row), pull each
  // row's style value from col C, and mark transitions.
  type RowKind = "qty" | "ppk";
  // Build an array describing each data row's kind + its qty row's
  // style. PPK rows inherit the previous qty row's style so they
  // never trigger a boundary.
  const rowMeta: Array<{ kind: RowKind; style: string }> = [];
  let lastQtyStyle = "";
  for (let i = 0; i < dataRows.length - 1; i++) { // skip bottom Total row
    const r = dataRows[i];
    const styleVal = r[COL.style - 1]?.v;
    if (typeof styleVal === "string" && styleVal.trim() !== "") {
      lastQtyStyle = styleVal.trim();
      rowMeta.push({ kind: "qty", style: lastQtyStyle });
    } else {
      // Empty style cell = follower row (PPK) inheriting previous style.
      rowMeta.push({ kind: "ppk", style: lastQtyStyle });
    }
  }
  // First/last data row (in the dataRows array) of each style group.
  // Indexes here are into dataRows (0-based), so the corresponding
  // Excel row is dataRows-index + 1 (since header is excelRow=0).
  const styleStartDataIdx = new Set<number>();
  const styleEndDataIdx = new Set<number>();
  let prevStyle = "";
  for (let i = 0; i < rowMeta.length; i++) {
    const meta = rowMeta[i];
    if (meta.style !== prevStyle) {
      styleStartDataIdx.add(i);
      if (i > 0) styleEndDataIdx.add(i - 1); // close the previous group
      prevStyle = meta.style;
    }
  }
  if (rowMeta.length > 0) styleEndDataIdx.add(rowMeta.length - 1); // close the last group

  // Convert to aoa-row indexes (0 = header, 1+ = dataRows[0]+).
  const lastAoaRow = dataRows.length;       // header + all dataRows incl. total
  const lastColIdx = totalColumnCount - 1;
  const allRows: any[][] = [headerRow, ...dataRows];

  for (let r = 0; r <= lastAoaRow; r++) {
    for (let c = 0; c <= lastColIdx; c++) {
      const cell = allRows[r]?.[c];
      if (!cell || !cell.s) continue;
      const colIdx1 = c + 1;
      const isSpacer = SPACER_COLS.has(colIdx1);
      // Clone the border block so we don't mutate any shared style.
      const border: any = { ...(cell.s.border ?? {}) };

      // (a) Outer table outline — applies to BOTH spacers and non-
      // spacers so the heavy frame around the table reads as one
      // continuous line. Without this, the spacer header cells kept
      // their lighter THICK top while neighbors picked up EXTRA_THICK,
      // producing visible "joint" marks at every spacer/data boundary
      // at the top of the header row.
      if (c === 0) border.left = EXTRA_THICK;                     // left edge of A
      if (c === lastColIdx) border.right = EXTRA_THICK;            // right edge of last col
      if (r === 0) border.top = EXTRA_THICK;                       // top of header
      if (r === lastAoaRow) border.bottom = EXTRA_THICK;           // bottom of total row

      // (b) Style-group outline — only on non-spacer columns.
      // Painting horizontal EXTRA_THICK across the spacer band would
      // chop the dark spacer column into bricks, which is exactly the
      // visual the planner asked us to remove.
      if (!isSpacer) {
        const dataIdx = r - 1;
        if (dataIdx >= 0 && dataIdx < rowMeta.length) {
          if (styleStartDataIdx.has(dataIdx)) border.top = EXTRA_THICK;
          if (styleEndDataIdx.has(dataIdx)) border.bottom = EXTRA_THICK;
        }
      }

      cell.s = { ...cell.s, border };
    }
  }

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

  // Row heights — set per Excel row index after we've already pushed
  // every dataRow (variants + PPK pairs + style subtotals + bottom
  // Total / stack). Header taller; PPK follower rows shorter; subtotal
  // and total rows a touch taller for visual weight.
  const HEADER_HPT = 22;
  const ROW_HPT = 15;
  const PPK_ROW_HPT = 11;
  const SUBTOTAL_HPT = 19;
  const TOTAL_HPT = 18;
  const rowsHeight: any[] = [{ hpt: HEADER_HPT }];
  // Walk the dataRows we actually built. A subtotal / bottom Total row
  // is identifiable by a "Subtotal" or "Total" label in the Color col;
  // a PPK follower has an empty Style cell; everything else is a qty
  // row. Mapping by content keeps the height aligned even after the
  // multi-feature row insertion.
  for (const row of dataRows) {
    const colorVal = row[COL.color - 1]?.v;
    const styleVal = row[COL.style - 1]?.v;
    if (typeof colorVal === "string" && /Subtotal$/i.test(colorVal)) {
      rowsHeight.push({ hpt: SUBTOTAL_HPT });
    } else if (typeof colorVal === "string" && (colorVal === "Total" || /^TOTAL /i.test(colorVal))) {
      rowsHeight.push({ hpt: TOTAL_HPT });
    } else if (typeof styleVal === "string" && styleVal.trim() === "") {
      rowsHeight.push({ hpt: PPK_ROW_HPT });
    } else {
      rowsHeight.push({ hpt: ROW_HPT });
    }
  }
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
