// ── Packing list parser ────────────────────────────────────────────────────────
// Supports two layouts:
//
// 1. Macy's / buyer-provided columnar format:
//      Row N:   [channel names across the top: HAF, MDC, MDS …]
//      Row N+1: [STYLE #, COLORS, UNITS, OWN $, UNITS, PPK, A, UNITS, PPK, A …]
//      Data:    each row = one scale code; scale code appears in the "PPK" cell,
//               pack qty in the next cell.
//
// 2. Block-style layout (one style per block, scale codes in a header row):
//      Row A:   style number (e.g. "100227091BK")
//      Row B:   CA  CB  CD  …
//      Row C+:  channel rows with qty per scale column

import * as XLSX from "xlsx";
import { KNOWN_SCALE_CODES, STYLE_NO_RE } from "../types";
import type { ParsedRow, ParsedSheet, ParseIssueInput, PackingListParseResult } from "../types";

type Grid = string[][];

// ── Grid helpers ──────────────────────────────────────────────────────────────

function sheetToGrid(ws: XLSX.WorkSheet): Grid {
  const ref = ws["!ref"];
  if (!ref) return [];
  const range = XLSX.utils.decode_range(ref);
  const grid: Grid = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row: string[] = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      row.push(cell ? String(cell.v ?? "").trim() : "");
    }
    grid.push(row);
  }
  return grid;
}

function cellUpper(v: string): string {
  return v.toUpperCase().trim();
}

// ── Detection helpers ─────────────────────────────────────────────────────────

function isStyleNo(v: string): boolean {
  return STYLE_NO_RE.test(v.trim().toUpperCase());
}

function isScaleCode(v: string): boolean {
  return KNOWN_SCALE_CODES.has(v.trim().toUpperCase());
}

const COLOR_BLACKLIST = new Set([
  "STYLE", "COLOR", "COLOUR", "SIZE", "SCALE", "CHANNEL",
  "QTY", "QUANTITY", "TOTAL", "UNITS", "PACK", "DESCRIPTION",
  "ITEM", "NO", "NUMBER", "UPC", "GTIN", "STORE", "PO",
  "CUSTOMER", "VENDOR", "DATE", "SEASON", "BRAND",
]);

function looksLikeColor(v: string): boolean {
  const up = v.trim().toUpperCase();
  if (!up) return false;
  if (!/^[A-Z][A-Z\s\-\/]+$/.test(up)) return false;
  if (up.length < 3) return false;
  const words = up.split(/\s+/).filter(Boolean);
  if (words.some(w => COLOR_BLACKLIST.has(w))) return false;
  if (words.length === 1 && isScaleCode(up)) return false;
  return true;
}

const CHANNEL_RE = /^[A-Z]{2,8}(\s*\/\s*[A-Z]{2,8})?$/;
function looksLikeChannel(v: string): boolean {
  return CHANNEL_RE.test(v.trim().toUpperCase()) && !isScaleCode(v);
}

// ── Strategy 1: Macy's / buyer columnar format ────────────────────────────────
//
// Detects a row where col 0 = "STYLE #" and col 1 starts with "COLOR".
// Channel names appear in the row immediately above that header row.
// For each channel the layout is [UNITS | PPK(=scale code in data) | blank | A] repeat.

const SKIP_CHANNELS = new Set(["TOTAL", "GRAND TOTAL", "SIZE SCALES", "TTL", ""]);

