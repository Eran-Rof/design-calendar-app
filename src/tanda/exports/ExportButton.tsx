// src/tanda/exports/ExportButton.tsx
//
// Tangerine T3 cross-cutter — universal table export button.
//
// **T8 update (2026-05-28):** xlsx-only. Single-click download; no dropdown,
// no CSV option. Operator-confirmed standardization — Excel is the only
// supported deliverable going forward. CSV behavior survives as a low-level
// helper in useTableExport.ts for any internal caller that genuinely needs
// it, but the user-facing button never emits CSV.
//
// Usage:
//   <ExportButton rows={rows} filename="ar-aging" />
//   <ExportButton rows={rows} columns={cols} filename="trial-balance" sheetName="Trial Balance" />
//
// The button:
// - Disabled when `rows` is empty (cursor + opacity + title tooltip)
// - Shows row count in the label, e.g. ⬇ Export (47)
// - Filename gets a YYYY-MM-DD stamp appended automatically
// - WYSIWYG — operates on whatever rows the caller passes (filtered / sorted)

import { useTableExport, todayStamp, type ExportColumn } from "./useTableExport";

type Props<T extends Record<string, unknown>> = {
  rows: T[];
  columns?: ExportColumn<T>[];
  filename: string;
  sheetName?: string;
  buttonStyle?: React.CSSProperties;
  label?: string;
};

const defaultBtn: React.CSSProperties = {
  background: "transparent",
  color: "#CBD5E1",
  border: "1px solid #334155",
  padding: "6px 10px",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 12,
};

export default function ExportButton<T extends Record<string, unknown>>(props: Props<T>) {
  const { rows, columns, filename, sheetName, buttonStyle, label } = props;
  const stampedFilename = `${filename}-${todayStamp()}`;
  const { exportNow } = useTableExport({ rows, columns, filename: stampedFilename, sheetName, format: "xlsx" });

  const disabled = !rows || rows.length === 0;

  return (
    <button
      type="button"
      onClick={() => !disabled && exportNow("xlsx")}
      disabled={disabled}
      style={{
        ...defaultBtn,
        ...buttonStyle,
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
      title={disabled ? "No rows to export" : `Download ${rows.length} row${rows.length === 1 ? "" : "s"} as Excel`}
    >
      ⬇ {label || "Export"}{rows && rows.length > 0 ? ` (${rows.length})` : ""}
    </button>
  );
}
