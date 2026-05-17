// XLSX build/parse helpers for the TechPack app. Extracted from
// TechPack.tsx so the spec-sheet workbook builder, materials export,
// and spec-sheet importer can be unit-tested without mounting React.
//
// All entry points expect a globally-loaded `window.XLSX` (loaded by
// the dynamic <script> tag near the top of TechPackApp). The browser-
// only download helpers take a `showToast` callback rather than
// importing React state — keeps this module reusable from any future
// panel split (export buttons in the dashboard, modal previews, etc).

import type { SpecSheet, SpecSheetRow, Material } from "./types";
import { uid, today } from "./utils";

type ToastFn = (msg: string) => void;

function getXLSX(showToast?: ToastFn): any | null {
  const X = (window as any).XLSX;
  if (!X) {
    showToast?.("Excel library loading — try again in a moment");
    return null;
  }
  return X;
}

/**
 * Build a styled spec-sheet workbook (navy/gold header, base-size
 * highlight, alternating row fills) for an `.xlsx` download. Returns
 * the workbook object or null if XLSX isn't loaded yet.
 *
 * `isTemplate=true` blanks the metadata cells so the file can serve
 * as a fillable template.
 */
export function buildSpecSheetWb(
  sheet: SpecSheet,
  isTemplate: boolean,
  showToast?: ToastFn,
): any {
  const XLSX = getXLSX(showToast);
  if (!XLSX) return null;

  const sizes = sheet.sizes;
  const n = sizes.length;
  // Col layout: 0=spacer  1=POM letter  2=Description  3=TOL  4..4+n-1=sizes
  const C_SPC = 0, C_POM = 1, C_DESC = 2, C_TOL = 3, C_SZ = 4;
  const totalCols = C_SZ + n;
  const baseSzIdx = Math.floor(n / 2);

  // ── Cell helpers ─────────────────────────────────────────────────────────
  const ws: any = {};
  const merges: any[] = [];
  const ec = (r: number, c: number) => XLSX.utils.encode_cell({ r, c });
  const thin = (rgb = "BBCBD9") => ({ style: "thin" as const, color: { rgb } });
  const bdr  = (rgb = "BBCBD9") => ({ top: thin(rgb), bottom: thin(rgb), left: thin(rgb), right: thin(rgb) });

  const cell = (r: number, c: number, v: any, s: any) => {
    const a = ec(r, c);
    const t = v === null || v === "" || v === undefined ? "z" : typeof v === "number" ? "n" : "s";
    ws[a] = { v: v ?? "", t, s };
  };
  const blankCell = (r: number, c: number, fill: string) =>
    cell(r, c, "", { fill: { fgColor: { rgb: fill } } });
  const merge = (r1: number, c1: number, r2: number, c2: number) =>
    merges.push({ s: { r: r1, c: c1 }, e: { r: r2, c: c2 } });

  // ── Colors ───────────────────────────────────────────────────────────────
  const NAVY  = "1B2A4A", GOLD = "C9A84C", LTBLUE = "EEF4FC";
  const SECBL = "4A6FA5", BASEBG = "1A5276", BASEFG = "FFD700";
  const WHITE = "FFFFFF", DARK  = "3C3C3C", RED    = "C0392B";
  const FILLS = ["EEF4FC", "FFFFFF"];
  const DBLU  = "D6E4F7"; // base size cell bg in data rows

  let r = 0;

  // ── Row 0: spacer ────────────────────────────────────────────────────────
  r++; // start writing at r=1

  // ── Row 1: Title (navy, bold, white) ─────────────────────────────────────
  const titleTxt = sheet.styleName
    ? `TECHNICAL SPECIFICATION  ·  ${sheet.styleName.toUpperCase()}`
    : "TECHNICAL SPECIFICATION  ·  SPEC SHEET";
  cell(r, C_POM, titleTxt, {
    fill: { fgColor: { rgb: NAVY } }, font: { bold: true, sz: 14, name: "Arial", color: { rgb: WHITE } },
    alignment: { horizontal: "center", vertical: "center" },
  });
  merge(r, C_POM, r, totalCols - 1);
  for (let c = C_DESC; c < totalCols; c++) blankCell(r, c, NAVY);
  blankCell(r, C_SPC, NAVY);
  r++;

  // ── Row 2: Subtitle (gold, small, white) ──────────────────────────────────
  const baseSize = sizes[baseSzIdx] || sizes[0] || "—";
  cell(r, C_POM, `GRADE RULE MEASUREMENT CHART  |  BASE SIZE: ${baseSize}  |  UNIT: INCHES  |  MEASUREMENTS ARE TOTAL (DOUBLED)`, {
    fill: { fgColor: { rgb: GOLD } }, font: { sz: 8, name: "Arial", color: { rgb: WHITE } },
    alignment: { horizontal: "center", vertical: "center" },
  });
  merge(r, C_POM, r, totalCols - 1);
  for (let c = C_DESC; c < totalCols; c++) blankCell(r, c, GOLD);
  blankCell(r, C_SPC, GOLD);
  r++;

  // ── Rows 3–5: Metadata (3 rows, 3 label/value pairs each) ────────────────
  const lblSty = { fill: { fgColor: { rgb: LTBLUE } }, font: { bold: true, sz: 9, name: "Arial", color: { rgb: NAVY } }, alignment: { horizontal: "right", vertical: "center" }, border: bdr("C0C8D4") };
  const valSty = { fill: { fgColor: { rgb: WHITE } }, font: { sz: 9, name: "Arial", color: { rgb: DARK } }, alignment: { horizontal: "left", vertical: "center" }, border: bdr("C0C8D4") };
  const meta = [
    ["Style #:", isTemplate ? "" : sheet.styleNumber,  "Season:", isTemplate ? "" : sheet.season,   "Vendor:", ""],
    ["Style Name / Fit:", isTemplate ? "" : sheet.styleName, "Issue Date:", "", "Customer:", isTemplate ? "" : sheet.brand],
    ["Brand:", isTemplate ? "" : (sheet.brand || ""),  "Category:", isTemplate ? "" : sheet.category, "Sub Category:", isTemplate ? "" : ((sheet as any).subCategory || "")],
  ];
  // Split available cols (1..totalCols-1) into 3 bands; label=2 cols, value=rest
  const bandW = Math.floor((totalCols - 1) / 3);
  for (const [l1, v1, l2, v2, l3, v3] of meta) {
    const bands = [[1, l1, v1], [1 + bandW, l2, v2], [1 + bandW * 2, l3, v3]] as [number, string, string][];
    for (const [start, lbl, val] of bands) {
      const lblEnd = start + 1, valEnd = Math.min(start + bandW - 1, totalCols - 1);
      cell(r, start, lbl, lblSty); blankCell(r, start + 1, LTBLUE); merge(r, start, r, lblEnd);
      cell(r, start + 2, val, valSty);
      for (let c = start + 3; c <= valEnd; c++) blankCell(r, c, WHITE);
      merge(r, start + 2, r, valEnd);
    }
    blankCell(r, C_SPC, LTBLUE);
    r++;
  }

  // ── Row 6: Column headers ─────────────────────────────────────────────────
  const hdr = (bg: string, fg: string, bold = true) => ({
    fill: { fgColor: { rgb: bg } }, font: { bold, sz: 8, name: "Arial", color: { rgb: fg } },
    alignment: { horizontal: "center", vertical: "center", wrapText: true }, border: bdr("0F2840"),
  });
  blankCell(r, C_SPC, NAVY);
  cell(r, C_POM,  "POM",         hdr(NAVY, WHITE));
  cell(r, C_DESC, "DESCRIPTION", hdr(NAVY, WHITE));
  cell(r, C_TOL,  "TOL",         hdr(NAVY, WHITE));
  for (let i = 0; i < n; i++) {
    const isBase = i === baseSzIdx;
    cell(r, C_SZ + i, sizes[i], hdr(isBase ? BASEBG : NAVY, isBase ? BASEFG : WHITE));
  }
  r++;

  // ── Data rows ─────────────────────────────────────────────────────────────
  let fillIdx = 0;
  for (const row of sheet.rows) {
    if (row.isSection) {
      // Section header: full-width medium blue
      blankCell(r, C_SPC, SECBL);
      cell(r, C_POM, row.pointOfMeasure, {
        fill: { fgColor: { rgb: SECBL } }, font: { bold: true, sz: 9, name: "Arial", color: { rgb: WHITE } },
        alignment: { horizontal: "left", vertical: "center" }, border: bdr("2D4A6A"),
      });
      merge(r, C_POM, r, totalCols - 1);
      for (let c = C_DESC; c < totalCols; c++) cell(r, c, "", { fill: { fgColor: { rgb: SECBL } }, border: bdr("2D4A6A") });
      fillIdx = 0;
      r++;
    } else {
      const fh = FILLS[fillIdx % 2]; fillIdx++;
      // Parse POM letter (pattern: "A  Description" or "AA  Description")
      const m = row.pointOfMeasure.match(/^([A-Z]{1,2})\s{2,}(.+)/);
      const letter = m ? m[1] : "";
      const desc   = m ? m[2] : row.pointOfMeasure;
      blankCell(r, C_SPC, fh);
      cell(r, C_POM,  letter,        { fill: { fgColor: { rgb: fh } }, font: { bold: true, sz: 8, name: "Arial", color: { rgb: "6B6B6B" } }, alignment: { horizontal: "center", vertical: "center" }, border: bdr() });
      cell(r, C_DESC, desc,          { fill: { fgColor: { rgb: fh } }, font: { bold: true, sz: 9, name: "Arial", color: { rgb: DARK } },    alignment: { horizontal: "left",   vertical: "center", wrapText: true }, border: bdr() });
      cell(r, C_TOL,  row.tolerance, { fill: { fgColor: { rgb: fh } }, font: { bold: true, sz: 9, name: "Arial", color: { rgb: RED } },     alignment: { horizontal: "center", vertical: "center" }, border: bdr() });
      for (let i = 0; i < n; i++) {
        const isBase = i === baseSzIdx;
        const bg = isBase ? DBLU : fh;
        const rawVal = row.values[sizes[i]] ?? "";
        const val = rawVal === "" ? "" : (isNaN(Number(rawVal)) ? rawVal : Number(rawVal));
        cell(r, C_SZ + i, val, {
          fill: { fgColor: { rgb: bg } },
          font: { bold: isBase, sz: 9, name: "Arial", color: { rgb: NAVY } },
          alignment: { horizontal: "center", vertical: "center" },
          border: bdr(),
        });
      }
      r++;
    }
  }

  // If template with no rows, add empty POM rows
  if (sheet.rows.length === 0) {
    for (let i = 0; i < 8; i++) {
      const fh = FILLS[i % 2];
      blankCell(r, C_SPC, fh);
      cell(r, C_POM,  "", { fill: { fgColor: { rgb: fh } }, border: bdr() });
      cell(r, C_DESC, "", { fill: { fgColor: { rgb: fh } }, border: bdr(), alignment: { horizontal: "left", vertical: "center" } });
      cell(r, C_TOL,  "", { fill: { fgColor: { rgb: fh } }, border: bdr() });
      for (let j = 0; j < n; j++) {
        cell(r, C_SZ + j, "", { fill: { fgColor: { rgb: j === baseSzIdx ? DBLU : fh } }, border: bdr() });
      }
      r++;
    }
  }

  // ── Finalize ──────────────────────────────────────────────────────────────
  ws["!ref"]    = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: r - 1, c: totalCols - 1 } });
  ws["!merges"] = merges;
  ws["!cols"]   = [
    { wch: 2.5 }, { wch: 6 }, { wch: 34 }, { wch: 8 },
    ...sizes.map((_: any, i: number) => ({ wch: i === baseSzIdx ? 9 : 7.5 })),
  ];
  const rowH: any[] = [
    { hpt: 6 }, { hpt: 22 }, { hpt: 16 },
    { hpt: 18 }, { hpt: 18 }, { hpt: 18 }, // meta rows
    { hpt: 22 }, // col headers
  ];
  for (const row of sheet.rows) rowH.push({ hpt: row.isSection ? 18 : 17 });
  if (sheet.rows.length === 0) for (let i = 0; i < 8; i++) rowH.push({ hpt: 18 });
  ws["!rows"] = rowH;

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Spec Sheet");
  return wb;
}

