// Shared Excel export theme — extracted from exportExcel.ts (the ATS
// "Avail to Ship" grid export, locked in over ~20 iterations with the
// planner). Other ATS exports import these primitives so the family
// of workbooks reads as one product.
//
// Use the constants for raw colors when domain code needs a one-off
// (e.g. NegInven's red highlight for negatives). Use the style
// factories when you want a cell that already matches the family
// (header, body text/num, spacer, subtotal, total). Use applyOutlines
// at the end to draw the thick outer rectangle + optional style-group
// thick separators.

import { newWorkbook, renderStyledAoa, downloadExcelWorkbook, type ExcelJS, type AoaImage } from "../shared/excelLogo";

// ── Palette ────────────────────────────────────────────────────────────────
export const PALETTE = {
  // Header tiers
  HEADER_TEXT:   "3278CC", // text/category headers + every spacer col
  HEADER_ONHAND: "4081D0", // single tier — slightly lighter than DARK
  HEADER_DARK:   "1F497D", // On Order / On PO / period headers / total
  // Body fills
  ZEBRA_EVEN:    "EEF3FA",
  ZEBRA_ODD:     "FFFFFF",
  QTY_BAND:      "B4C7E7", // contiguous fill across the qty-col block
  // Semantic accents (also exported for callers that need raw colors)
  LOW_STOCK_FG:  "7F6000",
  LOW_STOCK_BG:  "FFEB9C",
  // Style-col text — bold accent navy
  STYLE_TEXT:    "1F497D",
  PPK_TEXT:      "B0BAC9",
} as const;

// ── Border atoms ───────────────────────────────────────────────────────────
const THICK_ATOM: any = { style: "medium", color: { rgb: PALETTE.HEADER_DARK } };
const THIN_ATOM:  any = { style: "thin",   color: { rgb: "4472C4" } };
export const EXTRA_THICK: any = { style: "thick", color: { rgb: PALETTE.HEADER_DARK } };

// Body cells: thin top/bottom, medium left/right (the per-column
// outline). Adjacent cells share the medium edge so the column reads
// as one bordered band.
export const BORDER_BODY:   any = { top: THIN_ATOM,  bottom: THIN_ATOM,  left: THICK_ATOM, right: THICK_ATOM };
// Header band: thick top/bottom frames the row, thin verticals so the
// header-cell joints stay lighter than the body column outlines.
export const BORDER_HEADER: any = { top: THICK_ATOM, bottom: THICK_ATOM, left: THIN_ATOM,  right: THIN_ATOM };
// Bottom/Total row: thick on every side — closes the table cleanly.
export const BORDER_TOTAL:  any = { top: THICK_ATOM, bottom: THICK_ATOM, left: THICK_ATOM, right: THICK_ATOM };

// ── Style factories ────────────────────────────────────────────────────────
export type Align = "left" | "center" | "right";

export function headerStyle(fill: string, align: Align): any {
  return {
    font:      { bold: true, color: { rgb: "FFFFFF" }, sz: 11, name: "Calibri" },
    fill:      { fgColor: { rgb: fill }, patternType: "solid" },
    alignment: { horizontal: align, vertical: "center", wrapText: false },
    border:    BORDER_HEADER,
  };
}

export function bodyTextStyle(fill: string, align: Align = "left"): any {
  return {
    font:      { sz: 11, name: "Calibri" },
    fill:      { fgColor: { rgb: fill }, patternType: "solid" },
    alignment: { horizontal: align, vertical: "center" },
    border:    BORDER_BODY,
  };
}

export function bodyStyleStyle(fill: string): any {
  // Style/key column: bold navy text on the zebra fill.
  return {
    font:      { sz: 11, bold: true, color: { rgb: PALETTE.STYLE_TEXT }, name: "Calibri" },
    fill:      { fgColor: { rgb: fill }, patternType: "solid" },
    alignment: { horizontal: "left", vertical: "center" },
    border:    BORDER_BODY,
  };
}

export function bodyNumStyle(fill: string): any {
  return {
    font:      { sz: 11, name: "Calibri" },
    fill:      { fgColor: { rgb: fill }, patternType: "solid" },
    // Numbers right-align (operator standard) so the total / qty / cost columns
    // read consistently across every report that shares this theme (aged inven,
    // neg inven, stock-vs-SO, incomplete, sales comps). The main ATS report
    // uses its own local styles.
    alignment: { horizontal: "right", vertical: "center" },
    border:    BORDER_BODY,
  };
}

