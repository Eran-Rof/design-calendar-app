import XLSXStyle from "xlsx-js-style";
import type { ATSRow } from "./types";
import { fmtDate, displayColor } from "./helpers";
import type { GridTotals } from "./computeTotals";

// Export the ATS grid to an Excel workbook. Layout matches the on-screen
// table: Category / Sub Cat / Style / Description / Color, blank spacer,
// On Hand, blank spacer, On Order, blank spacer, On PO, blank spacer,
// every visible period column, then either a row-total column + a
// one-line bottom Total row (no-totals mode) OR a 5-row totals stack
// (Qty / Cost $ / Sale $ / Mrgn $ / Mrgn %, totals-on mode). Column
// widths auto-fit to the widest content the planner can see.
export function exportToExcel(
  rows: ATSRow[],
  periods: Array<{ endDate: string; label: string }>,
  atShip = false,
  hiddenColumns: string[] = [],
  // When provided (TOTALS toggle on), append a 5-row Cost/Sale/Margin
  // stack and DROP the right-side Total column + simple bottom Total
  // row — the rich stack supersedes them. Null = simple totals layout.
  totals: GridTotals | null = null,
) {
  // Skip rows whose availability is zero across every visible period —
  // they contribute nothing to a planning conversation. Negatives are
  // KEPT (shortages matter); positives are kept (visible stock).
  // Uses the same atShip-aware value lookup the grid does.
  const hasAnyAvailability = (r: ATSRow): boolean => {
    for (const p of periods) {
      const v = atShip ? (r.freeMap?.[p.endDate] ?? r.dates[p.endDate]) : r.dates[p.endDate];
      if (v !== 0 && v != null) return true;
    }
    return false;
  };
  rows = rows.filter(hasAnyAvailability);

  // ── Styles ──────────────────────────────────────────────────────────────
  const HDR: any = {
    font:      { bold: true, color: { rgb: "FFFFFF" }, sz: 11, name: "Calibri" },
    fill:      { fgColor: { rgb: "1F497D" }, patternType: "solid" },
    alignment: { horizontal: "center", vertical: "center", wrapText: false },
    border: {
      top:    { style: "thin", color: { rgb: "4472C4" } },
      bottom: { style: "medium", color: { rgb: "4472C4" } },
      left:   { style: "thin", color: { rgb: "4472C4" } },
      right:  { style: "thin", color: { rgb: "4472C4" } },
    },
  };
  const HDR_LEFT: any = { ...HDR, alignment: { horizontal: "left", vertical: "center" } };
  const HDR_NUM:  any = { ...HDR, alignment: { horizontal: "right", vertical: "center" } };

  const cellEven: any = {
    fill:      { fgColor: { rgb: "EEF3FA" }, patternType: "solid" },
    alignment: { horizontal: "left", vertical: "center" },
    border: { left: { style: "thin", color: { rgb: "D0D8E4" } }, right: { style: "thin", color: { rgb: "D0D8E4" } } },
  };
  const cellOdd: any = {
    fill:      { fgColor: { rgb: "FFFFFF" }, patternType: "solid" },
    alignment: { horizontal: "left", vertical: "center" },
    border: { left: { style: "thin", color: { rgb: "D0D8E4" } }, right: { style: "thin", color: { rgb: "D0D8E4" } } },
  };
  const numEven: any = { ...cellEven, alignment: { horizontal: "right", vertical: "center" } };
  const numOdd:  any = { ...cellOdd,  alignment: { horizontal: "right", vertical: "center" } };
  const negStyle = (base: any): any => ({ ...base, font: { bold: true, color: { rgb: "C00000" }, sz: 11, name: "Calibri" } });
  const lowStyle = (base: any): any => ({ ...base, font: { bold: true, color: { rgb: "7F6000" }, sz: 11, name: "Calibri" }, fill: { fgColor: { rgb: "FFEB9C" }, patternType: "solid" } });
  const outStyle = (base: any): any => ({ ...base, font: { bold: true, color: { rgb: "9C0006" }, sz: 11, name: "Calibri" }, fill: { fgColor: { rgb: "FFC7CE" }, patternType: "solid" } });
  const TOTAL_LABEL_STYLE: any = {
    font:      { bold: true, color: { rgb: "FFFFFF" }, sz: 11, name: "Calibri" },
    fill:      { fgColor: { rgb: "1F497D" }, patternType: "solid" },
    alignment: { horizontal: "left", vertical: "center" },
    border: {
      top:    { style: "medium", color: { rgb: "4472C4" } },
      bottom: { style: "thin",   color: { rgb: "4472C4" } },
      left:   { style: "thin",   color: { rgb: "4472C4" } },
      right:  { style: "thin",   color: { rgb: "4472C4" } },
    },
  };
  const TOTAL_NUM_STYLE: any = { ...TOTAL_LABEL_STYLE, alignment: { horizontal: "right", vertical: "center" } };
  const TOTAL_BLANK_STYLE: any = { ...TOTAL_LABEL_STYLE };

  // ── Column model ────────────────────────────────────────────────────────
  // Build one ordered list that drives header, data, total row, and the
  // !cols width array. Each entry knows its kind so the spacers + Total
  // column behavior stays declarative.
  type ColumnKind = "text" | "qty" | "spacer" | "period" | "rowTotal";
  interface Col {
    key: string;       // unique id; spacers get "_sp1" / "_sp2" etc.
    label: string;     // header label ("" for spacers)
    kind: ColumnKind;
    width?: number;    // wch hint (auto-fit overrides)
    // Returns the raw value for a given row. Numbers for qty / period /
    // rowTotal; strings for text; "" for spacer.
    getValue: (r: ATSRow) => string | number;
    // Column sum for the bottom TOTAL row. Returns "" to leave blank.
    totalValue: (rows: ATSRow[]) => string | number;
  }

  const hidden = new Set(hiddenColumns);
  const today = fmtDate(new Date());
  const periodValueOf = (r: ATSRow, endDate: string): number => {
    const v = atShip ? (r.freeMap?.[endDate] ?? r.dates[endDate]) : r.dates[endDate];
    return typeof v === "number" ? v : 0;
  };
  const sumPeriods = (r: ATSRow): number => {
    let s = 0;
    for (const p of periods) s += periodValueOf(r, p.endDate);
    return s;
  };

  const TEXT_COLS: Col[] = ([
    { key: "category",    label: "Category",    kind: "text" as ColumnKind, getValue: (r: ATSRow) => r.master_category ?? r.category ?? "" },
    { key: "subCategory", label: "Sub Cat",     kind: "text" as ColumnKind, getValue: (r: ATSRow) => r.master_sub_category ?? "" },
    { key: "style",       label: "Style",       kind: "text" as ColumnKind, getValue: (r: ATSRow) => r.master_style ?? "" },
    { key: "description", label: "Description", kind: "text" as ColumnKind, getValue: (r: ATSRow) => r.description },
    { key: "color",       label: "Color",       kind: "text" as ColumnKind, getValue: (r: ATSRow) => displayColor(r) },
  ] as Array<Omit<Col, "totalValue">>).filter((c) => !hidden.has(c.key))
    .map((c) => ({ ...c, totalValue: () => "" }));

  const QTY_COLS: Col[] = ([
    { key: "onHand",  label: "On Hand",  getValue: (r: ATSRow) => r.onHand },
    { key: "onOrder", label: "On Order", getValue: (r: ATSRow) => r.onOrder || 0 },
    { key: "onPO",    label: "On PO",    getValue: (r: ATSRow) => r.onPO || 0 },
  ] as Array<{ key: string; label: string; getValue: (r: ATSRow) => number }>)
    .filter((c) => !hidden.has(c.key))
    .map((c) => ({
      key: c.key,
      label: c.label,
      kind: "qty" as ColumnKind,
      getValue: c.getValue,
      totalValue: (rs: ATSRow[]) => rs.reduce((acc, r) => acc + (Number(c.getValue(r)) || 0), 0),
    }));

  const PERIOD_COLS: Col[] = periods.map((p) => ({
    key: `period:${p.endDate}`,
    label: p.label.replace(/\n/g, " "),
    kind: "period" as ColumnKind,
    getValue: (r: ATSRow) => periodValueOf(r, p.endDate),
    totalValue: (rs: ATSRow[]) => rs.reduce((acc, r) => acc + periodValueOf(r, p.endDate), 0),
  }));

  const TOTAL_COL: Col = {
    key: "rowTotal",
    label: "Total",
    kind: "rowTotal",
    getValue: (r: ATSRow) => sumPeriods(r),
    totalValue: (rs: ATSRow[]) => rs.reduce((acc, r) => acc + sumPeriods(r), 0),
  };

  // Spacer columns sit between each group: after Color (last text), after
  // every QTY col, and after the last QTY col before the period block.
  // If a group is empty (e.g. operator hid all qty cols) we skip the
  // corresponding spacer so the worksheet doesn't carry an orphan blank.
  const SPACER = (key: string): Col => ({
    key,
    label: "",
    kind: "spacer",
    getValue: () => "",
    totalValue: () => "",
  });

  const totalsMode = totals !== null;
  const cols: Col[] = [];
  cols.push(...TEXT_COLS);
  if (TEXT_COLS.length && (QTY_COLS.length || PERIOD_COLS.length)) cols.push(SPACER("_sp_after_text"));
  for (let i = 0; i < QTY_COLS.length; i++) {
    cols.push(QTY_COLS[i]);
    // Spacer after every qty col — including the last one if periods
    // follow, matching the attached layout exactly.
    if (i < QTY_COLS.length - 1 || PERIOD_COLS.length > 0) {
      cols.push(SPACER(`_sp_after_${QTY_COLS[i].key}`));
    }
  }
  cols.push(...PERIOD_COLS);
  // Row Total column is for the simple-totals layout only — the rich
  // 5-row stack carries totals on its own rows, so the right-side
  // column is redundant when totals are on.
  if (!totalsMode) cols.push(TOTAL_COL);

  // Index of the "label cell" for the bottom TOTAL row — sits in the
  // Color column (last text col) so the row reads like the attached
  // file: ",,,,Total,," for the unhidden default. If Color is hidden,
  // falls back to the last surviving text col; if no text cols, falls
  // back to the first column overall.
  const colorIdx = cols.findIndex((c) => c.key === "color");
  const lastTextIdx = (() => {
    for (let i = cols.length - 1; i >= 0; i--) if (cols[i].kind === "text") return i;
    return 0;
  })();
  const totalLabelIdx = colorIdx >= 0 ? colorIdx : lastTextIdx;

  // ── Header row ──────────────────────────────────────────────────────────
  const headerRow = cols.map((c) => {
    let s: any;
    if (c.kind === "spacer") s = HDR;
    else if (c.kind === "text") s = HDR_LEFT;
    else s = HDR_NUM; // qty / period / rowTotal
    return { v: c.label, t: "s", s };
  });

  // ── Data rows ───────────────────────────────────────────────────────────
  const dataRows = rows.map((r, ri) => {
    const isEven = ri % 2 === 0;
    const base = isEven ? cellEven : cellOdd;
    const numB = isEven ? numEven : numOdd;
    const todayQ = r.dates[today] ?? r.onHand;
    const onHandStyle = todayQ <= 0 ? outStyle(numB) : todayQ <= 10 ? lowStyle(numB) : numB;

    return cols.map((c) => {
      const v = c.getValue(r);
      if (c.kind === "spacer") return { v: "", t: "s", s: base };
      if (c.kind === "text") {
        const styleForText = c.key === "style"
          ? { ...base, font: { bold: true, color: { rgb: "1F497D" }, sz: 11, name: "Calibri" } }
          : base;
        return { v, t: "s", s: styleForText };
      }
      // qty / period / rowTotal — all numeric
      const n = typeof v === "number" ? v : 0;
      // Blank-out zero period cells so the export reads like a planning
      // grid (matches the attached file's empty cells), but keep zeros
      // on the qty cols since "On Hand 0" is signal not noise.
      if (c.kind === "period" && (v == null || n === 0)) {
        return { v: "", t: "s", s: base };
      }
      let style = numB;
      if (c.kind === "qty" && c.key === "onHand") style = onHandStyle;
      else if (c.kind === "period") {
        style = n < 0 ? negStyle(numB) : n <= 10 ? lowStyle(numB) : numB;
      } else if (c.kind === "rowTotal") {
        style = { ...numB, font: { bold: true, color: { rgb: "1F497D" }, sz: 11, name: "Calibri" } };
      }
      return { v: n, t: "n", s: style };
    });
  });

  // ── Bottom totals ───────────────────────────────────────────────────────
  // Two modes:
  //   (a) totalsMode=false — one simple "Total" row of column sums,
  //       label sits in the Color column. Matches the attached layout.
  //   (b) totalsMode=true  — five rows of TOTAL Qty / Cost / Sale /
  //       Mrgn $ / Mrgn % derived from the GridTotals supplied by the
  //       caller. Label sits in the Color column on every row so the
  //       block reads like a labeled summary table.
  const totalsRows: any[][] = [];

  function buildSummaryRow(label: string, periodFn: (key: string) => string | number, qtyFns: { onHand: () => string | number; onOrder: () => string | number; onPO: () => string | number }) {
    return cols.map((c, idx) => {
      if (idx === totalLabelIdx) {
        return { v: label, t: "s", s: TOTAL_LABEL_STYLE };
      }
      if (c.kind === "spacer" || c.kind === "text") {
        return { v: "", t: "s", s: TOTAL_BLANK_STYLE };
      }
      if (c.kind === "qty") {
        const v = c.key === "onHand" ? qtyFns.onHand() : c.key === "onOrder" ? qtyFns.onOrder() : qtyFns.onPO();
        return { v, t: typeof v === "number" ? "n" : "s", s: TOTAL_NUM_STYLE };
      }
      if (c.kind === "period") {
        // c.key is "period:<endDate>" — strip the prefix to match the
        // GridTotals map (keyed by period.endDate, same as period.key).
        const endDate = c.key.replace(/^period:/, "");
        const v = periodFn(endDate);
        return { v, t: typeof v === "number" ? "n" : "s", s: TOTAL_NUM_STYLE };
      }
      // rowTotal — only present in no-totals mode. Use the column's
      // declared totalValue so the right-side Total reads the same as
      // the in-row Total column.
      const sum = c.totalValue(rows);
      if (typeof sum === "number") return { v: sum, t: "n", s: TOTAL_NUM_STYLE };
      return { v: sum, t: "s", s: TOTAL_NUM_STYLE };
    });
  }

  if (!totalsMode) {
    // Simple one-line Total — just column sums (qty per column).
    // Matches the attached file exactly.
    totalsRows.push(buildSummaryRow(
      "Total",
      (k) => {
        let s = 0;
        for (const r of rows) s += periodValueOf(r, k);
        return s;
      },
      {
        onHand:  () => rows.reduce((acc, r) => acc + (r.onHand || 0), 0),
        onOrder: () => rows.reduce((acc, r) => acc + (r.onOrder || 0), 0),
        onPO:    () => rows.reduce((acc, r) => acc + (r.onPO || 0), 0),
      },
    ));
  } else {
    const t = totals!;
    const fmtUSD = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const safePct = (sale: number, mrgnDollars: number) =>
      sale > 0 ? `${((mrgnDollars / sale) * 100).toFixed(1)}%` : "—";
    totalsRows.push(buildSummaryRow(
      "TOTAL Qty",
      (k) => t.periodQty[k] ?? 0,
      { onHand: () => t.onHand.qty, onOrder: () => t.onOrder.qty, onPO: () => t.onPO.qty },
    ));
    totalsRows.push(buildSummaryRow(
      "TOTAL Cost",
      (k) => fmtUSD(t.periodCost[k] ?? 0),
      { onHand: () => fmtUSD(t.onHand.cost), onOrder: () => fmtUSD(t.onOrder.cost), onPO: () => fmtUSD(t.onPO.cost) },
    ));
    totalsRows.push(buildSummaryRow(
      "TOTAL Sale",
      (k) => fmtUSD(t.periodSale[k] ?? 0),
      { onHand: () => fmtUSD(t.onHand.sale), onOrder: () => fmtUSD(t.onOrder.sale), onPO: () => fmtUSD(t.onPO.sale) },
    ));
    totalsRows.push(buildSummaryRow(
      "TOTAL Mrgn $",
      (k) => fmtUSD((t.periodSale[k] ?? 0) - (t.periodCost[k] ?? 0)),
      {
        onHand:  () => fmtUSD(t.onHand.sale - t.onHand.cost),
        onOrder: () => fmtUSD(t.onOrder.sale - t.onOrder.cost),
        onPO:    () => fmtUSD(t.onPO.sale - t.onPO.cost),
      },
    ));
    totalsRows.push(buildSummaryRow(
      "TOTAL Mrgn %",
      (k) => safePct(t.periodSale[k] ?? 0, (t.periodSale[k] ?? 0) - (t.periodCost[k] ?? 0)),
      {
        onHand:  () => safePct(t.onHand.sale,  t.onHand.sale  - t.onHand.cost),
        onOrder: () => safePct(t.onOrder.sale, t.onOrder.sale - t.onOrder.cost),
        onPO:    () => safePct(t.onPO.sale,    t.onPO.sale    - t.onPO.cost),
      },
    ));
  }

  // ── Build worksheet ─────────────────────────────────────────────────────
  const aoa = [headerRow, ...dataRows, ...totalsRows];
  const ws  = (XLSXStyle.utils.aoa_to_sheet as any)(aoa, { skipHeader: true });

  // ── Auto-fit column widths ──────────────────────────────────────────────
  // Walk every cell in the column (header + data + total) and pick the
  // longest rendered string length. Spacer columns get a fixed narrow
  // width so they read visually as gaps without taking real space.
  const SPACER_WIDTH = 2;     // wch — about half a "0" character wide
  const MIN_WIDTH = 6;
  const MAX_WIDTH = 60;       // cap so a long description doesn't blow out the row
  const PAD = 2;
  const widthOf = (v: string | number): number => {
    if (v == null) return 0;
    const s = typeof v === "number"
      ? v.toLocaleString()
      : String(v);
    return s.length;
  };
  ws["!cols"] = cols.map((c) => {
    if (c.kind === "spacer") return { wch: SPACER_WIDTH };
    let maxLen = widthOf(c.label);
    for (const r of rows) {
      const v = c.getValue(r);
      const len = widthOf(v);
      if (len > maxLen) maxLen = len;
    }
    const sum = c.totalValue(rows);
    if (sum !== "") {
      const len = widthOf(sum);
      if (len > maxLen) maxLen = len;
    }
    const wch = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, maxLen + PAD));
    return { wch };
  });

  // Header row height
  ws["!rows"] = [{ hpt: 20 }];

  // Freeze: row 1 (header) + through the Style column so the planner
  // can scroll right while keeping row identity on screen.
  const styleIdx = cols.findIndex((c) => c.key === "style");
  ws["!freeze"] = { xSplit: styleIdx >= 0 ? styleIdx + 1 : TEXT_COLS.length, ySplit: 1 };

  const wb = XLSXStyle.utils.book_new();
  XLSXStyle.utils.book_append_sheet(wb, ws, atShip ? "AT Ship Report" : "ATS Report");

  const buf  = XLSXStyle.write(wb, { bookType: "xlsx", type: "array" });
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `${atShip ? "ATShip" : "ATS"}_Report_${fmtDate(new Date())}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}