/** Trigger a browser download for a built workbook. No-op if XLSX isn't loaded. */
export function xlsxDownload(wb: any, filename: string, showToast?: ToastFn): void {
  const XLSX = getXLSX(showToast);
  if (!XLSX) return;
  try {
    const out = XLSX.write(wb, { bookType: "xlsx", type: "buffer" });
    const blob = new Blob([out], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (e) {
    console.error("Excel download error:", e);
    showToast?.("Excel download failed — see console");
  }
}

export function downloadSpecSheetExcel(sheet: SpecSheet, showToast?: ToastFn): void {
  const wb = buildSpecSheetWb(sheet, false, showToast);
  if (wb) xlsxDownload(wb, `SpecSheet_${sheet.styleNumber || sheet.styleName}.xlsx`, showToast);
}

export function downloadSpecSheetTemplate(sizes: string[], showToast?: ToastFn): void {
  const dummy: SpecSheet = { id: "", styleName: "", styleNumber: "", brand: "", season: "", category: "", description: "", sizes, rows: [], createdAt: today(), updatedAt: today() };
  const wb = buildSpecSheetWb(dummy, true, showToast);
  if (wb) xlsxDownload(wb, "SpecSheet_Template.xlsx", showToast);
}

/** Materials library export — full table with styled header + alternating row fills. */
export function downloadMaterialsExcel(mats: Material[], showToast?: ToastFn): void {
  const XLSX = getXLSX(showToast);
  if (!XLSX) return;
  const makeBorder = () => { const bdr = { style: "thin", color: { rgb: "CBD5E0" } }; return { top: bdr, bottom: bdr, left: bdr, right: bdr }; };
  const wb = XLSX.utils.book_new();
  const headers = ["Name", "Type", "Composition", "Weight", "Width", "Color", "Supplier", "Unit Price", "MOQ", "Lead Time", "Certifications", "Notes"];
  const aoa: any[][] = [];

  // Title row
  const titleRow: any[] = ["MATERIALS LIBRARY"];
  for (let i = 1; i < headers.length; i++) titleRow.push(null);
  aoa.push(titleRow);

  // Header row
  aoa.push([...headers]);

  // Data rows
  mats.forEach(m => {
    aoa.push([m.name, m.type, m.composition, m.weight, m.width, m.color, m.supplier, m.unitPrice, m.moq, m.leadTime, m.certifications.join(", "), m.notes]);
  });

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const totalCols = headers.length;

  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: totalCols - 1 } }];

  // Auto column widths
  const colWidths = headers.map((h: string) => ({ wch: Math.max(h.length + 2, 14) }));
  mats.forEach(m => {
    const row = [m.name, m.type, m.composition, m.weight, m.width, m.color, m.supplier, String(m.unitPrice), m.moq, m.leadTime, m.certifications.join(", "), m.notes];
    row.forEach((val, i) => { if (val && val.length + 2 > (colWidths[i]?.wch || 0)) colWidths[i] = { wch: Math.min(val.length + 2, 40) }; });
  });
  ws["!cols"] = colWidths;

  const navyBg = { fgColor: { rgb: "1E3A8A" } };
  const blueBg = { fgColor: { rgb: "2563EB" } };
  const whiteFg = { rgb: "FFFFFF" };

  // Title
  const titleAddr = XLSX.utils.encode_cell({ r: 0, c: 0 });
  ws[titleAddr].s = { fill: navyBg, font: { bold: true, color: whiteFg, sz: 14 }, alignment: { horizontal: "center" }, border: makeBorder() };

  // Headers
  for (let c = 0; c < totalCols; c++) {
    const addr = XLSX.utils.encode_cell({ r: 1, c });
    if (!ws[addr]) ws[addr] = { t: "z" };
    ws[addr].s = { fill: blueBg, font: { bold: true, color: whiteFg, sz: 11 }, alignment: { horizontal: "center" }, border: makeBorder() };
  }

  // Data rows
  mats.forEach((_m, idx) => {
    const rowIdx = idx + 2;
    const bg = idx % 2 === 0 ? { fgColor: { rgb: "0F172A" } } : { fgColor: { rgb: "1A2332" } };
    for (let c = 0; c < totalCols; c++) {
      const addr = XLSX.utils.encode_cell({ r: rowIdx, c });
      if (!ws[addr]) ws[addr] = { t: "z" };
      ws[addr].s = {
        fill: bg,
        font: { bold: c === 0, color: c === 0 ? { rgb: "60A5FA" } : whiteFg, sz: 11 },
        border: makeBorder(),
      };
    }
  });

  XLSX.utils.book_append_sheet(wb, ws, "Materials");
  xlsxDownload(wb, "Materials_Library.xlsx", showToast);
}

