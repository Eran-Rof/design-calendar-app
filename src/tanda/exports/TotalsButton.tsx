// src/tanda/exports/TotalsButton.tsx
//
// Tangerine cross-cutter — universal "Totals" button.
//
// Drop-in sibling to <ExportButton>. Takes the SAME `rows` + optional `columns`
// a panel already passes to <ExportButton>, and toggles a compact totals strip
// that sums every numeric column over the CURRENT (filtered / visible) rows.
//
//   <ExportButton rows={filtered} columns={cols} filename="..." />
//   <TotalsButton  rows={filtered} columns={cols} />   // same props, one line
//
// Behavior:
// - Toggle is LOCAL to this button instance (per-table, not global).
// - Money columns (currency_cents / currency_dollars) sum + render $X.XX.
// - Qty / number columns sum + render with thousands separators.
// - Percent columns are NOT summed (averaging a percent misleads) — shown blank,
//   with a small "Percentages are not summed" footnote when any exist.
// - Text / date columns render blank in the totals row.
// - When no `columns` are passed, numeric columns are inferred from the data.
// - Disabled when there are no rows or no numeric columns to total.
//
// UI: matches the app dark palette (#0b1220 / #1E293B / #334155 / #F1F5F9); the
// totals row gets a subtle distinct background, consistent with existing footer
// styling. No decorative emoji.

import { useEffect, useMemo, useRef, useState } from "react";
import { type ExportColumn } from "./useTableExport";
import { computeColumnTotals, hasAnyNumericTotal, hasPercentColumn, formatIsSummable } from "./tableTotals";

type Props<T extends Record<string, unknown>> = {
  rows: T[];
  columns?: ExportColumn<T>[];
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

const activeBtn: React.CSSProperties = {
  background: "#1E293B",
  color: "#F1F5F9",
  borderColor: "#3B82F6",
};

const panelStyle: React.CSSProperties = {
  position: "absolute",
  top: "calc(100% + 4px)",
  right: 0,
  zIndex: 1000,
  maxWidth: "min(760px, 95vw)",
  maxHeight: "60vh",
  overflow: "auto",
  background: "#1E293B",
  border: "1px solid #334155",
  borderRadius: 6,
  boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
  padding: 10,
};

export default function TotalsButton<T extends Record<string, unknown>>(props: Props<T>) {
  const { rows, columns, buttonStyle, label } = props;
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const totals = useMemo(() => computeColumnTotals(rows, columns), [rows, columns]);
  const anyNumeric = hasAnyNumericTotal(totals);
  const showPercentNote = hasPercentColumn(totals);
  const disabled = !rows || rows.length === 0 || !anyNumeric;

  // Close on outside-click and Escape (mirrors ExportButton).
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

  // Hide entirely (rather than show a disabled control) on grids that have no
  // numeric columns to total — keeps master-data / text-only grids clean. We
  // can tell either from typed columns (all declared non-summable) or, once
  // rows have loaded, from there being nothing numeric to sum.
  const columnsAllNonNumeric =
    !!columns && columns.length > 0 && columns.every((c) => c.format != null && !formatIsSummable(c.format));
  if (columnsAllNonNumeric) return null;
  if (rows && rows.length > 0 && !anyNumeric) return null;

  return (
    <div ref={wrapRef} style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        style={{
          ...defaultBtn,
          ...buttonStyle,
          ...(open && !disabled ? activeBtn : null),
          opacity: disabled ? 0.5 : 1,
          cursor: disabled ? "not-allowed" : "pointer",
        }}
        title={
          disabled
            ? rows && rows.length > 0
              ? "No numeric columns to total"
              : "No rows to total"
            : `Total ${rows.length} row${rows.length === 1 ? "" : "s"}`
        }
      >
        {label || "Totals"}
        <span style={{ marginLeft: 4, fontSize: 9, opacity: 0.7 }}>▾</span>
      </button>

      {open && !disabled && (
        <div role="dialog" aria-label="Column totals" style={panelStyle}>
          <div style={{ fontSize: 11, color: "#94A3B8", marginBottom: 6, whiteSpace: "nowrap" }}>
            Totals · {rows.length} row{rows.length === 1 ? "" : "s"}
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", fontSize: 12, whiteSpace: "nowrap" }}>
              <thead>
                <tr>
                  <th style={thStyle}></th>
                  {totals.map((t) => (
                    <th key={t.key} style={{ ...thStyle, textAlign: t.isNumeric ? "right" : "left" }}>
                      {t.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={{ ...tdStyle, ...totalsCellStyle, fontWeight: 700, color: "#F1F5F9" }}>Totals</td>
                  {totals.map((t) => (
                    <td
                      key={t.key}
                      style={{
                        ...tdStyle,
                        ...totalsCellStyle,
                        textAlign: t.isNumeric ? "right" : "left",
                        color: t.isNumeric ? "#F1F5F9" : "#64748B",
                        fontVariantNumeric: "tabular-nums",
                        fontWeight: t.isNumeric ? 600 : 400,
                      }}
                    >
                      {t.display}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
          {showPercentNote && (
            <div style={{ fontSize: 10, color: "#64748B", marginTop: 6 }}>
              Percentages are not summed.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const thStyle: React.CSSProperties = {
  color: "#94A3B8",
  fontWeight: 600,
  padding: "4px 10px",
  borderBottom: "1px solid #334155",
  textAlign: "left",
};

const tdStyle: React.CSSProperties = {
  padding: "6px 10px",
};

// Subtle distinct background for the totals row, consistent with the app's
// dark footer styling.
const totalsCellStyle: React.CSSProperties = {
  background: "#0b1220",
  borderTop: "1px solid #334155",
};
