import XLSXStyle from "xlsx-js-style";
import type { ATSRow } from "./types";
import { fmtDate, displayColor } from "./helpers";
import type { GridTotals } from "./computeTotals";

// Excel export — fixed 18-column layout to spec (A through R):
//   A  Category               | header #3278CC, body left-aligned
//   B  Sub Cat                | header #3278CC, body left-aligned
//   C  Style                  | header #3278CC, body BOLD #1F497D, left
//   D  Description            | header #3278CC, body left-aligned
//   E  Color                  | header #3278CC, body left-aligned
//   F  (spacer, fixed 1.57)   | header + body always #3278CC, no value
//   G  On Hand                | header #4081D0, body right-aligned, =0 → red highlight
//   H  (spacer, fixed 1.57)   | as F
//   I  On Order               | header #1F497D, body right-aligned
//   J  (spacer, fixed 1.57)   | as F
//   K  On PO                  | header #1F497D, body right-aligned
//   L  (spacer, fixed 1.57)   | as F
//   M..Q+  monthly periods    | header #1F497D, body right-aligned, low-stock → yellow
//   R  Total                  | =SUM formula, BOLD, no fill, right-aligned
//
// Auto-fit: max(len(value)) + 2 for non-spacer cols, capped at 80.
// Spacers fixed at width 1.57.
// Zebra body rows: even fill #EEF3FA, odd fill #FFFFFF.
// No frozen panes, no autofilter, no merged cells.
//
// PPK rows render their qty cells with two-line rich text (qty bold,
// "PPKn × packs" suffix at half-size faded slate) so the planner sees
// the same prepack hint they get on screen.
export function exportToExcel(
  rows: ATSRow[],
  periods: Array<{ endDate: string; label: string }>,
  atShip = false,
  // Kept for signature compatibility with the existing call sites,
  // but the spec defines a fixed 18-column layout — hidden columns
  // are NOT honored here. Drop the arg to silence the planner if the
  // intent shifts.
  _hiddenColumns: string[] = [],
  _totals: GridTotals | null = null,
) {
  // Skip rows whose availability is zero across every visible period.
  // Negatives (shortages) and positives are kept; pure zeros across
  // every column add nothing to a planning conversation.
  const hasAnyAvailability = (r: ATSRow): boolean => {
    for (const p of periods) {
      const v = atShip ? (r.freeMap?.[p.endDate] ?? r.dates[p.endDate]) : r.dates[p.endDate];
      if (v !== 0 && v != null) return true;
    }
    return false;
  };
  rows = rows.filter(hasAnyAvailability);

  // ── Column letter helper ───────────────────────────────────────────────
  const colLetter = (idx1: number): string => {
    // 1-based: A=1, Z=26, AA=27, ...
    let s = "";
    let n = idx1;
    while (n > 0) {
      const rem = (n - 1) % 26;
      s = String.fromCharCode(65 + rem) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  };

  // ── Layout (1-based column indexes per spec) ───────────────────────────
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
    lastPeriod:  13 + numPeriods - 1,         // last period column
    total:       13 + numPeriods,             // R when periods=5
  };
  const SPACER_COLS = new Set([COL.spacerF, COL.spacerH, COL.spacerJ, COL.spacerL]);
  const totalColumnCount = COL.total;

  // ── Style builders ─────────────────────────────────────────────────────
  // Header fills — three distinct shades per spec.
  const HDR_TEXT_FILL  = "3278CC"; // text cols A-E + every spacer
  const HDR_ONHAND_FILL = "4081D0"; // On Hand only
  const HDR_DARK_FILL  = "1F497D"; // On Order, On PO, periods, Total

  const FILL_EVEN = "EEF3FA";       // zebra: even data rows
  const FILL_ODD  = "FFFFFF";       // zebra: odd data rows

  const headerStyle = (fill: string, align: "left" | "center"): any => ({
    font:      { bold: true, color: { rgb: "FFFFFF" }, sz: 11, name: "Calibri" },
    fill:      { fgColor: { rgb: fill }, patternType: "solid" },
    alignment: { horizontal: align, vertical: "center", wrapText: false },
  });

  const bodyTextStyle = (fill: string): any => ({
    font:      { sz: 11, name: "Calibri" },
    fill:      { fgColor: { rgb: fill }, patternType: "solid" },
    alignment: { horizontal: "left", vertical: "center", wrapText: true },
  });

  const bodyStyleStyle = (fill: string): any => ({
    // Style column: bold blue text, left-aligned (text-col convention).
    font:      { sz: 11, bold: true, color: { rgb: "1F497D" }, name: "Calibri" },
    fill:      { fgColor: { rgb: fill }, patternType: "solid" },
    alignment: { horizontal: "left", vertical: "center", wrapText: true },
  });

  const bodyNumStyle = (fill: string): any => ({
    font:      { sz: 11, name: "Calibri" },
    fill:      { fgColor: { rgb: fill }, patternType: "solid" },
    alignment: { horizontal: "right", vertical: "center", wrapText: true },
  });

  // Conditional highlight overlays.
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

  // Total column style (no fill — left transparent / system white).
  const bodyTotalStyle = (): any => ({
    font:      { bold: true, sz: 11, name: "Calibri" },
    alignment: { horizontal: "right", vertical: "center" },
  });

  // Spacer cell — always #3278CC, no value, no font / alignment fuss.
  const spacerCellStyle = (): any => ({
    fill: { fgColor: { rgb: HDR_TEXT_FILL }, patternType: "solid" },
  });

  // ── Header row (row 1) ─────────────────────────────────────────────────
  const headerRow: any[] = new Array(totalColumnCount);
  // A-E text headers
  headerRow[COL.category    - 1] = { v: "Category",    t: "s", s: headerStyle(HDR_TEXT_FILL, "left") };
  headerRow[COL.subCat      - 1] = { v: "Sub Cat",     t: "s", s: headerStyle(HDR_TEXT_FILL, "left") };
  headerRow[COL.style       - 1] = { v: "Style",       t: "s", s: headerStyle(HDR_TEXT_FILL, "left") };
  headerRow[COL.description - 1] = { v: "Description", t: "s", s: headerStyle(HDR_TEXT_FILL, "left") };
  headerRow[COL.color       - 1] = { v: "Color",       t: "s", s: headerStyle(HDR_TEXT_FILL, "left") };
  // Spacers — header blank, but still filled with #3278CC.
  headerRow[COL.spacerF - 1] = { v: "", t: "s", s: headerStyle(HDR_TEXT_FILL, "center") };
  headerRow[COL.spacerH - 1] = { v: "", t: "s", s: headerStyle(HDR_TEXT_FILL, "center") };
  headerRow[COL.spacerJ - 1] = { v: "", t: "s", s: headerStyle(HDR_TEXT_FILL, "center") };
  headerRow[COL.spacerL - 1] = { v: "", t: "s", s: headerStyle(HDR_TEXT_FILL, "center") };
  // Qty headers
  headerRow[COL.onHand  - 1] = { v: "On Hand",  t: "s", s: headerStyle(HDR_ONHAND_FILL, "center") };
  headerRow[COL.onOrder - 1] = { v: "On Order", t: "s", s: headerStyle(HDR_DARK_FILL, "center") };
  headerRow[COL.onPO    - 1] = { v: "On PO",    t: "s", s: headerStyle(HDR_DARK_FILL, "center") };
  // Period headers — labels straight from displayPeriods (already
  // formatted "Jun 2026" style by the caller).
  for (let i = 0; i < numPeriods; i++) {
    const ci = COL.firstPeriod + i;
    headerRow[ci - 1] = {
      v: periods[i].label.replace(/\n/g, " "),
      t: "s",
      s: headerStyle(HDR_DARK_FILL, "center"),
    };
  }
  // Total header
  headerRow[COL.total - 1] = { v: "Total", t: "s", s: headerStyle(HDR_DARK_FILL, "center") };

  // ── Helpers for body cells ─────────────────────────────────────────────
  const periodValueOf = (r: ATSRow, endDate: string): number => {
    const v = atShip ? (r.freeMap?.[endDate] ?? r.dates[endDate]) : r.dates[endDate];
    return typeof v === "number" ? v : 0;
  };

  // PPK rich-text suffix builder — same shape as the on-screen grid.
  // Returns null when the row isn't a prepack or qty is zero.
  function buildNumericCell(r: ATSRow, n: number, baseStyle: any): any {
    const mult = r.ppkMult ?? 1;
    const showPpk = mult > 1 && n !== 0;
    if (!showPpk) {
      return { v: n, t: "n", s: baseStyle };
    }
    const packs = Math.round(n / mult);
    const suffix = `PPK${mult} × ${packs.toLocaleString()}`;
    // Rich text: line 1 inherits the cell's font (bold/color may have
    // been overridden by conditional highlight). Line 2 is the faded
    // slate hint at ~7pt to match the grid's faded-9px-at-75% look.
    const baseFont = baseStyle.font ?? { sz: 11, name: "Calibri" };
    return {
      v: `${n.toLocaleString()}\n${suffix}`,
      t: "s",
      s: baseStyle,
      r: [
        { t: n.toLocaleString(), s: { font: baseFont } },
        { t: "\n" + suffix, s: { font: { sz: 7, color: { rgb: "B0BAC9" }, name: "Calibri" } } },
      ],
    };
  }

  // ── Data rows ──────────────────────────────────────────────────────────
  // Even data rows (Excel rows 2, 4, 6...) get the EVEN fill per spec —
  // i.e. the FIRST data row (Excel row 2) is the EVEN one. We count
  // from data-row-index 0 inclusive.
  const dataRows: any[][] = rows.map((r, ri) => {
    const isEvenDataRow = (ri % 2) === 0; // ri 0 → Excel row 2 → "even"
    const fill = isEvenDataRow ? FILL_EVEN : FILL_ODD;
    const excelRow = ri + 2; // header is row 1; data starts at row 2

    const cells: any[] = new Array(totalColumnCount);
    cells[COL.category    - 1] = { v: r.master_category ?? r.category ?? "", t: "s", s: bodyTextStyle(fill) };
    cells[COL.subCat      - 1] = { v: r.master_sub_category ?? "",            t: "s", s: bodyTextStyle(fill) };
    cells[COL.style       - 1] = { v: r.master_style ?? "",                   t: "s", s: bodyStyleStyle(fill) };
    cells[COL.description - 1] = { v: r.description ?? "",                    t: "s", s: bodyTextStyle(fill) };
    cells[COL.color       - 1] = { v: displayColor(r),                        t: "s", s: bodyTextStyle(fill) };

    // Spacers — always #3278CC, no value, regardless of zebra row.
    cells[COL.spacerF - 1] = { v: "", t: "s", s: spacerCellStyle() };
    cells[COL.spacerH - 1] = { v: "", t: "s", s: spacerCellStyle() };
    cells[COL.spacerJ - 1] = { v: "", t: "s", s: spacerCellStyle() };
    cells[COL.spacerL - 1] = { v: "", t: "s", s: spacerCellStyle() };

    // On Hand — value 0 triggers red highlight per spec.
    {
      const n = r.onHand ?? 0;
      const base = n === 0 ? onHandZeroStyle(bodyNumStyle(fill)) : bodyNumStyle(fill);
      cells[COL.onHand - 1] = buildNumericCell(r, n, base);
    }
    // On Order, On PO — plain numeric.
    cells[COL.onOrder - 1] = buildNumericCell(r, r.onOrder ?? 0, bodyNumStyle(fill));
    cells[COL.onPO    - 1] = buildNumericCell(r, r.onPO    ?? 0, bodyNumStyle(fill));

    // Period cells — low-stock highlight when 0 < qty <= 10. Zero
    // values render as blank (matches the planning-grid aesthetic).
    for (let i = 0; i < numPeriods; i++) {
      const ci = COL.firstPeriod + i;
      const n = periodValueOf(r, periods[i].endDate);
      if (n === 0) {
        cells[ci - 1] = { v: "", t: "s", s: bodyNumStyle(fill) };
        continue;
      }
      const base = (n > 0 && n <= 10) ? lowStockStyle(bodyNumStyle(fill)) : bodyNumStyle(fill);
      cells[ci - 1] = buildNumericCell(r, n, base);
    }

    // Total — Excel formula so the workbook recalculates if the
    // planner edits any period cell. Range starts at the spacer
    // before the periods (L) which is empty, so SUM ignores it and
    // effectively sums the period range.
    const sumStart = colLetter(COL.spacerL);  // L (empty spacer)
    const sumEnd = colLetter(COL.lastPeriod); // last period letter
    cells[COL.total - 1] = {
      f: `SUM(${sumStart}${excelRow}:${sumEnd}${excelRow})`,
      t: "n",
      s: bodyTotalStyle(),
    };

    return cells;
  });

  // ── Build worksheet ─────────────────────────────────────────────────────
  const aoa = [headerRow, ...dataRows];
  const ws  = (XLSXStyle.utils.aoa_to_sheet as any)(aoa, { skipHeader: true });

  // ── Auto-fit column widths ──────────────────────────────────────────────
  // For non-spacer cols: max(len(str(value))) + 2, capped at 80.
  // Spacers: fixed 1.57.
  const SPACER_WCH = 1.57;
  const PAD = 2;
  const MAX_WCH = 80;
  function widthForColumn(idx1: number): number {
    if (SPACER_COLS.has(idx1)) return SPACER_WCH;
    let maxLen = 0;
    // Header label
    const hdrCell = headerRow[idx1 - 1];
    if (hdrCell?.v != null) maxLen = String(hdrCell.v).length;
    // Walk every data row at this column index
    for (const row of dataRows) {
      const cell = row[idx1 - 1];
      if (!cell) continue;
      // Use the rendered string length — for numeric cells the
      // formatted number is what the planner sees; for rich-text PPK
      // cells the longer of (qty line, suffix line) is the visible
      // width.
      let s: string;
      if (cell.r) {
        // rich text: pick the longest run
        s = (cell.r as Array<{ t: string }>).reduce((acc, run) => {
          const piece = (run.t || "").split("\n").reduce((a, b) => a.length > b.length ? a : b);
          return piece.length > acc.length ? piece : acc;
        }, "");
      } else if (cell.f) {
        // formula — use a small placeholder; Excel renders the result
        s = "999,999";
      } else if (typeof cell.v === "number") {
        s = cell.v.toLocaleString();
      } else {
        s = String(cell.v ?? "");
      }
      if (s.length > maxLen) maxLen = s.length;
    }
    return Math.min(MAX_WCH, maxLen + PAD);
  }
  ws["!cols"] = [];
  for (let ci = 1; ci <= totalColumnCount; ci++) {
    ws["!cols"][ci - 1] = { wch: widthForColumn(ci) };
  }

  // Header row a touch taller; PPK data rows need extra room for the
  // wrap so the second-line suffix doesn't clip.
  const PREPACK_ROW_HPT = 26;
  const NORMAL_ROW_HPT = 15;
  const HEADER_HPT = 22;
  const rowsHeight: any[] = [{ hpt: HEADER_HPT }];
  for (const r of rows) {
    rowsHeight.push({ hpt: (r.ppkMult ?? 1) > 1 ? PREPACK_ROW_HPT : NORMAL_ROW_HPT });
  }
  ws["!rows"] = rowsHeight;

  // Per spec: no frozen panes, no autofilter, no merged cells.

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
