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
//   - Cell coercion: dates → ISO; numbers → numbers (not strings); null →
//     empty; objects → JSON.stringify (rare; UI usually flattens first).
//   - Filename: defaults to `<panel>-<YYYY-MM-DD>.<ext>`. Caller may pass
//     a custom filename (without extension; the hook appends it).
//   - No styling beyond bold header row + autofit columns (cap 60 chars).
//   - For CSV, RFC 4180 quoting; UTF-8 BOM so Excel opens it cleanly.

import * as XLSX from "xlsx";

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
  if (fmt === "date") {
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return String(value);
  }
  if (fmt === "datetime") {
    if (value instanceof Date) return value.toISOString();
    return String(value);
  }
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
 *   date / datetime → ISO slice (already strings from formatCell)
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

export function exportXlsx<T extends Record<string, unknown>>(args: UseTableExportArgs<T>) {
  const cols = args.columns && args.columns.length > 0 ? args.columns : inferColumns(args.rows);
  const aoa = buildAoA(args.rows, cols);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = autofitWidths(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, args.sheetName || "Sheet1");
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  downloadBlob(blob, `${args.filename}.xlsx`);
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
  th, td { border: 1px solid #cbd5e1; padding: 4px 8px; text-align: left; vertical-align: top; }
  thead th { background: #1e293b; color: #f1f5f9; font-weight: 600; }
  tbody tr:nth-child(even) { background: #f1f5f9; }
  @media print {
    body { margin: 0; }
    thead { display: table-header-group; }
    tr { page-break-inside: avoid; }
  }
</style>
</head>
<body>
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