export function bodyTotalStyle(fill: string): any {
  return {
    font:      { bold: true, sz: 11, name: "Calibri" },
    fill:      { fgColor: { rgb: fill }, patternType: "solid" },
    alignment: { horizontal: "right", vertical: "center" },
    border:    BORDER_BODY,
  };
}

export function spacerCellStyle(): any {
  // Spacer column — solid header-text fill top to bottom, no borders
  // (the column outline stops at the spacer; the spacer itself is a
  // clean colored gap between column groups).
  return {
    fill:   { fgColor: { rgb: PALETTE.HEADER_TEXT }, patternType: "solid" },
    border: {},
  };
}

export function lowStockStyle(base: any): any {
  return {
    ...base,
    font: { ...base.font, bold: true, color: { rgb: PALETTE.LOW_STOCK_FG } },
    fill: { fgColor: { rgb: PALETTE.LOW_STOCK_BG }, patternType: "solid" },
  };
}

// Subtotal / group-header row factory — used by exports that aggregate
// across groups (e.g. per-style subtotals in ATS, per-category buckets
// in NegInven). Size +10% over body so the row anchors visually.
export function subtotalTextStyle(fill: string = PALETTE.QTY_BAND, align: Align = "left"): any {
  return {
    font:      { bold: true, sz: 12.1, color: { rgb: PALETTE.STYLE_TEXT }, name: "Calibri" },
    fill:      { fgColor: { rgb: fill }, patternType: "solid" },
    alignment: { horizontal: align, vertical: "center" },
    border:    BORDER_BODY,
  };
}

export function subtotalNumStyle(fill: string = PALETTE.QTY_BAND): any {
  return {
    font:      { bold: true, sz: 12.1, color: { rgb: PALETTE.STYLE_TEXT }, name: "Calibri" },
    fill:      { fgColor: { rgb: fill }, patternType: "solid" },
    alignment: { horizontal: "right", vertical: "center" },
    border:    BORDER_BODY,
  };
}

// Bottom Total stack row — heavy bottom border so the table closes
// cleanly even when followed by another bottom-stack row above it.
export function totalLabelStyle(fill: string = PALETTE.ZEBRA_EVEN): any {
  return {
    font:      { bold: true, sz: 11, name: "Calibri" },
    fill:      { fgColor: { rgb: fill }, patternType: "solid" },
    alignment: { horizontal: "left", vertical: "center" },
    border:    BORDER_TOTAL,
  };
}

export function totalNumStyle(fill: string = PALETTE.ZEBRA_EVEN): any {
  return {
    font:      { bold: true, sz: 11, name: "Calibri" },
    fill:      { fgColor: { rgb: fill }, patternType: "solid" },
    alignment: { horizontal: "right", vertical: "center" },
    border:    BORDER_TOTAL,
  };
}

// ── Zebra helper ───────────────────────────────────────────────────────────
export function zebraFill(rowIndex: number): string {
  return rowIndex % 2 === 0 ? PALETTE.ZEBRA_EVEN : PALETTE.ZEBRA_ODD;
}

// ── Numeric cell with blank-on-zero ────────────────────────────────────────
// Operators don't want "0" cluttering quantity columns — render a blank
// string cell instead. The style is still applied so borders / fills
// stay consistent with neighboring numeric cells. Pass an existing
// numFmt through `extra` if the caller needs it (e.g. "#,##0.00").
export function numOrBlank(value: number, style: any, extra?: { numFmt?: string }): any {
  if (!Number.isFinite(value) || value === 0) {
    return { v: "", t: "s", s: style };
  }
  const s = extra?.numFmt ? { ...style, numFmt: extra.numFmt } : style;
  return { v: value, t: "n", s };
}

