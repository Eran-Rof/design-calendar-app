// src/shared/matrix/EditableSizeMatrix.tsx
//
// Editable size-matrix table — the operator-facing "new matrix layout" for
// inventory entry surfaces (SO entry, PO entry, inventory adjustments). It
// mirrors the read-only Inventory Matrix / poMatrixTab styling (dark theme,
// one row per color × optional rise, size columns in scale order, an amber
// row/column TOTAL) but every size cell is an INLINE numeric input — no popup.
//
// Optional per-row unit value (price/cost) renders as a trailing editable
// column with a "set all rows" bulk field in its header, so the operator can
// stamp one unit value across the whole grid and then tweak individual rows.
//
// Reused across the SO / PO / adjustment matrices so every inventory surface
// shares one layout. Callers own the qty/unit state and the cell→SKU mapping.

import React from "react";

const C = {
  headerBg: "#0F172A", headerText: "#6B7280", gridText: "#E5E7EB",
  base: "#60A5FA", desc: "#9CA3AF", amber: "#F59E0B", green: "#10B981",
  rowBdr: "#1E293B", sectionBdr: "#334155", emptyCell: "#475569",
  text: "#F1F5F9", textMuted: "#94A3B8", cardBdr: "#334155", primary: "#3B82F6",
};

/** One matrix row — typically a color, optionally split by rise/inseam. */
export type EditableMatrixRow = {
  /** Stable unique row key, e.g. `${color}|${rise}`. */
  key: string;
  color: string | null;
  /** Optional secondary descriptor (rise / inseam) shown in its own column. */
  rise?: string | null;
};

export type EditableSizeMatrixProps = {
  rows: EditableMatrixRow[];
  sizes: string[];
  /** Show the secondary (rise/inseam) descriptor column. */
  showRise?: boolean;
  riseLabel?: string;
  /** Quantity per cell. Key = matrixCellKey(rowKey, size). */
  qty: Record<string, number>;
  onQtyChange: (rowKey: string, size: string, value: number) => void;
  /**
   * Allow signed (negative) integers in qty cells (e.g. inventory adjustments
   * where a cell can be -5 or +12). Default false keeps the original
   * positive-only behaviour for SO / PO entry. Blank or "-" is treated as 0.
   */
  allowNegative?: boolean;
  /** Faint per-cell on-hand hint (never negative). Key = matrixCellKey(rowKey, size). */
  onHand?: Record<string, number>;
  /** Optional editable per-row unit value with a bulk "set all" header field. */
  unit?: {
    label: string;
    placeholder?: string;
    /** Per-row unit value (free text — dollars/cents owned by the caller). Key = rowKey. */
    values: Record<string, string>;
    onChange: (rowKey: string, value: string) => void;
    /** Stamp the given value onto every row. */
    onSetAll: (value: string) => void;
  };
};

/** Cell-state key shared by callers (qty + on-hand maps). */
export const matrixCellKey = (rowKey: string, size: string) => `${rowKey}__${size}`;

const thBase: React.CSSProperties = {
  padding: "8px 12px", color: C.headerText, fontSize: 11,
  textTransform: "uppercase", letterSpacing: 1, borderBottom: `2px solid ${C.sectionBdr}`,
};
const cellInput: React.CSSProperties = {
  width: "5ch", textAlign: "right", background: "#0b1220", color: C.text,
  border: `1px solid ${C.cardBdr}`, borderRadius: 4, padding: "4px 6px",
  fontSize: 13, fontFamily: "SFMono-Regular, Menlo, monospace", boxSizing: "border-box",
};
const unitInput: React.CSSProperties = { ...cellInput, width: "8ch" };

/** Parse a buffered cell string into a clamped integer.
 *  Positive-only mode (default): clamps to > 0, else 0.
 *  Signed mode: accepts negatives; blank/"-" → 0. */
function toInt(raw: string, allowNegative: boolean): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return 0;
  if (allowNegative) return n;
  return n > 0 ? n : 0;
}

/**
 * A single qty cell with a LOCAL string buffer so the operator can type an
 * in-progress value like a lone "-" before the number arrives. The buffer is
 * re-synced from the parent numeric value whenever it changes externally
 * (e.g. "set all" or a reset). It validates keystrokes against a regex
 * (`/^-?\d*$/` signed, `/^\d*$/` unsigned) and pushes the parsed integer up.
 */
