import XLSXStyle from "xlsx-js-style";
import type { ATSRow } from "./types";
import { fmtDate } from "./helpers";

export function exportToExcel(rows: ATSRow[], periods: Array<{ endDate: string; label: string }>, atShip = false) {
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
  const fixedHdrs = ["SKU", "Description", "Category", "Store", "On Hand", "On Order (SO)", "On PO"];
  const dateLabels = periods.map(p => p.label.replace(/\n/g, " "));
  const allHdrs = [...fixedHdrs, ...dateLabels];

  // ── Header row ──────────────────────────────────────────────────────────
  const headerRow = allHdrs.map((h, ci) => ({
    v: h,
    t: "s",
    s: ci < 2 ? HDR_LEFT : ci >= 4 ? HDR_NUM : HDR,
  }));

  // ── Data rows ───────────────────────────────────────────────────────────
  const dataRows = rows.map((r, ri) => {
    const isEven = ri % 2 === 0;
    const base   = isEven ? cellEven : cellOdd;
    const numB   = isEven ? numEven  : numOdd;
    const todayQ = r.dates[fmtDate(new Date())] ?? r.onHand;

    return [
      { v: r.sku,              t: "s", s: { ...base, font: { bold: true, color: { rgb: "1F497D" }, sz: 11, name: "Calibri" } } },
      { v: r.description,      t: "s", s: base },
      { v: r.category ?? "",   t: "s", s: base },
      { v: r.store ?? "ROF",   t: "s", s: base },
      { v: r.onHand,           t: "n", s: todayQ <= 0 ? outStyle(numB) : todayQ <= 10 ? lowStyle(numB) : numB },
      { v: r.onCommitted || 0, t: "n", s: numB },
      { v: r.onOrder    || 0,  t: "n", s: numB },
      ...periods.map(p => {
        const q = atShip ? (r.freeMap?.[p.endDate] ?? r.dates[p.endDate]) : r.dates[p.endDate];
        if (q == null || q === 0) return { v: "", t: "s", s: base };
        const nb = numB;
        const style = q < 0 ? negStyle(nb) : q <= 10 ? lowStyle(nb) : nb;
        return { v: q, t: "n", s: style };
      }),
    ];
  });

  // ── Build worksheet ─────────────────────────────────────────────────────
  const aoa = [headerRow, ...dataRows];
  const ws  = (XLSXStyle.utils.aoa_to_sheet as any)(aoa, { skipHeader: true });

  // Column widths
  ws["!cols"] = [
    { wch: 20 }, // SKU
    { wch: 34 }, // Description
    { wch: 16 }, // Category
    { wch: 10 }, // Store
    { wch: 11 }, // On Hand
    { wch: 14 }, // On Order
    { wch: 10 }, // On PO
    ...periods.map(() => ({ wch: 13 })),
  ];

  // Row height for header
  ws["!rows"] = [{ hpt: 20 }];

  // Freeze: row 1 (header) + first 3 columns (SKU, Description, Category)
  ws["!freeze"] = { xSplit: 3, ySplit: 1 };

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
