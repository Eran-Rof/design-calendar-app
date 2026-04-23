// ── Packing list parser ────────────────────────────────────────────────────────
// Handles .xls and .xlsx workbooks with block-style apparel packing list layouts.
//
// Strategy:
//  1. Load workbook with xlsx library (same lib used by ATS module).
//  2. Convert each sheet to a 2D string grid.
//  3. Scan for style marker rows (e.g. "100227091BK").
//  4. Scan for color context blocks (e.g. "DRESS BLUES").
//  5. Scan for scale code header rows (e.g. CA CB CD ...).
//  6. Extract channel/scale/qty intersections.
//  7. Carry forward style and color context when not repeated per row.
//  8. Attach confidence score to each parsed row.
//  9. Emit ParseIssueInput records for anything ambiguous.

import * as XLSX from "xlsx";
import { KNOWN_SCALE_CODES, STYLE_NO_RE } from "../types";
import type { ParsedRow, ParsedSheet, ParseIssueInput, PackingListParseResult } from "../types";

// ── Grid helpers ──────────────────────────────────────────────────────────────

type Grid = string[][];

function sheetToGrid(ws: XLSX.WorkSheet): Grid {
  const ref = ws["!ref"];
  if (!ref) return [];
  const range = XLSX.utils.decode_range(ref);
  const grid: Grid = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row: string[] = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cellAddr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[cellAddr];
      row.push(cell ? String(cell.v ?? "").trim() : "");
    }
    grid.push(row);
  }
  return grid;
}

function rowText(row: string[]): string {
  return row.join(" ").toUpperCase();
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

// A color marker is an ALL-CAPS phrase (1+ words) that is not a scale code and
// not a style number. We look for it in cells adjacent to a style marker or
// in a contextual block above quantity rows.
const COLOR_BLACKLIST = new Set([
  "STYLE", "COLOR", "COLOUR", "SIZE", "SCALE", "CHANNEL",
  "QTY", "QUANTITY", "TOTAL", "UNITS", "PACK", "DESCRIPTION",
  "ITEM", "NO", "NUMBER", "UPC", "GTIN", "STORE", "PO",
  "CUSTOMER", "VENDOR", "DATE", "SEASON", "BRAND",
]);

function looksLikeColor(v: string): boolean {
  const up = v.trim().toUpperCase();
  if (!up) return false;
  if (!/^[A-Z][A-Z\s\-\/]+$/.test(up)) return false; // must be letters/spaces/dashes
  if (up.length < 3) return false;
  const words = up.split(/\s+/).filter(Boolean);
  // Reject if any word is a known blacklisted header word
  if (words.some(w => COLOR_BLACKLIST.has(w))) return false;
  // Reject if it's a single scale code
  if (words.length === 1 && isScaleCode(up)) return false;
  return true;
}

// Channel names are typically 2-5 all-caps letters (MDS, ROF, TJX, etc.)
const CHANNEL_RE = /^[A-Z]{2,8}(\s*\/\s*[A-Z]{2,8})?$/;
function looksLikeChannel(v: string): boolean {
  return CHANNEL_RE.test(v.trim().toUpperCase()) && !isScaleCode(v);
}

// ── Scale code row detection ───────────────────────────────────────────────────

interface ScaleHeaderRow {
  rowIdx: number;
  scaleCols: Array<{ colIdx: number; code: string }>;
}

function findScaleHeaderRow(grid: Grid, startRow = 0): ScaleHeaderRow | null {
  for (let r = startRow; r < grid.length; r++) {
    const scaleCols: Array<{ colIdx: number; code: string }> = [];
    for (let c = 0; c < grid[r].length; c++) {
      const v = cellUpper(grid[r][c]);
      if (isScaleCode(v)) {
        scaleCols.push({ colIdx: c, code: v });
      }
    }
    if (scaleCols.length >= 2) {
      return { rowIdx: r, scaleCols };
    }
  }
  return null;
}

// ── Style marker scan ─────────────────────────────────────────────────────────

interface StyleAnchor {
  rowIdx: number;
  colIdx: number;
  styleNo: string;
}

function findStyleAnchors(grid: Grid): StyleAnchor[] {
  const anchors: StyleAnchor[] = [];
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      const v = grid[r][c].trim().toUpperCase();
      if (isStyleNo(v)) {
        anchors.push({ rowIdx: r, colIdx: c, styleNo: v });
      }
    }
  }
  return anchors;
}

// ── Color context scan ────────────────────────────────────────────────────────
// Look in rows [anchorRow-5 .. anchorRow+5] for a color candidate

function findColorNear(grid: Grid, anchorRow: number): string | null {
  const searchStart = Math.max(0, anchorRow - 5);
  const searchEnd   = Math.min(grid.length - 1, anchorRow + 5);
  for (let r = searchStart; r <= searchEnd; r++) {
    for (let c = 0; c < grid[r].length; c++) {
      const v = grid[r][c].trim();
      if (looksLikeColor(v)) return v.toUpperCase();
    }
  }
  return null;
}

// ── Parse a single sheet ──────────────────────────────────────────────────────