// ── Column letter (1-based: A=1, AA=27, ...) ───────────────────────────────
export function colLetter(idx1: number): string {
  let s = "";
  let n = idx1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ── Autofit ────────────────────────────────────────────────────────────────
// Single-pass width pass: max(string len) across header + all body
// rows, +2 padding, capped at 80. Spacer columns get a fixed narrow
// width (1.57 wch) matching exportExcel.ts.
export const SPACER_WCH = 1.57;
export const AUTOFIT_PAD = 2;
export const AUTOFIT_MAX = 80;

export interface AutofitInput {
  headerRow: any[];
  bodyRows: any[][];
  /** 1-based column indexes that should be treated as fixed-width spacers. */
  spacerCols?: Set<number>;
}

export function autofitColumns({ headerRow, bodyRows, spacerCols }: AutofitInput): Array<{ wch: number }> {
  const colCount = headerRow.length;
  const out: Array<{ wch: number }> = [];
  for (let ci1 = 1; ci1 <= colCount; ci1++) {
    if (spacerCols?.has(ci1)) {
      out.push({ wch: SPACER_WCH });
      continue;
    }
    let maxLen = 0;
    const hdr = headerRow[ci1 - 1];
    if (hdr?.v != null) maxLen = String(hdr.v).length;
    for (const row of bodyRows) {
      const cell = row[ci1 - 1];
      if (!cell) continue;
      let s: string;
      if (cell.f) s = "999,999";
      else if (typeof cell.v === "number") {
        // Estimate the DISPLAYED length, honoring the cell's number format —
        // currency ($ + grouping + decimals) and percent (×100 + "%") render
        // longer than the raw value, so sizing off raw length would clip.
        const nf: string = cell.s?.numFmt ?? "";
        if (nf.includes("$")) s = "$" + Math.abs(cell.v).toLocaleString(undefined, { minimumFractionDigits: /\.0*0/.test(nf) ? 2 : 0, maximumFractionDigits: 2 }) + (cell.v < 0 ? "-" : "");
        else if (nf.includes("%")) s = (cell.v * 100).toFixed(/0\.0/.test(nf) ? 1 : 0) + "%";
        else s = cell.v.toLocaleString();
      } else s = String(cell.v ?? "");
      if (s.length > maxLen) maxLen = s.length;
    }
    out.push({ wch: Math.min(AUTOFIT_MAX, maxLen + AUTOFIT_PAD) });
  }
  return out;
}

// ── Row heights ────────────────────────────────────────────────────────────
export const ROW_HEIGHTS = {
  HEADER:   22,
  BODY:     15,
  PPK:      11,
  SUBTOTAL: 19,
  TOTAL:    18,
} as const;

// ── Outer + style-group thick outlines ─────────────────────────────────────
// After all cells are styled, walk the AOA and overlay an EXTRA_THICK
// rectangle around the entire output AND (optionally) around each
// contiguous group of body rows sharing the same group key.
//
// rowKindAt returns "qty" for a row that owns a group identity, "ppk"
// for a follower row that inherits the previous group, or null for
// rows that should be skipped entirely from group-outline math (e.g.
// the bottom total stack).
export interface OutlineInput {
  allRows: any[][];          // header + body rows in AOA order
  totalColCount: number;
  spacerCols?: Set<number>;
  // Per-body-row group key (use the dataRows index — 0 = first body row
  // after the header). Return the same key for rows that belong to the
  // same group. Return null to skip outlining that row.
  groupKeyOf?: (dataIdx: number) => string | null;
}

export function applyOutlines({ allRows, totalColCount, spacerCols, groupKeyOf }: OutlineInput) {
  const lastAoaRow = allRows.length - 1;
  const lastColIdx = totalColCount - 1;

  // Style-group transitions: walk the body rows, mark first/last row
  // of each group. Caller-supplied groupKeyOf decides grouping; a null
  // return means "don't include this row in group outlining" (used for
  // bottom-total stack rows).
  const groupStarts = new Set<number>();
  const groupEnds = new Set<number>();
  if (groupKeyOf) {
    let prev: string | null = null;
    let lastIncluded = -1;
    for (let dataIdx = 0; dataIdx < allRows.length - 1; dataIdx++) {
      const k = groupKeyOf(dataIdx);
      if (k === null) {
        if (prev !== null && lastIncluded >= 0) groupEnds.add(lastIncluded);
        prev = null;
        continue;
      }
      if (k !== prev) {
        groupStarts.add(dataIdx);
        if (lastIncluded >= 0) groupEnds.add(lastIncluded);
        prev = k;
      }
      lastIncluded = dataIdx;
    }
    if (lastIncluded >= 0) groupEnds.add(lastIncluded);
  }

  for (let r = 0; r <= lastAoaRow; r++) {
    for (let c = 0; c <= lastColIdx; c++) {
      const cell = allRows[r]?.[c];
      if (!cell || !cell.s) continue;
      const ci1 = c + 1;
      const isSpacer = spacerCols?.has(ci1) ?? false;
      const border: any = { ...(cell.s.border ?? {}) };

      // Outer rectangle — applies to spacers too so the top edge reads
      // as one continuous line across the full table.
      if (c === 0)           border.left   = EXTRA_THICK;
      if (c === lastColIdx)  border.right  = EXTRA_THICK;
      if (r === 0)           border.top    = EXTRA_THICK;
      if (r === lastAoaRow)  border.bottom = EXTRA_THICK;

      // Style-group outline — non-spacer body cells only.
      if (!isSpacer && groupKeyOf) {
        const dataIdx = r - 1;
        if (dataIdx >= 0) {
          if (groupStarts.has(dataIdx)) border.top    = EXTRA_THICK;
          if (groupEnds.has(dataIdx))   border.bottom = EXTRA_THICK;
        }
      }

      cell.s = { ...cell.s, border };
    }
  }
}

// ── Worksheet + workbook + download ─────────────────────────────────────────
// One-shot helper for the common "AOA → workbook → trigger browser
// download" path every ATS export uses.
export interface DownloadInput {
  allRows: any[][];
  sheetName: string;
  filename: string;
  cols: Array<{ wch: number }>;
  rowHeights: Array<{ hpt: number }>;
  merges?: Array<{ s: { r: number; c: number }; e: { r: number; c: number } }>;
  /** A1-style range to enable autofilter on (e.g. "A1:O50"). */
  autofilter?: string;
  /** Frozen-pane split (row 1 → xSplit:0, ySplit:1). */
  freeze?: { xSplit: number; ySplit: number };
  /** Embedded images, AoA-relative (banner offset applied by the renderer). */
  images?: AoaImage[];
}

// Render one ATS-family sheet onto an ExcelJS workbook: stamps the Ring of
// Fire logo banner on top, then translates the styled AOA (preserving every
// dynamic column, fill, border, merge, formula and the autofilter/freeze) so
// the workbook reads exactly as before — just branded.
function renderSheet(wb: ExcelJS.Workbook, sheetName: string, spec: Omit<DownloadInput, "sheetName" | "filename">) {
  const safe = sheetName.replace(/[\\/*?:[\]]/g, "-").slice(0, 31);
  const colCount = spec.allRows.reduce((m, r) => Math.max(m, r?.length ?? 0), 0);
  renderStyledAoa(wb, safe, spec.allRows, {
    banner: { cols: colCount },               // logo only; AOA carries its own titles
    cols: spec.cols.map((c) => c.wch),
    rowHeights: spec.rowHeights.map((r) => r.hpt),
    merges: spec.merges,
    freeze: spec.freeze,
    autofilter: spec.autofilter,
    images: spec.images,
  });
}

export function downloadWorkbook({ sheetName, filename, ...sheetSpec }: DownloadInput): Promise<void> {
  const wb = newWorkbook();
  renderSheet(wb, sheetName, sheetSpec);
  return downloadExcelWorkbook(wb, filename);
}

// Multi-sheet variant — each entry produces one tab. Use the same
// sheet spec shape minus the top-level filename.
export interface MultiSheetSpec extends Omit<DownloadInput, "filename"> {}
export function downloadMultiSheet(filename: string, sheets: MultiSheetSpec[]): Promise<void> {
  const wb = newWorkbook();
  for (const sheet of sheets) {
    const { sheetName, ...spec } = sheet;
    renderSheet(wb, sheetName, spec);
  }
  return downloadExcelWorkbook(wb, filename);
}

// ── Build-only variants (no download) ──────────────────────────────────
// Same shape as downloadWorkbook / downloadMultiSheet but return the
// styled (logo'd) ExcelJS workbook + filename instead of triggering a
// download. Used by the preview-modal flow: build the workbook once, render
// the AOA in a preview, hand the same workbook to the modal so Download
// flushes the exact same bytes the legacy path produced.
export interface BuiltWorkbook {
  wb: ExcelJS.Workbook;
  filename: string;
}

export function buildWorkbook({ sheetName, filename, ...sheetSpec }: DownloadInput): BuiltWorkbook {
  const wb = newWorkbook();
  renderSheet(wb, sheetName, sheetSpec);
  return { wb, filename };
}

export function buildMultiSheetWorkbook(filename: string, sheets: MultiSheetSpec[]): BuiltWorkbook {
  const wb = newWorkbook();
  for (const sheet of sheets) {
    const { sheetName, ...spec } = sheet;
    renderSheet(wb, sheetName, spec);
  }
  return { wb, filename };
}

// Public trigger-download — same code path used by every exporter when it
// doesn't go through the preview modal. Exported so the preview modal (and
// any future caller) can flush a pre-built workbook to a file.
export function writeWorkbookToFile(wb: ExcelJS.Workbook, filename: string): Promise<void> {
  return downloadExcelWorkbook(wb, filename);
}
