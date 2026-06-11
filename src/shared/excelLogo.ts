// Canonical Excel export engine (ExcelJS) — the ONE place that knows how to
// produce a Ring of Fire branded, ATS-styled .xlsx with the logo embedded.
//
// xlsx-js-style cannot embed images, so every Excel download in the app is
// built here instead. Palette/format is kept in lockstep with the PDF export
// (src/shared/pdfExport.ts) and the original ATS look.

import ExcelJS from "exceljs";
import { ROF_LOGO_PNG_BASE64, ROF_LOGO_ASPECT } from "./assets/rofLogo";

// ── Canonical palette (hex, no #) ──────────────────────────────────────────
export const XLP = {
  FONT: "Calibri",
  HEADER_FILL: "1F497D",
  HEADER_TEXT: "FFFFFF",
  HEADER_BORDER: "4472C4",
  ROW_EVEN: "EEF3FA",
  ROW_ODD: "FFFFFF",
  ROW_BORDER: "D0D8E4",
  KEY_TEXT: "1F497D",
  BODY_TEXT: "1A202C",
  MUTED_TEXT: "5F5E5A",
  TOTAL_FILL: "1F497D",
  TOTAL_TEXT: "FFFFFF",
  NEG_TEXT: "C00000",
  LOW_TEXT: "7F6000",
  LOW_FILL: "FFEB9C",
  OUT_TEXT: "9C0006",
  OUT_FILL: "FFC7CE",
} as const;

export const NUMFMT = { QTY: "#,##0", USD: "$#,##0.00", PCT: "0.0%", DATE: "m/d/yyyy" } as const;

type Align = "left" | "center" | "right";

export const argb = (hex: string): string => "FF" + hex;
export const xfill = (hex: string): ExcelJS.Fill => ({ type: "pattern", pattern: "solid", fgColor: { argb: argb(hex) } });
export const xthin = (hex: string): Partial<ExcelJS.Border> => ({ style: "thin", color: { argb: argb(hex) } });
export const xmed = (hex: string): Partial<ExcelJS.Border> => ({ style: "medium", color: { argb: argb(hex) } });

export function newWorkbook(): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Ring of Fire";
  return wb;
}

// ── Logo banner ────────────────────────────────────────────────────────────
// Stamps the transparent ROF logo in the top-left of a worksheet, plus an
// optional blue title banner and subtitle. Returns the 1-based row index where
// the caller's content (header row) should begin.
export interface BannerOpts {
  title?: string;
  subtitle?: string;
  /** How many columns the title/subtitle banner should span. Default 8. */
  cols?: number;
  /** Logo width in px (height derived from aspect). Default 230. */
  logoWidth?: number;
}

export function addLogoBanner(wb: ExcelJS.Workbook, ws: ExcelJS.Worksheet, opts: BannerOpts = {}): number {
  const { title, subtitle, cols = 8, logoWidth = 230 } = opts;
  ws.getRow(1).height = 30;
  ws.getRow(2).height = 6;
  const imgId = wb.addImage({ base64: "data:image/png;base64," + ROF_LOGO_PNG_BASE64, extension: "png" });
  ws.addImage(imgId, { tl: { col: 0.15, row: 0.15 } as ExcelJS.Anchor, ext: { width: logoWidth, height: logoWidth / ROF_LOGO_ASPECT } });

  let r = 2; // rows 1-2 are the logo band
  if (title) {
    r += 1;
    ws.mergeCells(r, 1, r, cols);
    const c = ws.getCell(r, 1);
    c.value = title;
    c.font = { bold: true, size: 14, color: { argb: argb(XLP.HEADER_TEXT) }, name: XLP.FONT };
    c.fill = xfill(XLP.HEADER_FILL);
    c.alignment = { horizontal: "left", vertical: "middle" };
    ws.getRow(r).height = 22;
  }
  if (subtitle) {
    r += 1;
    ws.mergeCells(r, 1, r, cols);
    const c = ws.getCell(r, 1);
    c.value = subtitle;
    c.font = { italic: true, size: 10, color: { argb: argb(XLP.MUTED_TEXT) }, name: XLP.FONT };
    c.alignment = { horizontal: "left", vertical: "middle" };
  }
  return r + 1;
}

