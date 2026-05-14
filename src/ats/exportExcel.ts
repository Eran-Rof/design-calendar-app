import XLSXStyle from "xlsx-js-style";
import type { ATSRow } from "./types";
import { fmtDate, displayColor } from "./helpers";

export function exportToExcel(
  rows: ATSRow[],
  periods: Array<{ endDate: string; label: string }>,
  atShip = false,
  hiddenColumns: string[] = [],
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

  // ── Columns ─────────────────────────────────────────────────────────────
  // Mirror the on-screen grid exactly. Order + labels match STICKY_COL_META
  // in panels/GridTable.tsx; values use master_* (the same fields the grid
  // reads). Columns the operator has hidden in the grid drop out of the
  // export too — "exactly what's on the screen" includes the hide list.
  // SKU + Store are intentionally NOT included: the grid identifies a row
  // by Style + Color (sizes are merged), so adding either back would
  // diverge from the screen layout.
  type FixedCol = {
    key: "category" | "subCategory" | "style" | "description" | "color" | "onHand" | "onOrder" | "onPO";
    label: string;
    numeric: boolean;
    get: (r: ATSRow) => string | number;
    width: number;
  };
  const ALL_FIXED_COLS: FixedCol[] = [
    { key: "category",    label: "Category",    numeric: false, width: 16, get: (r) => r.master_category ?? r.category ?? "" },
    { key: "subCategory", label: "Sub Cat",     numeric: false, width: 16, get: (r) => r.master_sub_category ?? "" },
    { key: "style",       label: "Style",       numeric: false, width: 14, get: (r) => r.master_style ?? "" },
    { key: "description", label: "Description", numeric: false, width: 34, get: (r) => r.description },
    { key: "color",       label: "Color",       numeric: false, width: 16, get: (r) => displayColor(r) },
    { key: "onHand",      label: "On Hand",     numeric: true,  width: 11, get: (r) => r.onHand },
    { key: "onOrder",     label: "On Order",    numeric: true,  width: 11, get: (r) => r.onOrder || 0 },
    { key: "onPO",        label: "On PO",       numeric: true,  width: 11, get: (r) => r.onPO || 0 },
  ];
  const hidden = new Set(hiddenColumns);
  const fixedCols = ALL_FIXED_COLS.filter((c) => !hidden.has(c.key));
  const dateLabels = periods.map((p) => p.label.replace(/\n/g, " "));
  const allHdrs = [...fixedCols.map((c) => c.label), ...dateLabels];

  // Find onHand's index in the surviving fixed set — drives the "today
  // qty colors the value" logic so we don't double-paint when On Hand is
  // hidden. -1 = column hidden, no coloring needed.
  const onHandIdx = fixedCols.findIndex((c) => c.key === "onHand");

  // ── Header row ──────────────────────────────────────────────────────────
  const headerRow = allHdrs.map((h, ci) => {
    const isFixed = ci < fixedCols.length;
    const isNumericFixed = isFixed && fixedCols[ci].numeric;
    const isDate = ci >= fixedCols.length; // every date column is numeric/right-aligned
    return {
      v: h,
      t: "s",
      s: !isFixed && isDate ? HDR_NUM : isNumericFixed ? HDR_NUM : HDR_LEFT,
    };
  });

  // ── Data rows ───────────────────────────────────────────────────────────
  const dataRows = rows.map((r, ri) => {
    const isEven = ri % 2 === 0;
    const base   = isEven ? cellEven : cellOdd;
    const numB   = isEven ? numEven  : numOdd;
    const todayQ = r.dates[fmtDate(new Date())] ?? r.onHand;
    const onHandStyle = todayQ <= 0 ? outStyle(numB) : todayQ <= 10 ? lowStyle(numB) : numB;

    const fixedCells = fixedCols.map((c, ci) => {
      const v = c.get(r);
      if (c.numeric) {
        // On Hand picks up the heat-map color of the current-day value
        // so the export matches the grid's color treatment. Other
        // numeric fixed cols (On Order, On PO) stay plain.
        const style = c.key === "onHand" && ci === onHandIdx ? onHandStyle : numB;
        return { v, t: "n", s: style };
      }
      // Style column gets the SKU-style bold/blue treatment the old
      // export gave SKU — preserves visual emphasis on the row's identity.
      const styleForText = c.key === "style"
        ? { ...base, font: { bold: true, color: { rgb: "1F497D" }, sz: 11, name: "Calibri" } }
        : base;
      return { v, t: "s", s: styleForText };
    });

    const dateCells = periods.map((p) => {
      const q = atShip ? (r.freeMap?.[p.endDate] ?? r.dates[p.endDate]) : r.dates[p.endDate];
      if (q == null || q === 0) return { v: "", t: "s", s: base };
      const style = q < 0 ? negStyle(numB) : q <= 10 ? lowStyle(numB) : numB;
      return { v: q, t: "n", s: style };
    });

    return [...fixedCells, ...dateCells];
  });

  // ── Build worksheet ─────────────────────────────────────────────────────
  const aoa = [headerRow, ...dataRows];
  const ws  = (XLSXStyle.utils.aoa_to_sheet as any)(aoa, { skipHeader: true });

  // Column widths
  ws["!cols"] = [
    ...fixedCols.map((c) => ({ wch: c.width })),
    ...periods.map(() => ({ wch: 13 })),
  ];

  // Row height for header
  ws["!rows"] = [{ hpt: 20 }];

  // Freeze: row 1 (header) + Style column (so the planner can scroll
  // dates while keeping the row identity on screen). Mirrors the grid's
  // default freeze-through behavior (freezeKey defaults to "onPO", but
  // freezing 8 columns in Excel is overkill — pin Style as a sensible
  // anchor).
  const styleIdx = fixedCols.findIndex((c) => c.key === "style");
  ws["!freeze"] = { xSplit: styleIdx >= 0 ? styleIdx + 1 : fixedCols.length, ySplit: 1 };

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

// ── Main Component ────────────────────────────────────────────────────────────