/**
 * Parse a spec-sheet `.xlsx` file into rows + sizes. Supports two
 * shapes:
 *   1. **New format** — header row has `POM` in col 0 and "BLOCK ..."
 *      in col 1, with size labels living in the row above at cols
 *      6, 8, 10, … (every other col). TOL lives in col 5; size
 *      values follow at cols 6, 8, 10, ….
 *   2. **Legacy flat format** — header row has "Point of Measure" or
 *      "POM" in col 0, TOL in col 1, sizes in cols 2+.
 * Rejects when no recognizable header row is present.
 */
export function parseSpecSheetExcel(file: File): Promise<{ rows: SpecSheetRow[]; sizes: string[] }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const XLSX = (window as any).XLSX;
        if (!XLSX) { reject(new Error("Excel library not loaded")); return; }
        const data = e.target?.result;
        const wb = XLSX.read(data, { type: "binary" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const aoa: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
        const parsed = parseSpecSheetAoa(aoa);
        if (!parsed) { reject(new Error("Could not find spec sheet header row")); return; }
        resolve(parsed);
      } catch (err) { reject(err); }
    };
    reader.onerror = reject;
    reader.readAsBinaryString(file);
  });
}

/**
 * Pure parser separated from the FileReader plumbing so tests can
 * exercise the format-detection logic without faking the browser
 * FileReader API. Returns null when no header row matches either
 * format.
 */