function parseSheet(sheetName: string, ws: XLSX.WorkSheet): ParsedSheet {
  const grid = sheetToGrid(ws);
  const rows: ParsedRow[] = [];
  const issues: ParseIssueInput[] = [];

  if (grid.length === 0) {
    issues.push({ sheet_name: sheetName, issue_type: "empty_sheet", severity: "info", message: "Sheet is empty — skipped." });
    return { sheetName, rows, issues };
  }

  const styleAnchors = findStyleAnchors(grid);

  if (styleAnchors.length === 0) {
    issues.push({
      sheet_name: sheetName,
      issue_type: "no_style_found",
      severity: "warning",
      message: `No style numbers detected on sheet "${sheetName}". Expected patterns like 100227091BK.`,
    });
    return { sheetName, rows, issues };
  }

  // Process each style anchor as a block
  for (let ai = 0; ai < styleAnchors.length; ai++) {
    const anchor = styleAnchors[ai];
    const nextAnchorRow = styleAnchors[ai + 1]?.rowIdx ?? grid.length;

    // Find color near this style
    let color = findColorNear(grid, anchor.rowIdx);

    // Find scale header row in the block below this style
    const scaleHeader = findScaleHeaderRow(grid, anchor.rowIdx);
    if (!scaleHeader || scaleHeader.rowIdx >= nextAnchorRow) {
      issues.push({
        sheet_name: sheetName,
        issue_type: "no_scale_header",
        severity: "warning",
        message: `Style ${anchor.styleNo}: no scale header row found nearby.`,
        raw_context: { rowIdx: anchor.rowIdx },
      });
      continue;
    }

    const { rowIdx: scaleRowIdx, scaleCols } = scaleHeader;

    // Scan rows below scale header for channel / qty pairs
    const dataStart = scaleRowIdx + 1;
    const dataEnd   = Math.min(nextAnchorRow, scaleRowIdx + 30); // reasonable block height

    for (let r = dataStart; r < dataEnd; r++) {
      const rowCells = grid[r];
      if (!rowCells || rowCells.every(v => !v.trim())) continue; // blank row

      // Try to identify channel in leftmost non-empty cells (cols 0-3)
      let channel: string | null = null;
      for (let c = 0; c <= Math.min(3, rowCells.length - 1); c++) {
        const v = cellUpper(rowCells[c]);
        if (v && looksLikeChannel(v)) { channel = v; break; }
      }

      // Also check if a color appears in this row
      for (let c = 0; c < rowCells.length; c++) {
        const v = rowCells[c].trim();
        if (looksLikeColor(v)) { color = v.toUpperCase(); }
      }

      // Extract qty for each scale column
      for (const { colIdx, code } of scaleCols) {
        if (colIdx >= rowCells.length) continue;
        const rawQty = rowCells[colIdx].trim();
        if (!rawQty) continue;
        const qty = parseInt(rawQty.replace(/[^0-9]/g, ""), 10);
        if (isNaN(qty) || qty <= 0) continue;

        // Confidence scoring
        let confidence = 100;
        if (!color)   confidence -= 30;
        if (!channel) confidence -= 20;

        rows.push({
          styleNo:   anchor.styleNo,
          color:     color ?? "UNKNOWN",
          channel:   channel ?? "UNKNOWN",
          scaleCode: code,
          packQty:   qty,
          sheetName,
          rowIndex:  r,
          confidence,
        });
      }
    }

    if (rows.filter(r => r.styleNo === anchor.styleNo).length === 0) {
      issues.push({
        sheet_name: sheetName,
        issue_type: "no_qty_rows",
        severity: "warning",
        message: `Style ${anchor.styleNo}: scale header found but no quantity rows extracted.`,
        raw_context: { anchor, scaleHeader },
      });
    }
  }

  return { sheetName, rows, issues };
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function parsePackingListFile(file: File): Promise<PackingListParseResult> {
  const buf  = await file.arrayBuffer();
  const wb   = XLSX.read(buf, { type: "array", cellDates: false });

  const sheets: ParsedSheet[] = [];
  const allRows: ParsedRow[]  = [];
  const globalIssues: ParseIssueInput[] = [];

  for (const sheetName of wb.SheetNames) {
    try {
      const ws     = wb.Sheets[sheetName];
      const parsed = parseSheet(sheetName, ws);
      sheets.push(parsed);
      allRows.push(...parsed.rows);
    } catch (err) {
      globalIssues.push({
        sheet_name: sheetName,
        issue_type: "parse_exception",
        severity: "error",
        message: `Sheet "${sheetName}" threw an error during parsing: ${(err as Error).message}`,
      });
    }
  }

  const issues: ParseIssueInput[] = [
    ...globalIssues,
    ...sheets.flatMap(s => s.issues),
  ];

  if (allRows.length === 0 && sheets.length > 0) {
    issues.push({
      sheet_name: null,
      issue_type: "no_rows_parsed",
      severity: "error",
      message: "No quantity rows could be extracted from any sheet. Please check the file format.",
    });
  }

  return { sheets, allRows, issues };
}
