// src/tanda/exports/ExportButton.tsx
//
// Tangerine T3 cross-cutter — universal table export button.
//
// **2026-06 update:** the single xlsx button is now a small dropdown that
// offers a choice of deliverable: Excel (.xlsx) or PDF. Excel is unchanged
// (the existing useTableExport xlsx path). PDF renders the SAME formatted
// rows into a styled print window so the operator can save as PDF — no PDF
// library dependency is added. CSV survives only as a low-level helper in
// useTableExport.ts; the user-facing menu never emits CSV.
//
// The props API is unchanged, so every existing call site works as-is:
//   <ExportButton rows={rows} filename="ar-aging" />
//   <ExportButton rows={rows} columns={cols} filename="trial-balance" sheetName="Trial Balance" />
//
// The button:
// - Disabled when `rows` is empty (cursor + opacity + title tooltip)
// - Shows row count in the label, e.g. Export (47)
// - Filename gets a YYYY-MM-DD stamp appended automatically
// - WYSIWYG — operates on whatever rows the caller passes (filtered / sorted)
// - Menu closes on outside-click or Escape

import { useEffect, useRef, useState } from "react";
import { useTableExport, todayStamp, type ExportColumn } from "./useTableExport";
import TotalsButton from "./TotalsButton";

type Props<T extends Record<string, unknown>> = {
  rows: T[];
  columns?: ExportColumn<T>[];
  filename: string;
  sheetName?: string;
  buttonStyle?: React.CSSProperties;
  label?: string;
  /**
   * Optional totals row appended as the last row of the export (bold in xlsx,
   * plain final row in csv/pdf). Backward compatible — omit for no totals.
   * Key it by the same column keys, e.g. { customer: "Total", amount: 12345 }.
   */
  totalsRow?: Partial<T>;
  /**
   * Optional async provider for the FULL export set. When present, picking a
   * format awaits this (the button shows "Preparing…") and exports whatever it
   * returns, instead of the bound `rows`. Use when the on-screen `rows` are a
   * capped/paginated subset and the export must cover everything (operator
   * item 17 — SO grid "Export all" walks every filtered page). `rows` is still
   * used for the count label and the enabled/disabled state.
   */
  fetchRows?: () => Promise<T[]>;
  /**
   * Opt OUT of the adjacent universal "Totals" button. By default every export
   * control also renders a <TotalsButton> (same rows/columns) so the operator
   * can total any numeric column. Pass `noTotals` on panels that already show
   * their own totals/subtotal footer (statement-shaped reports, matrix grids)
   * to avoid a redundant control.
   */
  noTotals?: boolean;
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
  top: "calc(100% + 4px)",
  right: 0,
  zIndex: 1000,
  minWidth: 168,
  background: "#1E293B",
  border: "1px solid #334155",
  borderRadius: 6,
  boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
  padding: 4,
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const menuItemStyle: React.CSSProperties = {
  background: "transparent",
  color: "#F1F5F9",
  border: "none",
  borderRadius: 4,
  padding: "7px 10px",
  fontSize: 12,
  textAlign: "left",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

export default function ExportButton<T extends Record<string, unknown>>(props: Props<T>) {
  const { rows, columns, filename, sheetName, buttonStyle, label, totalsRow, fetchRows, noTotals } = props;
  const stampedFilename = `${filename}-${todayStamp()}`;
  const { exportNow } = useTableExport({ rows, columns, filename: stampedFilename, sheetName, format: "xlsx", totalsRow });

  const disabled = !rows || rows.length === 0;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Close on outside-click and Escape.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent | TouchEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("touchstart", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("touchstart", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = async (fmt: "xlsx" | "pdf") => {
    setOpen(false);
    if (disabled || busy) return;
    if (!fetchRows) { exportNow(fmt); return; }
    setBusy(true);
    try {
      const all = await fetchRows();
      exportNow(fmt, all);
    } catch {
      // Fall back to the on-screen rows so the operator still gets a deliverable.
      exportNow(fmt);
    } finally {
      setBusy(false);
    }
  };

  const rowSuffix = busy ? "" : rows && rows.length > 0 ? ` (${rows.length})` : "";

  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      {!noTotals && <TotalsButton rows={rows} columns={columns} buttonStyle={buttonStyle} />}
      <div ref={wrapRef} style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        onClick={() => !disabled && !busy && setOpen((v) => !v)}
        disabled={disabled || busy}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{
          ...defaultBtn,
          ...buttonStyle,
          opacity: disabled || busy ? 0.5 : 1,
          cursor: disabled || busy ? "not-allowed" : "pointer",
        }}
        title={disabled ? "No rows to export" : `Export ${rows.length} row${rows.length === 1 ? "" : "s"} (Excel or PDF)`}
      >
        {busy ? "Preparing…" : (label || "Export")}
        {rowSuffix}
        <span style={{ marginLeft: 4, fontSize: 9, opacity: 0.7 }}>▾</span>
      </button>

      {open && !disabled && (
        <div role="menu" style={menuStyle}>
          <button
            type="button"
            role="menuitem"
            style={menuItemStyle}
            onMouseEnter={(e) => (e.currentTarget.style.background = "#334155")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            onClick={() => void pick("xlsx")}
          >
            Excel (.xlsx)
          </button>
          <button
            type="button"
            role="menuitem"
            style={menuItemStyle}
            onMouseEnter={(e) => (e.currentTarget.style.background = "#334155")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            onClick={() => void pick("pdf")}
          >
            PDF
          </button>
        </div>
      )}
      </div>
    </span>
  );
}