function parseMacysColumnar(sheetName: string, grid: Grid): ParsedSheet {
  const rows: ParsedRow[] = [];
  const issues: ParseIssueInput[] = [];

  // Find the column header row
  let headerRowIdx = -1;
  for (let r = 0; r < Math.min(25, grid.length); r++) {
    const c0 = cellUpper(grid[r][0] ?? "");
    const c1 = cellUpper(grid[r][1] ?? "");
    if (c0 === "STYLE #" && c1.startsWith("COLOR")) {
      headerRowIdx = r;
      break;
    }
  }
  if (headerRowIdx < 0) return { sheetName, rows, issues };

  const headerRow   = grid[headerRowIdx];
  const channelRow  = headerRowIdx > 0 ? grid[headerRowIdx - 1] : [];

  // Map each channel to its scale-code column and qty column.
  // In the header row, channels own a group [UNITS, PPK, ?, A].
  // In data rows the "PPK" cell holds the scale code and the cell after it holds pack qty.
  interface ChannelGroup { channel: string; scaleCodeCol: number; qtyCol: number; }
  const channelGroups: ChannelGroup[] = [];

  for (let c = 4; c < headerRow.length - 2; c++) {
    if (cellUpper(headerRow[c]) !== "UNITS") continue;
    const channelName = cellUpper(channelRow[c] ?? "");
    if (SKIP_CHANNELS.has(channelName)) continue;
    if (!channelName) continue;
    // PPK column is c+1 (holds scale code in data rows), qty is c+2
    channelGroups.push({ channel: channelName, scaleCodeCol: c + 1, qtyCol: c + 2 });
  }

  if (channelGroups.length === 0) return { sheetName, rows, issues };

  // Scan data rows — only in the style/color columns (0 & 1); ignore all other
  // occurrences of style-like numbers (they are financial totals in other columns).
  let currentStyle = "";
  let currentColor = "";

  for (let r = headerRowIdx + 1; r < grid.length; r++) {
    const rowCells = grid[r];
    if (!rowCells || rowCells.every(v => !v.trim())) continue;

    // Style and color only from their designated columns
    const styleCell = (rowCells[0] ?? "").trim().toUpperCase();
    const colorCell = (rowCells[1] ?? "").trim().toUpperCase();
    if (styleCell && isStyleNo(styleCell)) currentStyle = styleCell;
    if (colorCell && looksLikeColor(colorCell)) currentColor = colorCell;

    if (!currentStyle) continue;

    // Stop if we reach a totals / summary section
    const rowLabel = cellUpper(rowCells[1] ?? "");
    if (rowLabel.includes("TOTAL") || rowLabel.includes("FC $") || rowLabel.includes("LLC $")) break;

    for (const { channel, scaleCodeCol, qtyCol } of channelGroups) {
      const scaleCode = cellUpper(rowCells[scaleCodeCol] ?? "");
      if (!isScaleCode(scaleCode)) continue;
      const rawQty = (rowCells[qtyCol] ?? "").trim();
      if (!rawQty) continue;
      const qty = parseInt(rawQty.replace(/[^0-9]/g, ""), 10);
      if (isNaN(qty) || qty <= 0) continue;

      rows.push({
        styleNo:   currentStyle,
        color:     currentColor || "UNKNOWN",
        channel,
        scaleCode,
        packQty:   qty,
        sheetName,
        rowIndex:  r,
        confidence: currentColor ? 100 : 70,
      });
    }
  }

  return { sheetName, rows, issues };
}

// ── Strategy 2: Block-style layout ───────────────────────────────────────────
//
// Each style block: style-anchor row → color nearby → scale-header row → data rows

interface ScaleHeaderRow {
  rowIdx: number;
  scaleCols: Array<{ colIdx: number; code: string }>;
}

function findScaleHeaderRow(grid: Grid, startRow: number, endRow: number): ScaleHeaderRow | null {
  for (let r = startRow; r < Math.min(endRow, grid.length); r++) {
    const scaleCols: Array<{ colIdx: number; code: string }> = [];
    for (let c = 0; c < grid[r].length; c++) {
      const v = cellUpper(grid[r][c]);
      if (isScaleCode(v)) scaleCols.push({ colIdx: c, code: v });
    }
    if (scaleCols.length >= 2) return { rowIdx: r, scaleCols };
  }
  return null;
}

interface StyleAnchor { rowIdx: number; colIdx: number; styleNo: string; }

function findStyleAnchors(grid: Grid): StyleAnchor[] {
  const anchors: StyleAnchor[] = [];
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      const v = grid[r][c].trim().toUpperCase();
      if (isStyleNo(v)) anchors.push({ rowIdx: r, colIdx: c, styleNo: v });
    }
  }
  // Deduplicate: same style within 3 rows in the same column → keep first
  const seen = new Map<string, number>();
  return anchors.filter(a => {
    const key = `${a.colIdx}:${a.styleNo}`;
    const lastRow = seen.get(key);
    if (lastRow !== undefined && a.rowIdx - lastRow <= 3) return false;
    seen.set(key, a.rowIdx);
    return true;
  });
}

function findColorNear(grid: Grid, anchorRow: number): string | null {
  const s = Math.max(0, anchorRow - 5);
  const e = Math.min(grid.length - 1, anchorRow + 5);
  for (let r = s; r <= e; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      const v = grid[r][c].trim();
      if (looksLikeColor(v)) return v.toUpperCase();
    }
  }
  return null;
}