// ── Cell stylers ───────────────────────────────────────────────────────────
export function styleHeaderCell(cell: ExcelJS.Cell, align: Align = "center"): void {
  cell.font = { bold: true, size: 11, color: { argb: argb(XLP.HEADER_TEXT) }, name: XLP.FONT };
  cell.fill = xfill(XLP.HEADER_FILL);
  cell.alignment = { horizontal: align, vertical: "middle", wrapText: true };
  cell.border = { top: xthin(XLP.HEADER_BORDER), bottom: xmed(XLP.HEADER_BORDER), left: xthin(XLP.HEADER_BORDER), right: xthin(XLP.HEADER_BORDER) };
}

export type CellKind = "body" | "key" | "neg" | "low" | "out" | "total";

export function styleBodyCell(cell: ExcelJS.Cell, rowIndex: number, align: Align = "left", kind: CellKind = "body"): void {
  const even = rowIndex % 2 === 0;
  let fillHex: string = even ? XLP.ROW_EVEN : XLP.ROW_ODD;
  let font: Partial<ExcelJS.Font> = { size: 11, color: { argb: argb(XLP.BODY_TEXT) }, name: XLP.FONT };
  if (kind === "key") font = { bold: true, size: 11, color: { argb: argb(XLP.KEY_TEXT) }, name: XLP.FONT };
  else if (kind === "neg") font = { bold: true, size: 11, color: { argb: argb(XLP.NEG_TEXT) }, name: XLP.FONT };
  else if (kind === "low") { font = { bold: true, size: 11, color: { argb: argb(XLP.LOW_TEXT) }, name: XLP.FONT }; fillHex = XLP.LOW_FILL; }
  else if (kind === "out") { font = { bold: true, size: 11, color: { argb: argb(XLP.OUT_TEXT) }, name: XLP.FONT }; fillHex = XLP.OUT_FILL; }
  else if (kind === "total") { font = { bold: true, size: 11, color: { argb: argb(XLP.TOTAL_TEXT) }, name: XLP.FONT }; fillHex = XLP.TOTAL_FILL; }
  cell.font = font;
  cell.fill = xfill(fillHex);
  cell.alignment = { horizontal: align, vertical: "middle" };
  if (kind === "total") cell.border = { top: xmed(XLP.HEADER_BORDER), bottom: xthin(XLP.HEADER_BORDER), left: xthin(XLP.ROW_BORDER), right: xthin(XLP.ROW_BORDER) };
  else cell.border = { left: xthin(XLP.ROW_BORDER), right: xthin(XLP.ROW_BORDER) };
}

// ── High-level: object grid → styled, logo'd worksheet ─────────────────────
export interface GridSheetOpts {
  title?: string;
  subtitle?: string;
  /** Pretty header labels keyed by field; falls back to a title-cased key. */
  headers?: Record<string, string>;
  currencyKeys?: string[];
  qtyKeys?: string[];
  /** Bold-blue first column. Default true. */
  keyFirstColumn?: boolean;
  /** Show the logo banner. Default true (set false for secondary sheets like Meta). */
  logo?: boolean;
  minWidth?: number;
  maxWidth?: number;
}

