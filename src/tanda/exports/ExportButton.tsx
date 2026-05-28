// src/tanda/exports/ExportButton.tsx
//
// Tangerine cross-cutter T3 — drop-in Export button for any panel.
//
// Usage:
//   <ExportButton rows={rows} filename="ar-aging" />                 // .xlsx, columns inferred
//   <ExportButton rows={rows} columns={cols} filename="trial-balance" sheetName="Trial Balance" />
//   <ExportButton rows={rows} filename="bank-transactions" defaultFormat="csv" />
//
// Renders a small button with a dropdown for xlsx / csv. Disabled when
// `rows` is empty. Filename gets a YYYY-MM-DD stamp appended automatically.

import { useState, useRef, useEffect } from "react";
import { useTableExport, todayStamp, type ExportColumn, type ExportFormat } from "./useTableExport";

type Props<T extends Record<string, unknown>> = {
  rows: T[];
  columns?: ExportColumn<T>[];
  filename: string;
  sheetName?: string;
  defaultFormat?: ExportFormat;
  // Style overrides; defaults match the dark Tangerine theme.
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

const menuStyle: React.CSSProperties = {
  position: "absolute",
  top: "100%",
  right: 0,
  marginTop: 2,
  background: "#1E293B",
  border: "1px solid #334155",
  borderRadius: 4,
  minWidth: 110,
  zIndex: 50,
  boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
};

const itemStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  background: "transparent",
  border: 0,
  padding: "8px 12px",
  fontSize: 12,
  color: "#F1F5F9",
  cursor: "pointer",
};

export default function ExportButton<T extends Record<string, unknown>>(props: Props<T>) {
  const { rows, columns, filename, sheetName, defaultFormat, buttonStyle, label } = props;
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const stampedFilename = `${filename}-${todayStamp()}`;
  const { exportNow } = useTableExport({ rows, columns, filename: stampedFilename, sheetName, format: defaultFormat });

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const disabled = !rows || rows.length === 0;

  function handleExport(fmt: ExportFormat) {
    setOpen(false);
    exportNow(fmt);
  }

  return (
    <div ref={wrapRef} style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        style={{
          ...defaultBtn,
          ...buttonStyle,
          opacity: disabled ? 0.5 : 1,
          cursor: disabled ? "not-allowed" : "pointer",
        }}
        title={disabled ? "No rows to export" : "Download as Excel or CSV"}
      >
        ⬇ {label || "Export"}{rows && rows.length > 0 ? ` (${rows.length})` : ""}
      </button>
      {open && (
        <div style={menuStyle} role="menu">
          <button type="button" style={itemStyle} onClick={() => handleExport("xlsx")} role="menuitem"
                  onMouseOver={(e) => (e.currentTarget.style.background = "rgba(59,130,246,0.14)")}
                  onMouseOut={(e) => (e.currentTarget.style.background = "transparent")}>
            Excel (.xlsx)
          </button>
          <button type="button" style={itemStyle} onClick={() => handleExport("csv")} role="menuitem"
                  onMouseOver={(e) => (e.currentTarget.style.background = "rgba(59,130,246,0.14)")}
                  onMouseOut={(e) => (e.currentTarget.style.background = "transparent")}>
            CSV (.csv)
          </button>
        </div>
      )}
    </div>
  );
}
