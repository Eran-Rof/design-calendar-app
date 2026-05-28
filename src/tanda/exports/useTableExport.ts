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

import XLSX from "xlsx";

export type ExportColumn<T = Record<string, unknown>> = {
  key: keyof T & string;
  header?: string;
  format?: "text" | "number" | "currency_cents" | "currency_dollars" | "date" | "datetime" | "percent";
  digits?: number;           // for number/currency formats
};

export type ExportFormat = "xlsx" | "csv";

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
    else exportXlsx(args);
  }
  return { exportNow };
}