export function addObjectGridSheet(
  wb: ExcelJS.Workbook,
  sheetName: string,
  rows: Record<string, unknown>[],
  opts: GridSheetOpts = {},
): ExcelJS.Worksheet {
  const ws = wb.addWorksheet(sheetName);
  const { keyFirstColumn = true, logo = true, minWidth = 12, maxWidth = 44 } = opts;
  const fields = rows.length ? Object.keys(rows[0]) : ["info"];
  const currency = new Set(opts.currencyKeys ?? []);
  const qty = new Set(opts.qtyKeys ?? []);
  const labels = fields.map((f) => opts.headers?.[f] ?? prettyLabel(f));

  const startRow = logo ? addLogoBanner(wb, ws, { title: opts.title, subtitle: opts.subtitle, cols: fields.length }) : 1;

  // Header row.
  const hdrRow = ws.getRow(startRow);
  fields.forEach((_f, i) => {
    const c = hdrRow.getCell(i + 1);
    c.value = labels[i];
    styleHeaderCell(c, i === 0 ? "left" : "center");
  });
  hdrRow.height = 20;

  // Data rows.
  if (rows.length === 0) {
    const c = ws.getRow(startRow + 1).getCell(1);
    c.value = "(no rows)";
    styleBodyCell(c, 0, "left");
  } else {
    rows.forEach((r, ri) => {
      const row = ws.getRow(startRow + 1 + ri);
      row.height = 15;
      fields.forEach((f, ci) => {
        const v = r[f];
        const c = row.getCell(ci + 1);
        c.value = v as ExcelJS.CellValue;
        const isNum = typeof v === "number";
        const align: Align = isNum ? "right" : "left";
        const kind: CellKind = ci === 0 && keyFirstColumn ? "key" : isNum && v < 0 ? "neg" : "body";
        styleBodyCell(c, ri, align, kind);
        if (isNum) c.numFmt = currency.has(f) ? NUMFMT.USD : qty.has(f) ? NUMFMT.QTY : NUMFMT.QTY;
      });
    });
  }

  // Column widths from header + content.
  fields.forEach((f, ci) => {
    const headerLen = labels[ci].length;
    const contentLen = rows.reduce((m, r) => Math.max(m, r[f] == null ? 0 : String(r[f]).length), 0);
    ws.getColumn(ci + 1).width = Math.min(maxWidth, Math.max(minWidth, Math.max(headerLen, contentLen) + 2));
  });

  ws.views = [{ state: "frozen", xSplit: 0, ySplit: startRow }];
  return ws;
}

// ── Plain value-AOA → styled, logo'd worksheet ─────────────────────────────
// For exporters that build a raw [header, ...rows] (or [meta..., header, ...rows])
// array of plain values. Applies the logo banner, a blue header band, zebra
// body and number formats. `metaRows` styles N leading rows as a light info
// block above the header (e.g. RFQ summary lines).
export interface AoaSheetOpts {
  title?: string;
  subtitle?: string;
  /** Number of leading info rows before the header row. Default 0. */
  metaRows?: number;
  /** Explicit column widths (wch). Falls back to autofit. */
  cols?: number[];
  freeze?: { xSplit: number; ySplit: number };
  maxWidth?: number;
}

