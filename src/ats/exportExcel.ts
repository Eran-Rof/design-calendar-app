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

  // Plain numeric cell — qty cells stay clean (no rich text). The PPK
  // suffix lives on its own follower row directly below the prepack
  // row so its half-size faded font renders reliably without fighting
  // Excel's row-height + wrap-text quirks.
  function buildNumericCell(_r: ATSRow, n: number, baseStyle: any): any {
    return { v: n, t: "n", s: baseStyle };
  }

  // Style for a PPK suffix cell on the follower row (5.5pt = exact
  // half of the qty cell's 11pt, faded slate, right-aligned, same
  // fill as the qty row above so the pair reads as one unit).
  function ppkSuffixStyle(fill: string): any {
    return {
      font:      { sz: 5.5, color: { rgb: "B0BAC9" }, name: "Calibri" },
      fill:      { fgColor: { rgb: fill }, patternType: "solid" },
      alignment: { horizontal: "right", vertical: "center", wrapText: false },
    };
  }
  function ppkSuffixTextStyle(fill: string): any {
    // Empty A-E cells on the PPK row keep the same fill so the row
    // reads as a single visual unit with the qty row above.
    return {
      font:      { sz: 5.5, color: { rgb: "B0BAC9" }, name: "Calibri" },
      fill:      { fgColor: { rgb: fill }, patternType: "solid" },
      alignment: { horizontal: "left", vertical: "center" },
    };
  }
  function ppkSuffix(qty: number, mult: number): string {
    if (!mult || mult <= 1 || qty == null || qty === 0) return "";
    const packs = Math.round(qty / mult);
    return `PPK${mult} × ${packs.toLocaleString()}`;
  }

  // ── Data rows ──────────────────────────────────────────────────────────
  // Each input row produces one numeric data row. Prepack rows ALSO
  // produce a PPK suffix row immediately below — half-size faded text
  // showing the per-cell pack count. For the prepack pair, every
  // NON-QUANTITY cell (text cols A-E, spacers F/H/J/L, Total col R)
  // is MERGED across both rows so they render as one tall cell that
  // visually spans qty + PPK. Quantity cells (G, I, K, M-Q) stay
  // separate so qty value is on the top row, PPK suffix below.
  const dataRows: any[][] = [];
  // Track the Excel row number each input row's qty cells live on,
  // so the bottom Total row's SUM formulas can hit the right range.
  let nextExcelRow = 2; // header is row 1
  const qtyRowExcelNumbers: number[] = [];
  const sumStartLetter = colLetter(COL.spacerL);   // L (empty spacer)
  const sumEndLetter = colLetter(COL.lastPeriod);  // last period letter
  // Merge ranges accumulated as we emit prepack pairs. Each range:
  // { s: { r: startRowIdx, c: colIdx }, e: { r: endRowIdx, c: colIdx } }
  // both 0-based — xlsx-js-style consumes this shape on ws["!merges"].
  const merges: Array<{ s: { r: number; c: number }; e: { r: number; c: number } }> = [];
  // Cols that get merged across the qty+PPK pair. Quantity cols
  // (onHand/onOrder/onPO/periods) are EXCLUDED — those carry distinct
  // values on each row.
  const MERGED_PAIR_COLS = [
    COL.category, COL.subCat, COL.style, COL.description, COL.color,
    COL.spacerF, COL.spacerH, COL.spacerJ, COL.spacerL,
    COL.total,
  ];

  rows.forEach((r, ri) => {
    const isEvenInputRow = (ri % 2) === 0; // input row 0 → "even" → tinted
    const fill = isEvenInputRow ? FILL_EVEN : FILL_ODD;
    const qtyExcelRow = nextExcelRow;
    qtyRowExcelNumbers.push(qtyExcelRow);

    // ── Qty row ──────────────────────────────────────────────────────────
    const qtyRow: any[] = new Array(totalColumnCount);
    qtyRow[COL.category    - 1] = { v: r.master_category ?? r.category ?? "", t: "s", s: bodyTextStyle(fill) };
    qtyRow[COL.subCat      - 1] = { v: r.master_sub_category ?? "",            t: "s", s: bodyTextStyle(fill) };
    qtyRow[COL.style       - 1] = { v: r.master_style ?? "",                   t: "s", s: bodyStyleStyle(fill) };
    qtyRow[COL.description - 1] = { v: r.description ?? "",                    t: "s", s: bodyTextStyle(fill) };
    qtyRow[COL.color       - 1] = { v: displayColor(r),                        t: "s", s: bodyTextStyle(fill) };

    // Spacers — always #3278CC, no value, regardless of zebra row.
    qtyRow[COL.spacerF - 1] = { v: "", t: "s", s: spacerCellStyle() };
    qtyRow[COL.spacerH - 1] = { v: "", t: "s", s: spacerCellStyle() };
    qtyRow[COL.spacerJ - 1] = { v: "", t: "s", s: spacerCellStyle() };
    qtyRow[COL.spacerL - 1] = { v: "", t: "s", s: spacerCellStyle() };

    // On Hand — value 0 triggers red highlight per spec.
    {
      const n = r.onHand ?? 0;
      const base = n === 0 ? onHandZeroStyle(bodyNumStyle(fill)) : bodyNumStyle(fill);
      qtyRow[COL.onHand - 1] = buildNumericCell(r, n, base);
    }
    qtyRow[COL.onOrder - 1] = buildNumericCell(r, r.onOrder ?? 0, bodyNumStyle(fill));
    qtyRow[COL.onPO    - 1] = buildNumericCell(r, r.onPO    ?? 0, bodyNumStyle(fill));

    // Period cells — low-stock highlight when 0 < qty <= 10. Zero
    // values render as blank (matches the planning-grid aesthetic).
    for (let i = 0; i < numPeriods; i++) {
      const ci = COL.firstPeriod + i;
      const n = periodValueOf(r, periods[i].endDate);
      if (n === 0) {
        qtyRow[ci - 1] = { v: "", t: "s", s: bodyNumStyle(fill) };
        continue;
      }
      const base = (n > 0 && n <= 10) ? lowStockStyle(bodyNumStyle(fill)) : bodyNumStyle(fill);
      qtyRow[ci - 1] = buildNumericCell(r, n, base);
    }

    // Total — formula so Excel recalculates on edits. Range starts at
    // the empty spacer L (SUM ignores it) through the last period.
    qtyRow[COL.total - 1] = {
      f: `SUM(${sumStartLetter}${qtyExcelRow}:${sumEndLetter}${qtyExcelRow})`,
      t: "n",
      s: bodyTotalStyle(),
    };

    dataRows.push(qtyRow);
    nextExcelRow++;

    // ── PPK suffix follower row (only for prepack rows) ──────────────────
    const mult = r.ppkMult ?? 1;
    if (mult > 1) {
      const ppkRow: any[] = new Array(totalColumnCount);
      // A-E carry the SAME fill as the qty row above so the pair
      // visually merges. Empty values, half-size faded font.
      for (const ci of [COL.category, COL.subCat, COL.style, COL.description, COL.color]) {
        ppkRow[ci - 1] = { v: "", t: "s", s: ppkSuffixTextStyle(fill) };
      }
      // Spacers — same blue as everywhere.
      ppkRow[COL.spacerF - 1] = { v: "", t: "s", s: spacerCellStyle() };
      ppkRow[COL.spacerH - 1] = { v: "", t: "s", s: spacerCellStyle() };
      ppkRow[COL.spacerJ - 1] = { v: "", t: "s", s: spacerCellStyle() };
      ppkRow[COL.spacerL - 1] = { v: "", t: "s", s: spacerCellStyle() };
      // PPK suffix per qty cell (only where qty > 0).
      ppkRow[COL.onHand  - 1] = { v: ppkSuffix(r.onHand  ?? 0, mult), t: "s", s: ppkSuffixStyle(fill) };
      ppkRow[COL.onOrder - 1] = { v: ppkSuffix(r.onOrder ?? 0, mult), t: "s", s: ppkSuffixStyle(fill) };
      ppkRow[COL.onPO    - 1] = { v: ppkSuffix(r.onPO    ?? 0, mult), t: "s", s: ppkSuffixStyle(fill) };
      for (let i = 0; i < numPeriods; i++) {
        const ci = COL.firstPeriod + i;
        const n = periodValueOf(r, periods[i].endDate);
        ppkRow[ci - 1] = { v: ppkSuffix(n, mult), t: "s", s: ppkSuffixStyle(fill) };
      }
      // Total column on PPK row stays empty — it's the total of the
      // qty row above; repeating it here would clutter. SUM in the
      // bottom Total row will skip this empty cell automatically.
      ppkRow[COL.total - 1] = { v: "", t: "s", s: ppkSuffixStyle(fill) };
      dataRows.push(ppkRow);
      const ppkExcelRow = nextExcelRow;
      nextExcelRow++;

      // Merge non-qty columns across the (qty, ppk) pair so they read
      // as one tall cell. xlsx-js-style merges use 0-based indexes.
      for (const ci of MERGED_PAIR_COLS) {
        merges.push({
          s: { r: qtyExcelRow - 1, c: ci - 1 },
          e: { r: ppkExcelRow - 1, c: ci - 1 },
        });
      }
    }
  });

  // ── Bottom Total row ───────────────────────────────────────────────────
  // Formulas (not hardcoded sums) so the workbook recalculates if the
  // planner edits any cell. SUM ignores text cells, so PPK follower
  // rows are skipped automatically.
  const lastDataExcelRow = nextExcelRow - 1;
  const totalRow: any[] = new Array(totalColumnCount);
  // Label "Total" goes in the Color column (E) per the planner's CSV.
  for (const ci of [COL.category, COL.subCat, COL.style, COL.description]) {
    totalRow[ci - 1] = { v: "", t: "s", s: { ...bodyTextStyle(FILL_EVEN), font: { bold: true, sz: 11, name: "Calibri" } } };
  }
  totalRow[COL.color - 1] = {
    v: "Total",
    t: "s",
    s: { ...bodyTextStyle(FILL_EVEN), font: { bold: true, sz: 11, name: "Calibri" } },
  };
  // Spacers stay #3278CC top to bottom.
  totalRow[COL.spacerF - 1] = { v: "", t: "s", s: spacerCellStyle() };
  totalRow[COL.spacerH - 1] = { v: "", t: "s", s: spacerCellStyle() };
  totalRow[COL.spacerJ - 1] = { v: "", t: "s", s: spacerCellStyle() };
  totalRow[COL.spacerL - 1] = { v: "", t: "s", s: spacerCellStyle() };
  // Numeric column sums — bold, no fill (light wash from FILL_EVEN to
  // visually anchor the row without competing with the data above).
  const totalNumStyle: any = {
    font:      { bold: true, sz: 11, name: "Calibri" },
    fill:      { fgColor: { rgb: FILL_EVEN }, patternType: "solid" },
    alignment: { horizontal: "right", vertical: "center" },
  };
  function colSumFormula(colIdx1: number): string {
    const letter = colLetter(colIdx1);
    return `SUM(${letter}2:${letter}${lastDataExcelRow})`;
  }
  totalRow[COL.onHand  - 1] = { f: colSumFormula(COL.onHand),  t: "n", s: totalNumStyle };
  totalRow[COL.onOrder - 1] = { f: colSumFormula(COL.onOrder), t: "n", s: totalNumStyle };
  totalRow[COL.onPO    - 1] = { f: colSumFormula(COL.onPO),    t: "n", s: totalNumStyle };
  for (let i = 0; i < numPeriods; i++) {
    const ci = COL.firstPeriod + i;
    totalRow[ci - 1] = { f: colSumFormula(ci), t: "n", s: totalNumStyle };
  }
  // Grand total — sum of every per-row Total in column R.
  totalRow[COL.total - 1] = {
    f: colSumFormula(COL.total),
    t: "n",
    s: { ...totalNumStyle, fill: { patternType: "none" } },
  };
  dataRows.push(totalRow);
  const totalRowExcelNum = nextExcelRow;
  nextExcelRow++;

  // ── Totals PPK row ─────────────────────────────────────────────────────
  // Mirrors the per-data-row PPK follower: shows total pack count per
  // numeric column for prepack rows, formatted "PPK<mult> × <packs>"
  // to match the on-screen grid hint. If prepack rows in this export
  // share one ppkMult (the common case — RYB153330PPK + RYB147730PPK
  // are both PPK24), the dominant mult is used; mixed-mult exports
  // get the most common mult and the packs sum is approximate.
  const prepackRows = rows.filter(r => (r.ppkMult ?? 1) > 1);
  if (prepackRows.length > 0) {
    // Dominant ppkMult — the one with the most prepack rows behind it.
    const multCounts = new Map<number, number>();
    for (const r of prepackRows) {
      const m = r.ppkMult ?? 1;
      multCounts.set(m, (multCounts.get(m) ?? 0) + 1);
    }
    const dominantMult = Array.from(multCounts.entries())
      .sort((a, b) => b[1] - a[1])[0][0];

    // Sum total packs across prepack rows for one column. qty / mult
    // per row, then sum. Excel formula won't help here because the
    // mult varies per row — compute up front and emit a string cell.
    function totalPacksForColumn(colKey: "onHand" | "onOrder" | "onPO" | { kind: "period"; idx: number }): number {
      let totalPacks = 0;
      for (const r of prepackRows) {
        let qty = 0;
        if (colKey === "onHand") qty = r.onHand ?? 0;
        else if (colKey === "onOrder") qty = r.onOrder ?? 0;
        else if (colKey === "onPO") qty = r.onPO ?? 0;
        else qty = periodValueOf(r, periods[colKey.idx].endDate);
        const mult = r.ppkMult ?? 1;
        if (qty > 0 && mult > 1) totalPacks += Math.round(qty / mult);
      }
      return totalPacks;
    }
    function packsCellValue(packs: number): string {
      if (packs === 0) return "";
      return `PPK${dominantMult} × ${packs.toLocaleString()}`;
    }

    const ppkTotalRow: any[] = new Array(totalColumnCount);
    // A-E: empty, same fill as the Total row above (FILL_EVEN) so the
    // pair reads as one block.
    for (const ci of [COL.category, COL.subCat, COL.style, COL.description, COL.color]) {
      ppkTotalRow[ci - 1] = { v: "", t: "s", s: ppkSuffixTextStyle(FILL_EVEN) };
    }
    // Spacers as everywhere.
    ppkTotalRow[COL.spacerF - 1] = { v: "", t: "s", s: spacerCellStyle() };
    ppkTotalRow[COL.spacerH - 1] = { v: "", t: "s", s: spacerCellStyle() };
    ppkTotalRow[COL.spacerJ - 1] = { v: "", t: "s", s: spacerCellStyle() };
    ppkTotalRow[COL.spacerL - 1] = { v: "", t: "s", s: spacerCellStyle() };
    // PPK pack totals for each numeric column.
    ppkTotalRow[COL.onHand  - 1] = { v: packsCellValue(totalPacksForColumn("onHand")),  t: "s", s: ppkSuffixStyle(FILL_EVEN) };
    ppkTotalRow[COL.onOrder - 1] = { v: packsCellValue(totalPacksForColumn("onOrder")), t: "s", s: ppkSuffixStyle(FILL_EVEN) };
    ppkTotalRow[COL.onPO    - 1] = { v: packsCellValue(totalPacksForColumn("onPO")),    t: "s", s: ppkSuffixStyle(FILL_EVEN) };
    for (let i = 0; i < numPeriods; i++) {
      const ci = COL.firstPeriod + i;
      ppkTotalRow[ci - 1] = {
        v: packsCellValue(totalPacksForColumn({ kind: "period", idx: i })),
        t: "s",
        s: ppkSuffixStyle(FILL_EVEN),
      };
    }
    // Total column also gets a packs sum (sum of all period pack
    // counts for that row equivalent — but for the Totals PPK row we
    // sum across periods of the prepack subset).
    let grandPacks = 0;
    for (let i = 0; i < numPeriods; i++) {
      grandPacks += totalPacksForColumn({ kind: "period", idx: i });
    }
    ppkTotalRow[COL.total - 1] = {
      v: packsCellValue(grandPacks),
      t: "s",
      s: ppkSuffixStyle(FILL_EVEN),
    };
    dataRows.push(ppkTotalRow);
    const ppkTotalExcelNum = nextExcelRow;
    nextExcelRow++;

    // Merge non-qty cells across the (Total, Totals PPK) pair, same
    // pattern as the data prepack pairs — text cols + spacers + Total
    // col span both rows; quantity columns stay split.
    for (const ci of MERGED_PAIR_COLS) {
      merges.push({
        s: { r: totalRowExcelNum - 1, c: ci - 1 },
        e: { r: ppkTotalExcelNum - 1, c: ci - 1 },
      });
    }
  }

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

  // Row heights — header taller; qty rows default; PPK follower rows
  // (data + totals) shorter since they only carry 5.5pt suffix text;
  // bottom Total row matches header height.
  const HEADER_HPT = 22;
  const QTY_ROW_HPT = 15;
  const PPK_ROW_HPT = 11;     // just enough for 5.5pt with breathing room
  const TOTAL_ROW_HPT = 18;
  const rowsHeight: any[] = [{ hpt: HEADER_HPT }];
  for (const r of rows) {
    rowsHeight.push({ hpt: QTY_ROW_HPT });
    if ((r.ppkMult ?? 1) > 1) rowsHeight.push({ hpt: PPK_ROW_HPT });
  }
  rowsHeight.push({ hpt: TOTAL_ROW_HPT });
  // Totals PPK row only added when the dataset has prepack rows.
  if (rows.some(r => (r.ppkMult ?? 1) > 1)) {
    rowsHeight.push({ hpt: PPK_ROW_HPT });
  }
  ws["!rows"] = rowsHeight;

  // Merged cells for the prepack pairs (text cols + spacers + Total
  // span both the qty row and its PPK follower row). Quantity cells
  // stay separate so qty above / PPK below.
  if (merges.length > 0) {
    ws["!merges"] = merges;
  }
  // No frozen panes, no autofilter — only merges are intentional, and
  // only on prepack pairs.

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
