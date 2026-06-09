// src/tanda/exports/useTableExport.ts
//
// Tangerine cross-cutter T3 — Universal table export hook.
//
// Drop-in helper that turns any in-memory row array into an .xlsx (or .csv)
// download. Used by every viewable Tangerine panel via <ExportButton/>.
//
// Design rules:
//   - WYSIWYG: export what the operator sees on screen. Same filters,
//     same sort, same visible columns. Do NOT re-query the DB.
//   - Default column inference: if `columns` is omitted, the hook reads
//     keys off `rows[0]` and uses them as both `key` and `header`.
//   - Cell coercion: dates → US MM/DD/YYYY (xlsx writes a REAL Excel date cell
//     with an mm/dd/yyyy numFmt so it sorts chronologically; csv/pdf use the
//     MM/DD/YYYY string); numbers → numbers (not strings); null → empty;
//     objects → JSON.stringify (rare; UI usually flattens first).
//   - Filename: defaults to `<panel>-<YYYY-MM-DD>.<ext>`. Caller may pass
//     a custom filename (without extension; the hook appends it).
//   - No styling beyond bold header row + autofit columns (cap 60 chars).
//   - For CSV, RFC 4180 quoting; UTF-8 BOM so Excel opens it cleanly.

import { newWorkbook, addLogoBanner, styleHeaderCell, styleBodyCell, downloadExcelWorkbook } from "../../shared/excelLogo";
import { ROF_LOGO_DATA_URL } from "../../shared/assets/rofLogo";

// Excel number format for a column's logical format.
function numFmtFor(format?: string, digits?: number): string | undefined {
  if (format === "currency_cents" || format === "currency_dollars") {
    return digits != null ? `$#,##0.${"0".repeat(digits)}` : "$#,##0.00";
  }
  if (format === "number") return digits != null ? `#,##0.${"0".repeat(digits)}` : "#,##0";
  // Percent values arrive already in percent units (e.g. 12.5 → "12.5%"), so
  // append a literal % rather than Excel's *100 percent format.
  if (format === "percent") return `#,##0.${"0".repeat(digits ?? 1)}"%"`;
  return undefined;
}

export type ExportColumn<T = Record<string, unknown>> = {
  key: keyof T & string;
  header?: string;
  format?: "text" | "number" | "currency_cents" | "currency_dollars" | "date" | "datetime" | "percent";
  digits?: number;           // for number/currency formats
};

export type ExportFormat = "xlsx" | "csv" | "pdf";

export type UseTableExportArgs<T extends Record<string, unknown>> = {
  rows: T[];
  columns?: ExportColumn<T>[];
  filename: string;          // without extension
  format?: ExportFormat;     // default "xlsx"
  sheetName?: string;        // xlsx only; default "Sheet1"
};

export function inferColumns<T extends Record<string, unknown>>(rows: T[]): ExportColumn<T>[] {
  if (!rows || rows.length === 0) return [];
  const keys = Object.keys(rows[0]) as Array<keyof T & string>;
  return keys.map((k) => ({ key: k, header: k }));
}

// US-format date helpers for exported cells. The suite's prevailing display
// format is US MM/DD/YYYY (see formatDate in src/utils/dates.ts); downloads
// must match what the operator sees on screen.
//
// TZ-safety: a bare `YYYY-MM-DD` is a calendar date with no zone, so we slice
// the parts directly (no Date object, no midnight-UTC drift to the prior day).
// A `Date` instance is read in UTC — matching the prior `toISOString().slice`
// behavior and keeping the output deterministic regardless of the runtime TZ.
export function toUsDate(value: unknown): string {
  if (value instanceof Date) {
    return `${String(value.getUTCMonth() + 1).padStart(2, "0")}/${String(value.getUTCDate()).padStart(2, "0")}/${value.getUTCFullYear()}`;
  }
  const s = String(value);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[2]}/${m[3]}/${m[1]}`;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    return `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}/${d.getUTCFullYear()}`;
  }
  return s;
}

// MM/DD/YYYY HH:MM in local time — mirrors the on-screen formatDT helper so a
// timestamp column reads the same in the download as on the panel.
export function toUsDateTime(value: unknown): string {
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) return String(value);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}/${dd}/${d.getFullYear()} ${hh}:${mi}`;
}