export function addAoaSheet(
  wb: ExcelJS.Workbook,
  sheetName: string,
  aoa: any[][],
  opts: AoaSheetOpts = {},
): ExcelJS.Worksheet {
  const ws = wb.addWorksheet(sheetName.replace(/[\\/*?:[\]]/g, "-").slice(0, 31));
  const colCount = aoa.reduce((m, r) => Math.max(m, r?.length ?? 0), 0);
  const start = addLogoBanner(wb, ws, { title: opts.title, subtitle: opts.subtitle, cols: Math.max(colCount, 1) });
  const metaRows = opts.metaRows ?? 0;
  const maxWidth = opts.maxWidth ?? 60;

  aoa.forEach((row, r) => {
    const excelRow = ws.getRow(start + r);
    const isMeta = r < metaRows;
    const isHeader = r === metaRows;
    if (isHeader) excelRow.height = 20;
    (row ?? []).forEach((v, c) => {
      const cell = excelRow.getCell(c + 1);
      if (v !== "" && v != null) cell.value = v as ExcelJS.CellValue;
      if (isMeta) {
        cell.font = { name: XLP.FONT, size: 11, bold: c === 0, color: { argb: argb(c === 0 ? XLP.KEY_TEXT : XLP.BODY_TEXT) } };
      } else if (isHeader) {
        styleHeaderCell(cell, c === 0 ? "left" : "center");
      } else {
        const isNum = typeof v === "number";
        const kind: CellKind = c === 0 ? "key" : isNum && v < 0 ? "neg" : "body";
        styleBodyCell(cell, r - metaRows - 1, isNum ? "right" : "left", kind);
        if (isNum) cell.numFmt = NUMFMT.QTY;
      }
    });
  });

  if (opts.cols && opts.cols.length) {
    opts.cols.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  } else {
    for (let c = 0; c < colCount; c++) {
      const len = aoa.reduce((m, r) => Math.max(m, r?.[c] == null ? 0 : String(r[c]).length), 0);
      ws.getColumn(c + 1).width = Math.min(maxWidth, Math.max(10, len + 2));
    }
  }
  ws.views = [{ state: "frozen", xSplit: opts.freeze?.xSplit ?? 0, ySplit: opts.freeze?.ySplit ?? (start + metaRows) }];
  return ws;
}

// ── Metadata sheet (key/value), optionally with logo ───────────────────────
export function addMetaSheet(
  wb: ExcelJS.Workbook,
  sheetName: string,
  pairs: Array<[string, unknown]>,
  opts: { logo?: boolean; title?: string } = {},
): ExcelJS.Worksheet {
  const ws = wb.addWorksheet(sheetName);
  const startRow = opts.logo ? addLogoBanner(wb, ws, { title: opts.title, cols: 2 }) : 1;
  pairs.forEach(([k, v], i) => {
    const row = ws.getRow(startRow + i);
    const kc = row.getCell(1);
    kc.value = k;
    kc.font = { bold: true, name: XLP.FONT, size: 11, color: { argb: argb(XLP.KEY_TEXT) } };
    const vc = row.getCell(2);
    vc.value = v as ExcelJS.CellValue;
    vc.font = { name: XLP.FONT, size: 11, color: { argb: argb(XLP.BODY_TEXT) } };
  });
  ws.getColumn(1).width = 20;
  ws.getColumn(2).width = 52;
  return ws;
}

// ── xlsx-js-style AoA → ExcelJS renderer ───────────────────────────────────
// Translates an array-of-arrays of xlsx-js-style cells ({ v, t, s, z }) onto an
// ExcelJS worksheet, optionally stamping the logo banner on top. Lets the
// intricate bespoke exporters keep their AoA-building logic unchanged while
// gaining the embedded logo. All merge/freeze coordinates are 0-based (xlsx
// convention) and auto-shifted by the banner offset.
export interface AoaCell { v: any; t?: string; s?: any; z?: string; f?: string }
export interface AoaMerge { s: { r: number; c: number }; e: { r: number; c: number } }
export interface RenderAoaOpts {
  banner?: BannerOpts | null;
  merges?: AoaMerge[];
  /** Column widths in "wch" units (characters). */
  cols?: number[];
  /** Row heights in points, 0-based aligned to the AoA rows. */
  rowHeights?: Array<number | null | undefined>;
  freeze?: { xSplit: number; ySplit: number };
  /** A1-style range to enable autofilter on (e.g. "A1:O50"), pre-banner coords. */
  autofilter?: string;
  /** Thin-border rectangles (0-based, inclusive) applied after cells. */
  gridBorders?: Array<{ r0: number; r1: number; c0: number; c1: number; color?: string }>;
  /** Embedded images anchored to cells (0-based, pre-banner coords). The
   *  banner offset is applied internally. A bad/empty image is skipped, never
   *  fatal. dataUrl may be a full `data:image/...;base64,...` URL or raw base64. */
  images?: AoaImage[];
}

export interface AoaImage {
  /** 0-based AoA row the image anchors to (pre-banner). */
  aoaRow: number;
  /** 0-based column index. */
  col: number;
  /** `data:image/png;base64,...` (or jpeg/gif), or raw base64. */
  dataUrl: string;
  /** Embedded thumbnail size in pixels. */
  width: number;
  height: number;
}

// Split a data URL (or raw base64) into ExcelJS's { base64, extension }.
function parseImageDataUrl(d: string): { base64: string; extension: "png" | "jpeg" | "gif" } {
  const m = /^data:image\/(png|jpe?g|gif);base64,(.*)$/i.exec(d);
  if (m) {
    const ext = m[1].toLowerCase();
    return { base64: m[2], extension: ext === "jpg" ? "jpeg" : (ext as "png" | "jpeg" | "gif") };
  }
  return { base64: d.replace(/^data:[^,]*,/, ""), extension: "png" };
}

// Read intrinsic pixel dimensions from a base64 PNG/JPEG/GIF header so an
// embedded image can be scaled to FIT its cell (preserving aspect) instead of
// being forced into a square box — which would let a tall portrait image spill
// past its row. Returns null if it can't be read (caller falls back to the box).
function imageDims(base64: string): { w: number; h: number } | null {
  try {
    const bin = typeof atob === "function" ? atob(base64) : Buffer.from(base64, "base64").toString("binary");
    const n = bin.length;
    const b = (i: number) => bin.charCodeAt(i) & 0xff;
    // PNG: IHDR width/height at bytes 16–23.
    if (b(0) === 0x89 && b(1) === 0x50) {
      const w = (b(16) << 24) | (b(17) << 16) | (b(18) << 8) | b(19);
      const h = (b(20) << 24) | (b(21) << 16) | (b(22) << 8) | b(23);
      if (w > 0 && h > 0) return { w, h };
    }
    // GIF: little-endian width/height at bytes 6–9.
    if (b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46) {
      const w = b(6) | (b(7) << 8); const h = b(8) | (b(9) << 8);
      if (w > 0 && h > 0) return { w, h };
    }
    // JPEG: walk segments to a Start-Of-Frame marker, read height then width.
    if (b(0) === 0xff && b(1) === 0xd8) {
      let i = 2;
      while (i < n - 9) {
        if (b(i) !== 0xff) { i++; continue; }
        const marker = b(i + 1);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          const h = (b(i + 5) << 8) | b(i + 6);
          const w = (b(i + 7) << 8) | b(i + 8);
          if (w > 0 && h > 0) return { w, h };
          break;
        }
        i += 2 + ((b(i + 2) << 8) | b(i + 3)); // skip this segment
      }
    }
  } catch { /* unreadable header — fall back */ }
  return null;
}

// Bump the ROW number of every (relative) A1 cell reference by `offset` so
// formulas/ranges stay correct after a logo banner pushes the grid down.
// Absolute rows ($-prefixed) are left untouched.
export function shiftA1Rows(a1: string, offset: number): string {
  if (!offset) return a1;
  return a1.replace(/(\$?[A-Z]{1,3})(\$?)(\d+)/g, (whole, col, rowAbs, row) =>
    rowAbs === "$" ? whole : `${col}${Number(row) + offset}`);
}

function applyAoaStyle(cell: ExcelJS.Cell, s: any, z?: string): void {
  if (s?.font) {
    cell.font = {
      bold: s.font.bold, italic: s.font.italic,
      size: s.font.sz, name: s.font.name,
      color: s.font.color?.rgb ? { argb: argb(s.font.color.rgb) } : undefined,
    };
  }
  if (s?.fill?.fgColor?.rgb) cell.fill = xfill(s.fill.fgColor.rgb);
  if (s?.alignment) {
    cell.alignment = {
      horizontal: s.alignment.horizontal,
      vertical: s.alignment.vertical === "center" ? "middle" : s.alignment.vertical,
      wrapText: s.alignment.wrapText,
    };
  }
  if (s?.border) {
    const b: Partial<ExcelJS.Borders> = {};
    // A border with no explicit color renders BLACK in Excel. Fall back to the
    // cell's own fill (the prevailing color of the box) so a stray colorless
    // border blends in instead of showing a black frame; final fallback is the
    // light grid color.
    const fallback = s.fill?.fgColor?.rgb ?? XLP.ROW_BORDER;
    (["top", "bottom", "left", "right"] as const).forEach((side) => {
      const bd = s.border[side];
      if (bd) b[side] = { style: bd.style, color: { argb: argb(bd.color?.rgb ?? fallback) } };
    });
    cell.border = b;
  }
  const nf = s?.numFmt || z;
  if (nf) cell.numFmt = nf;
}

export function renderStyledAoa(
  wb: ExcelJS.Workbook,
  sheetName: string,
  aoa: AoaCell[][],
  opts: RenderAoaOpts = {},
): ExcelJS.Worksheet {
  const ws = wb.addWorksheet(sheetName);
  // `offset` = number of banner rows inserted above the AoA.
  const offset = opts.banner ? addLogoBanner(wb, ws, opts.banner) - 1 : 0;

  for (let r = 0; r < aoa.length; r++) {
    const rowArr = aoa[r];
    if (!rowArr) continue;
    for (let c = 0; c < rowArr.length; c++) {
      const src = rowArr[c];
      if (!src) continue;
      const cell = ws.getCell(offset + r + 1, c + 1);
      if (typeof src.f === "string" && src.f) {
        cell.value = { formula: shiftA1Rows(src.f, offset), result: typeof src.v === "number" ? src.v : undefined } as ExcelJS.CellValue;
      } else if (src.v !== undefined && src.v !== null && src.v !== "") {
        cell.value = src.v;
      }
      applyAoaStyle(cell, src.s, src.z);
    }
  }

  (opts.gridBorders ?? []).forEach(({ r0, r1, c0, c1, color = XLP.ROW_BORDER }) => {
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cell = ws.getCell(offset + r + 1, c + 1);
        cell.border = { top: xthin(color), bottom: xthin(color), left: xthin(color), right: xthin(color) };
      }
    }
  });

  // ExcelJS throws on overlapping/duplicate merges (xlsx-js-style silently
  // ignored them). Skip any that conflict so a stray overlap never crashes
  // the whole export — the worst case is one un-merged band.
  (opts.merges ?? []).forEach((m) => {
    try { ws.mergeCells(offset + m.s.r + 1, m.s.c + 1, offset + m.e.r + 1, m.e.c + 1); }
    catch { /* overlapping merge — leave cells un-merged */ }
  });

  (opts.cols ?? []).forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  (opts.rowHeights ?? []).forEach((h, i) => { if (h != null) ws.getRow(offset + i + 1).height = h; });

  // Embedded images, anchored to (aoaRow + banner offset, col) with a small
  // inset so the thumbnail sits inside the cell. `oneCell` keeps it pinned to
  // the cell on row/col insert. A bad image is skipped — never crash an export.
  const imgIdByData = new Map<string, number>(); // dedup bytes when rows share an image
  (opts.images ?? []).forEach((im) => {
    if (!im?.dataUrl) return;
    try {
      const { base64, extension } = parseImageDataUrl(im.dataUrl);
      if (!base64) return;
      let id = imgIdByData.get(im.dataUrl);
      if (id === undefined) { id = wb.addImage({ base64, extension }); imgIdByData.set(im.dataUrl, id); }
      // Fill the cell's COLUMN WIDTH (so portrait shots don't leave side gaps),
      // keeping aspect ratio, then size the ROW to exactly the resulting height
      // so the cell fits the picture with no empty space. Aspect comes from the
      // caller-supplied pixel dims (im.width/im.height) — measured precisely in
      // the browser — falling back to an in-house byte decoder only when those
      // aren't available (e.g. server-side). Excel col px ≈ wch*7+5; row pt ≈
      // px*72/96.
      const colPx = ((opts.cols?.[im.col] ?? 10) * 7) + 5;
      let iw = im.width, ih = im.height;
      if (!(iw > 0 && ih > 0)) {
        const dims = imageDims(base64);
        if (dims && dims.w > 0 && dims.h > 0) { iw = dims.w; ih = dims.h; }
      }
      const w = colPx - 4;
      const h = (iw > 0 && ih > 0) ? Math.round(w * ih / iw) : w; // square if still unknown
      // Row height = image height exactly (min 22pt for readability). Overrides
      // the caller's row height for image rows only.
      ws.getRow(offset + im.aoaRow + 1).height = Math.max(Math.round((h * 72) / 96), 22);
      const hOff = 2 / colPx; // tiny inset so the image doesn't touch the column edges
      ws.addImage(id, {
        tl: { col: im.col + hOff, row: offset + im.aoaRow } as ExcelJS.Anchor,
        ext: { width: w, height: h },
        editAs: "oneCell",
      });
    } catch { /* malformed image data — skip */ }
  });

  if (opts.freeze) ws.views = [{ state: "frozen", xSplit: opts.freeze.xSplit, ySplit: offset + opts.freeze.ySplit }];
  if (opts.autofilter) ws.autoFilter = shiftA1Rows(opts.autofilter, offset);
  return ws;
}

// ── Download ───────────────────────────────────────────────────────────────
export async function downloadExcelWorkbook(wb: ExcelJS.Workbook, fileName: string): Promise<void> {
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

export function prettyLabel(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase())
    .replace(/\bId\b/g, "ID")
    .replace(/\bSku\b/g, "SKU")
    .replace(/\bPo\b/g, "PO");
}

export { ExcelJS };