function parseBlockStyle(sheetName: string, grid: Grid): ParsedSheet {
  const rows: ParsedRow[] = [];
  const issues: ParseIssueInput[] = [];

  if (grid.length === 0) {
    issues.push({ sheet_name: sheetName, issue_type: "empty_sheet", severity: "info", message: "Sheet is empty." });
    return { sheetName, rows, issues };
  }

  const styleAnchors = findStyleAnchors(grid);
  if (styleAnchors.length === 0) {
    issues.push({ sheet_name: sheetName, issue_type: "no_style_found", severity: "warning",
      message: `No style numbers detected on sheet "${sheetName}".` });
    return { sheetName, rows, issues };
  }

  for (let ai = 0; ai < styleAnchors.length; ai++) {
    const anchor       = styleAnchors[ai];
    const nextAnchorRow = styleAnchors[ai + 1]?.rowIdx ?? grid.length;
    let color = findColorNear(grid, anchor.rowIdx);

    // Look for scale header up to 10 rows above the anchor too (handles global headers)
    const searchFrom = Math.max(0, anchor.rowIdx - 10);
    const scaleHeader = findScaleHeaderRow(grid, searchFrom, nextAnchorRow);
    if (!scaleHeader || scaleHeader.rowIdx >= nextAnchorRow) {
      issues.push({ sheet_name: sheetName, issue_type: "no_scale_header", severity: "warning",
        message: `Style ${anchor.styleNo}: no scale header row found nearby.`,
        raw_context: { rowIdx: anchor.rowIdx } });
      continue;
    }

    const { rowIdx: scaleRowIdx, scaleCols } = scaleHeader;
    const dataStart = scaleRowIdx + 1;
    const dataEnd   = Math.min(nextAnchorRow, scaleRowIdx + 60);

    for (let r = dataStart; r < dataEnd; r++) {
      const rowCells = grid[r];
      if (!rowCells || rowCells.every(v => !v.trim())) continue;

      let channel: string | null = null;
      for (let c = 0; c <= Math.min(7, rowCells.length - 1); c++) {
        const v = cellUpper(rowCells[c]);
        if (v && looksLikeChannel(v)) { channel = v; break; }
      }
      for (let c = 0; c < rowCells.length; c++) {
        const v = rowCells[c].trim();
        if (looksLikeColor(v)) color = v.toUpperCase();
      }

      for (const { colIdx, code } of scaleCols) {
        if (colIdx >= rowCells.length) continue;
        const rawQty = rowCells[colIdx].trim();
        if (!rawQty) continue;
        const qty = parseInt(rawQty.replace(/[^0-9]/g, ""), 10);
        if (isNaN(qty) || qty <= 0) continue;

        let confidence = 100;
        if (!color)   confidence -= 30;
        if (!channel) confidence -= 20;

        rows.push({ styleNo: anchor.styleNo, color: color ?? "UNKNOWN",
          channel: channel ?? "UNKNOWN", scaleCode: code, packQty: qty,
          sheetName, rowIndex: r, confidence });
      }
    }

    if (rows.filter(r => r.styleNo === anchor.styleNo).length === 0) {
      issues.push({ sheet_name: sheetName, issue_type: "no_qty_rows", severity: "warning",
        message: `Style ${anchor.styleNo}: scale header found but no quantity rows extracted.`,
        raw_context: { anchor, scaleHeader } });
    }
  }

  return { sheetName, rows, issues };
}

// ── Sheet dispatcher ──────────────────────────────────────────────────────────

function parseSheet(sheetName: string, ws: XLSX.WorkSheet): ParsedSheet {
  const grid = sheetToGrid(ws);

  // Try Macy's columnar format first
  const columnar = parseMacysColumnar(sheetName, grid);
  if (columnar.rows.length > 0) return columnar;

  // Fall back to block-style
  return parseBlockStyle(sheetName, grid);
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function parsePackingListFile(file: File): Promise<PackingListParseResult> {
  const buf = await file.arrayBuffer();
  const wb  = XLSX.read(buf, { type: "array", cellDates: false });

  const sheets: ParsedSheet[] = [];
  const allRows: ParsedRow[]  = [];
  const globalIssues: ParseIssueInput[] = [];

  for (const sheetName of wb.SheetNames) {
    try {
      const parsed = parseSheet(sheetName, wb.Sheets[sheetName]);
      sheets.push(parsed);
      allRows.push(...parsed.rows);
    } catch (err) {
      globalIssues.push({ sheet_name: sheetName, issue_type: "parse_exception", severity: "error",
        message: `Sheet "${sheetName}" threw an error: ${(err as Error).message}` });
    }
  }

  // Deduplicate rows across sheets: same style+color+channel+scale → keep first
  const seen = new Set<string>();
  const dedupedRows = allRows.filter(r => {
    const key = `${r.styleNo}|${r.color}|${r.channel}|${r.scaleCode}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const issues: ParseIssueInput[] = [
    ...globalIssues,
    ...sheets.flatMap(s => s.issues),
  ];

  if (dedupedRows.length === 0 && sheets.length > 0) {
    issues.push({ sheet_name: null, issue_type: "no_rows_parsed", severity: "error",
      message: "No quantity rows could be extracted. Please check the file format." });
  }

  return { sheets, allRows: dedupedRows, issues };
}