// For the xlsx path only: turn a date/datetime value into a REAL Excel date
// cell so Excel sorts/filters chronologically, while still DISPLAYING as US
// MM/DD/YYYY via a numFmt. We derive the calendar parts from the same
// toUsDate/toUsDateTime output the CSV/PDF paths use, so the rendered cell
// matches the string export and the screen exactly. Building the Date from
// LOCAL parts is TZ-safe: ExcelJS subtracts the local offset when it serializes
// to a serial number, so the value lands on the intended calendar date.
// Returns null for empty/unparseable values — caller falls back to a string.
export function excelDateCell(
  value: unknown,
  fmt: "date" | "datetime",
): { value: Date; numFmt: string } | null {
  if (fmt === "date") {
    const m = toUsDate(value).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m) return null;
    return {
      value: new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2])),
      numFmt: "mm/dd/yyyy",
    };
  }
  const m = toUsDateTime(value).match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/);
  if (!m) return null;
  return {
    value: new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]), Number(m[4]), Number(m[5])),
    numFmt: "mm/dd/yyyy hh:mm",
  };
}

export function formatCell(value: unknown, col?: ExportColumn<Record<string, unknown>>): unknown {
  if (value == null) return "";
  const fmt = col?.format;
  if (fmt === "currency_cents") {
    const n = Number(value);
    return Number.isFinite(n) ? n / 100 : "";
  }
  if (fmt === "currency_dollars" || fmt === "number" || fmt === "percent") {
    const n = Number(value);
    return Number.isFinite(n) ? n : "";
  }
  if (fmt === "date") return toUsDate(value);
  if (fmt === "datetime") return toUsDateTime(value);
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

/**
 * Display-string formatting for visual outputs (PDF / HTML print).
 * Reuses the SAME coercion logic as `formatCell` (so values match the xlsx
 * export), then renders the numeric/date results as human-readable strings:
 *   currency_cents / currency_dollars → $X.XX
 *   number  → fixed `digits` (default raw)
 *   percent → X.X%
 *   date / datetime → US MM/DD/YYYY (already strings from formatCell)
 */
export function formatCellDisplay(value: unknown, col?: ExportColumn<Record<string, unknown>>): string {
  const coerced = formatCell(value, col);
  if (coerced === "" || coerced == null) return "";
  const fmt = col?.format;
  const digits = col?.digits;
  if (fmt === "currency_cents" || fmt === "currency_dollars") {
    const n = Number(coerced);
    if (!Number.isFinite(n)) return "";
    return `$${n.toLocaleString(undefined, {
      minimumFractionDigits: digits ?? 2,
      maximumFractionDigits: digits ?? 2,
    })}`;
  }
  if (fmt === "percent") {
    const n = Number(coerced);
    if (!Number.isFinite(n)) return "";
    return `${n.toLocaleString(undefined, {
      minimumFractionDigits: digits ?? 1,
      maximumFractionDigits: digits ?? 1,
    })}%`;
  }
  if (fmt === "number") {
    const n = Number(coerced);
    if (!Number.isFinite(n)) return "";
    return digits == null
      ? n.toLocaleString()
      : n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }
  return String(coerced);
}

export function buildDisplayAoA<T extends Record<string, unknown>>(rows: T[], columns: ExportColumn<T>[]): string[][] {
  const header = columns.map((c) => String(c.header ?? c.key));
  const body = rows.map((r) =>
    columns.map((c) => formatCellDisplay(r[c.key], c as unknown as ExportColumn<Record<string, unknown>>)),
  );
  return [header, ...body];
}

export function buildAoA<T extends Record<string, unknown>>(rows: T[], columns: ExportColumn<T>[]) {
  const header = columns.map((c) => c.header ?? c.key);
  const body = rows.map((r) =>
    columns.map((c) => formatCell(r[c.key], c as unknown as ExportColumn<Record<string, unknown>>)),
  );
  return [header, ...body];
}

// RFC 4180 CSV row encoder. Quotes when value contains comma, double quote, or newline.
export function toCsvRow(values: unknown[]): string {
  return values
    .map((v) => {
      if (v == null) return "";
      const s = typeof v === "string" ? v : String(v);
      if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    })
    .join(",");
}

export function toCsv(aoa: unknown[][]): string {
  return aoa.map(toCsvRow).join("\r\n");
}

export function downloadBlob(blob: Blob, filename: string) {
  if (typeof document === "undefined") return; // SSR / test safety
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function autofitWidths(aoa: unknown[][]) {
  if (aoa.length === 0) return [];
  const colCount = Math.max(...aoa.map((r) => r.length));
  const widths: { wch: number }[] = [];
  for (let c = 0; c < colCount; c += 1) {
    let max = 4;
    for (let r = 0; r < aoa.length; r += 1) {
      const v = aoa[r][c];
      const s = v == null ? "" : String(v);
      if (s.length > max) max = s.length;
    }
    widths.push({ wch: Math.min(60, max + 2) });
  }
  return widths;
}

// Ring of Fire branded xlsx — canonical "ATS look" (blue header band, zebra
// rows, bold-blue first column) with the logo stamped on top. Every Tangerine
// panel export inherits this through the shared hook.
export async function exportXlsx<T extends Record<string, unknown>>(args: UseTableExportArgs<T>) {
  const wb = buildTableWorkbook(args);
  await downloadExcelWorkbook(wb, `${args.filename}.xlsx`);
}

// Builds the branded ExcelJS workbook (no download) — separated so it can be
// unit-tested and previewed.
export function buildTableWorkbook<T extends Record<string, unknown>>(args: UseTableExportArgs<T>) {
  const cols = args.columns && args.columns.length > 0 ? args.columns : inferColumns(args.rows);
  const aoa = buildAoA(args.rows, cols); // [header, ...coerced body]
  const wb = newWorkbook();
  const ws = wb.addWorksheet((args.sheetName || "Sheet1").replace(/[\\/*?:[\]]/g, "-").slice(0, 31));
  const start = addLogoBanner(wb, ws, {
    title: args.sheetName || args.filename,
    subtitle: `${args.rows.length} row${args.rows.length === 1 ? "" : "s"} · ${todayStamp()}`,
    cols: Math.max(cols.length, 1),
  });

  // Header row.
  const hdr = ws.getRow(start);
  cols.forEach((c, i) => {
    const cell = hdr.getCell(i + 1);
    cell.value = String(c.header ?? c.key);
    styleHeaderCell(cell, i === 0 ? "left" : "center");
  });
  hdr.height = 20;

  // Body rows (zebra), with per-column number formats.
  args.rows.forEach((r, ri) => {
    const row = ws.getRow(start + 1 + ri);
    row.height = 15;
    cols.forEach((c, ci) => {
      const cell = row.getCell(ci + 1);
      // Real Excel date cells for date/datetime columns: chronological sort +
      // US MM/DD/YYYY display. Falls through to the string form if unparseable.
      const dc = (c.format === "date" || c.format === "datetime")
        ? excelDateCell(r[c.key], c.format)
        : null;
      if (dc) {
        cell.value = dc.value;
        cell.numFmt = dc.numFmt;
        styleBodyCell(cell, ri, "left", ci === 0 ? "key" : "body");
        return;
      }
      const v = formatCell(r[c.key], c as unknown as ExportColumn<Record<string, unknown>>);
      const isNum = typeof v === "number";
      const kind = ci === 0 ? "key" : isNum && (v as number) < 0 ? "neg" : "body";
      if (v !== "" && v != null) cell.value = v as never;
      styleBodyCell(cell, ri, isNum ? "right" : "left", kind);
      if (isNum) { const nf = numFmtFor(c.format, c.digits); if (nf) cell.numFmt = nf; }
    });
  });

  // Auto-fit widths from the coerced AOA (cap 60), then freeze the header.
  autofitWidths(aoa).forEach((w, i) => { ws.getColumn(i + 1).width = w.wch; });
  ws.views = [{ state: "frozen", xSplit: 0, ySplit: start }];

  return wb;
}

export function exportCsv<T extends Record<string, unknown>>(args: UseTableExportArgs<T>) {
  const cols = args.columns && args.columns.length > 0 ? args.columns : inferColumns(args.rows);
  const aoa = buildAoA(args.rows, cols);
  const csv = toCsv(aoa);
  // UTF-8 BOM so Excel opens CSVs without garbling accents.
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  downloadBlob(blob, `${args.filename}.csv`);
}

// Minimal HTML escaper for safe injection of cell text into the print window.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * PDF export via a print window. No external PDF dependency: we open a blank
 * window, write a styled HTML <table> of the same formatted rows the xlsx path
 * emits, then call print() so the operator saves as PDF. Title = sheetName,
 * and the document title doubles as the default save filename hint.
 */
export function exportPdf<T extends Record<string, unknown>>(args: UseTableExportArgs<T>) {
  if (typeof window === "undefined" || typeof document === "undefined") return; // SSR / test safety
  const cols = args.columns && args.columns.length > 0 ? args.columns : inferColumns(args.rows);
  const aoa = buildDisplayAoA(args.rows, cols);
  const title = args.sheetName || args.filename;

  const headerCells = (aoa[0] || []).map((h) => `<th>${escapeHtml(h)}</th>`).join("");
  const bodyRows = aoa
    .slice(1)
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`)
    .join("");

  const rowCount = args.rows.length;
  const stamp = new Date().toLocaleString();

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>${escapeHtml(args.filename)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; margin: 24px; color: #0f172a; }
  h1 { font-size: 16px; margin: 0 0 2px; }
  .meta { font-size: 11px; color: #64748b; margin-bottom: 12px; }
  table { border-collapse: collapse; width: 100%; font-size: 11px; }
  th, td { border: 1px solid #d0d8e4; padding: 4px 8px; text-align: left; vertical-align: top; }
  thead th { background: #1F497D; color: #ffffff; font-weight: 600; }
  tbody tr:nth-child(even) { background: #eef3fa; }
  .rof-logo { height: 30px; display: block; margin-bottom: 8px; }
  @media print {
    body { margin: 0; }
    thead { display: table-header-group; }
    tr { page-break-inside: avoid; }
  }
</style>
</head>
<body>
  <img class="rof-logo" src="${ROF_LOGO_DATA_URL}" alt="Ring of Fire" />
  <h1>${escapeHtml(title)}</h1>
  <div class="meta">${rowCount} row${rowCount === 1 ? "" : "s"} · ${escapeHtml(stamp)}</div>
  <table>
    <thead><tr>${headerCells}</tr></thead>
    <tbody>${bodyRows}</tbody>
  </table>
</body>
</html>`;

  const win = window.open("", "_blank");
  if (!win) {
    // Pop-up blocked — fall back to xlsx so the operator still gets a deliverable.
    exportXlsx(args);
    return;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
  // Give the new document a tick to lay out before invoking the print dialog.
  const triggerPrint = () => {
    try {
      win.focus();
      win.print();
    } catch {
      /* user closed window before print, or print unsupported */
    }
  };
  if (win.document.readyState === "complete") {
    setTimeout(triggerPrint, 150);
  } else {
    win.onload = () => setTimeout(triggerPrint, 50);
    // Safety net if onload never fires.
    setTimeout(triggerPrint, 400);
  }
}

export function todayStamp(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Imperative hook: returns { exportNow } that triggers the download.
 * Components typically call this from a button's onClick.
 */
export function useTableExport<T extends Record<string, unknown>>(args: UseTableExportArgs<T>) {
  function exportNow(formatOverride?: ExportFormat) {
    const fmt = formatOverride || args.format || "xlsx";
    if (fmt === "csv") exportCsv(args);
    else if (fmt === "pdf") exportPdf(args);
    else exportXlsx(args);
  }
  return { exportNow };
}
