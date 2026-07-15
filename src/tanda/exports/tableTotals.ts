// src/tanda/exports/tableTotals.ts
//
// Tangerine cross-cutter — universal column totals.
//
// Companion to useTableExport / <ExportButton>. Given the SAME `rows` + optional
// `columns` a panel already hands to <ExportButton>, this computes a per-column
// total over the CURRENT (filtered / visible) row set and renders it in a
// toggleable "Totals" strip via <TotalsButton>.
//
// Design rules (mirror the export hook so numbers read identically):
//   - WYSIWYG: totals cover exactly the rows passed in (same filters/sort).
//   - Money is stored as TRUE cents. `currency_cents` columns are summed in
//     raw cents and rendered $X.XX via formatCellDisplay (which divides by 100).
//   - Plain integer / decimal columns (`number`, or inferred numeric) are summed
//     and rendered with thousands separators.
//   - Percentage columns are NOT summed — averaging a percent is misleading, so
//     they are treated as non-numeric (blank in the totals row). Skipping is the
//     documented behavior.
//   - Non-numeric columns (text / date / datetime) render blank.
//   - When a panel passes `columns` with `format`, that metadata drives the
//     money-vs-qty-vs-percent decision. When it passes rows only, numeric
//     columns are inferred conservatively: a column is summable only if every
//     non-null value is a real JS number (avoids summing codes / IDs / strings).

import { type ExportColumn, formatCellDisplay, inferColumns } from "./useTableExport";

export type ColumnTotal = {
  key: string;
  header: string;
  /** true when the column was summed (money or qty). */
  isNumeric: boolean;
  /** raw summed value in the column's native unit (cents stay cents); null when nothing to sum. */
  total: number | null;
  /** formatted display string ("" for non-numeric columns). */
  display: string;
  /** the format used for display (may be synthesized "number" for inferred numerics). */
  format?: string;
  /** true when the column carries a percent format (skipped, but flagged for the footnote). */
  isPercent: boolean;
};

// Formats whose values represent a summable magnitude (money or a count/decimal).
export function formatIsSummable(fmt?: string): boolean {
  return fmt === "currency_cents" || fmt === "currency_dollars" || fmt === "number";
}

// Conservative numeric detection for columns WITHOUT declared format metadata:
// summable only if at least one value is a real finite JS number and NO non-null
// value is a non-number. This deliberately avoids summing numeric-LOOKING strings
// (order numbers, zip codes, style codes) — inference stays safe; declared
// `format` columns are always trusted instead.
export function inferredNumeric<T extends Record<string, unknown>>(rows: T[], key: string): boolean {
  let sawNumber = false;
  for (const r of rows) {
    const v = r[key];
    if (v == null || v === "") continue;
    if (typeof v === "number" && Number.isFinite(v)) {
      sawNumber = true;
      continue;
    }
    return false; // any non-null, non-number value disqualifies the column
  }
  return sawNumber;
}

/**
 * Compute totals for every column, aligned 1:1 with the effective column list
 * (the passed `columns`, or inferred from `rows[0]` when omitted). Numeric
 * columns are summed; percent / text / date columns come back blank.
 */
export function computeColumnTotals<T extends Record<string, unknown>>(
  rows: T[],
  columns?: ExportColumn<T>[],
): ColumnTotal[] {
  const cols = columns && columns.length > 0 ? columns : inferColumns(rows);
  return cols.map((c) => {
    const header = String(c.header ?? c.key);
    const isPercent = c.format === "percent";
    const declared = c.format != null;
    const summable = declared ? formatIsSummable(c.format) : inferredNumeric(rows, c.key);

    if (!summable) {
      return { key: String(c.key), header, isNumeric: false, total: null, display: "", format: c.format, isPercent };
    }

    let sum = 0;
    let any = false;
    for (const r of rows) {
      const v = r[c.key];
      if (v == null || v === "") continue;
      const n = typeof v === "number" ? v : Number(v);
      if (Number.isFinite(n)) {
        sum += n;
        any = true;
      }
    }
    const total = any ? sum : null;
    // Inferred numerics have no declared format → render as a plain number.
    const displayCol = (declared ? c : { ...c, format: "number" }) as ExportColumn<Record<string, unknown>>;
    const display = total == null ? "" : formatCellDisplay(total, displayCol);
    return {
      key: String(c.key),
      header,
      isNumeric: true,
      total,
      display,
      format: displayCol.format,
      isPercent: false,
    };
  });
}

/** True when at least one column produced a numeric total. */
export function hasAnyNumericTotal(totals: ColumnTotal[]): boolean {
  return totals.some((t) => t.isNumeric && t.total != null);
}

/** True when the column set contains at least one percent column (drives the "not summed" footnote). */
export function hasPercentColumn(totals: ColumnTotal[]): boolean {
  return totals.some((t) => t.isPercent);
}