export function parseSpecSheetAoa(aoa: any[][]): { rows: SpecSheetRow[]; sizes: string[] } | null {
  let sizesRowIdx = -1;
  let headerRowIdx = -1;
  let sizes: string[] = [];
  let newFormat = false;

  for (let i = 0; i < aoa.length; i++) {
    const row = aoa[i];
    const c0 = String(row[0] || "").trim().toUpperCase();
    const c1 = String(row[1] || "").trim().toUpperCase();
    if (c0 === "POM" && c1.includes("BLOCK")) {
      // New format: sizes are in the row above at cols 6,8,10,...
      headerRowIdx = i;
      sizesRowIdx = i - 1;
      newFormat = true;
      const sizeRow = aoa[sizesRowIdx] || [];
      for (let c = 6; c < sizeRow.length; c += 2) {
        const s = String(sizeRow[c] || "").trim();
        if (s) sizes.push(s);
      }
      break;
    }
    if (c0 === "POINT OF MEASURE" || c0 === "POM") {
      headerRowIdx = i;
      sizes = row.slice(2).map((s: any) => String(s).trim()).filter(Boolean);
      break;
    }
  }

  if (headerRowIdx === -1) return null;

  const rows: SpecSheetRow[] = [];
  for (let i = headerRowIdx + 1; i < aoa.length; i++) {
    const row = aoa[i];
    if (newFormat) {
      const letter = String(row[0] || "").trim();
      const desc = String(row[1] || "").trim();
      if (!desc && !letter) continue;
      const pom = desc || letter;
      const tolerance = String(row[5] || "").trim();
      const values: Record<string, string> = {};
      sizes.forEach((s, si) => {
        const v = row[6 + si * 2];
        values[s] = v !== undefined && v !== "" ? String(v) : "";
      });
      rows.push({ id: uid(), pointOfMeasure: pom, tolerance, values });
    } else {
      const pom = String(row[0] || "").trim();
      if (!pom) continue;
      const tolerance = String(row[1] || "").trim();
      const values: Record<string, string> = {};
      sizes.forEach((s, idx) => { values[s] = String(row[2 + idx] || "").trim(); });
      rows.push({ id: uid(), pointOfMeasure: pom, tolerance, values });
    }
  }

  return { rows, sizes };
}