function QtyCell({
  rowKey, size, color, value, allowNegative, onChange,
}: {
  rowKey: string;
  size: string;
  color: string | null;
  value: number;
  allowNegative: boolean;
  onChange: (rowKey: string, size: string, value: number) => void;
}) {
  const display = value ? String(value) : "";
  const [buf, setBuf] = React.useState(display);
  // Re-sync the buffer when the parent value changes from the outside, but not
  // while the buffer already parses to the same number (avoid clobbering an
  // in-progress "-" or "007"-style entry that resolves to the same value).
  React.useEffect(() => {
    if (toInt(buf, allowNegative) !== value) setBuf(value ? String(value) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const re = allowNegative ? /^-?\d*$/ : /^\d*$/;

  return (
    <input
      type="text"
      inputMode={allowNegative ? "text" : "numeric"}
      value={buf}
      onChange={(e) => {
        const next = e.target.value;
        if (!re.test(next)) return; // reject invalid keystrokes
        setBuf(next);
        onChange(rowKey, size, toInt(next, allowNegative));
      }}
      onBlur={() => { setBuf(value ? String(value) : ""); }}
      placeholder="0"
      aria-label={`Qty ${color || ""} ${size}`}
      style={{ ...cellInput, color: value ? C.text : C.emptyCell }}
    />
  );
}

export function EditableSizeMatrix({
  rows, sizes, showRise = false, riseLabel = "Rise", qty, onQtyChange, onHand, unit,
  allowNegative = false,
}: EditableSizeMatrixProps) {
  const [bulk, setBulk] = React.useState("");

  const colTotals: Record<string, number> = {};
  let grandQty = 0;
  for (const r of rows) {
    for (const sz of sizes) {
      const q = qty[matrixCellKey(r.key, sz)] || 0;
      colTotals[sz] = (colTotals[sz] || 0) + q;
      grandQty += q;
    }
  }
  const leadCols = 1 + (showRise ? 1 : 0);

  return (
    <div style={{ overflowX: "auto", background: C.headerBg, borderRadius: 8, border: `1px solid ${C.sectionBdr}` }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ background: C.headerBg }}>
            <th style={{ ...thBase, textAlign: "left" }}>Color</th>
            {showRise && <th style={{ ...thBase, textAlign: "left" }}>{riseLabel}</th>}
            {sizes.map((sz) => (
              <th key={sz} style={{ ...thBase, textAlign: "center", minWidth: 56 }}>{sz}</th>
            ))}
            <th style={{ ...thBase, textAlign: "center" }}>Total</th>
            {unit && (
              <th style={{ ...thBase, textAlign: "right", minWidth: 110 }}>
                <div style={{ marginBottom: 4 }}>{unit.label}</div>
                <input
                  type="text"
                  inputMode="decimal"
                  value={bulk}
                  onChange={(e) => setBulk(e.target.value)}
                  onBlur={() => { if (bulk.trim() !== "") unit.onSetAll(bulk.trim()); }}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (bulk.trim() !== "") unit.onSetAll(bulk.trim()); } }}
                  placeholder={unit.placeholder || "set all"}
                  title="Type a value and press Enter (or tab out) to stamp it onto every row, then edit individual rows as needed."
                  style={{ ...unitInput, width: "9ch", borderColor: C.primary }}
                />
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => {
            const isLast = ri === rows.length - 1;
            let rowQty = 0;
            for (const sz of sizes) rowQty += qty[matrixCellKey(row.key, sz)] || 0;
            return (
              <tr key={row.key} style={{ borderBottom: isLast ? `2px solid ${C.sectionBdr}` : `1px solid ${C.rowBdr}` }}>
                <td style={{ padding: "6px 12px", color: "#D1D5DB", borderRight: `1px solid ${C.rowBdr}` }}>{row.color || "—"}</td>
                {showRise && (
                  <td style={{ padding: "6px 12px", color: "#C4B5FD", fontFamily: "monospace" }}>{row.rise || "—"}</td>
                )}
                {sizes.map((sz) => {
                  const k = matrixCellKey(row.key, sz);
                  const oh = onHand ? onHand[k] : undefined;
                  return (
                    <td key={sz} style={{ padding: "4px 6px", textAlign: "center" }}>
                      {oh != null && (
                        <div style={{ fontSize: 9, color: C.textMuted, lineHeight: 1, marginBottom: 2 }} title="on-hand">{oh}</div>
                      )}
                      <QtyCell
                        rowKey={row.key}
                        size={sz}
                        color={row.color}
                        value={qty[k] || 0}
                        allowNegative={allowNegative}
                        onChange={onQtyChange}
                      />
                    </td>
                  );
                })}
                <td style={{ padding: "6px 12px", textAlign: "center", color: rowQty ? C.amber : C.emptyCell, fontWeight: 700, fontFamily: "monospace" }}>
                  {rowQty || "—"}
                </td>
                {unit && (
                  <td style={{ padding: "4px 6px", textAlign: "right" }}>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={unit.values[row.key] ?? ""}
                      onChange={(e) => unit.onChange(row.key, e.target.value)}
                      placeholder={unit.placeholder || "0.00"}
                      aria-label={`${unit.label} ${row.color || ""}`}
                      style={unitInput}
                    />
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr style={{ borderTop: `2px solid ${C.sectionBdr}`, background: C.headerBg }}>
            <td colSpan={leadCols} style={{ padding: "10px 12px", color: C.desc, fontWeight: 700, textAlign: "right" }}>Grand Total</td>
            {sizes.map((sz) => (
              <td key={sz} style={{ padding: "10px 12px", textAlign: "center", color: colTotals[sz] ? C.amber : C.emptyCell, fontWeight: 700, fontFamily: "monospace" }}>
                {colTotals[sz] || "—"}
              </td>
            ))}
            <td style={{ padding: "10px 12px", textAlign: "center", color: C.amber, fontWeight: 800, fontFamily: "monospace" }}>{grandQty || "—"}</td>
            {unit && <td style={{ padding: "10px 12px" }} />}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export default EditableSizeMatrix;
