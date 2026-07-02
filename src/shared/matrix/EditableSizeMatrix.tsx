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
  /** Tooltip shown on hover over each per-cell hint. Defaults to "on-hand";
   *  callers in ATS mode pass e.g. "ATS (07/09/2026)". */
  onHandTitle?: string;
  /** Optional editable per-row unit value with a bulk "set all" header field. */
  unit?: {
    label: string;
    placeholder?: string;
    /** Per-row unit value (free text — dollars/cents owned by the caller). Key = rowKey. */
    values: Record<string, string>;
    onChange: (rowKey: string, value: string) => void;
    /** Stamp the given value onto every row. */
    onSetAll: (value: string) => void;
    /** When true, append a per-row extended "Total $" column (row units × unit
     *  value) plus a grand-total footer cell. Opt-in so the PO / adjustment /
     *  transfer grids that share this component stay unchanged. */
    showLineTotal?: boolean;
    /** When set (e.g. 2), reformat the unit value to this many decimals on blur
     *  (plain, no grouping commas — callers parse the value with Number()). */
    forceDecimals?: number;
    /** Optional per-each DRIVER column rendered immediately BEFORE this column.
     *  Used for prepacks: the operator types a per-each price here and the caller
     *  computes this column's value (the pack price) = each × pack size. Opt-in,
     *  so every non-prepack grid that shares this component is unchanged. */
    each?: {
      label: string;
      placeholder?: string;
      values: Record<string, string>;
      onChange: (rowKey: string, value: string) => void;
      onSetAll?: (value: string) => void;
    };
  };
  /** Optional editable per-row Lot value (free text) with a bulk "set all"
   *  header field. Grain is the row (style+color). Opt-in so SO / AR / adjustment
   *  grids that share this component stay unchanged (PO entry uses it). */
  lot?: {
    label?: string;                         // default "Lot"
    placeholder?: string;
    /** Per-row lot value. Key = rowKey. */
    values: Record<string, string>;
    onChange: (rowKey: string, value: string) => void;
    /** Stamp the given value onto every row. */
    onSetAll?: (value: string) => void;
  };
  /** Optional per-row Customer PO column (SO per-line PO feature). Grain is the
   *  row (style+color), mirroring `lot`. A row whose PO differs from the header
   *  PO is split onto a new SO at save (caller owns the split). Opt-in. */
  customerPo?: {
    label?: string;                         // default "Customer PO"
    placeholder?: string;
    /** Per-row PO value (already defaulted to the header PO by the caller). Key = rowKey. */
    values: Record<string, string>;
    onChange: (rowKey: string, value: string) => void;
    onSetAll?: (value: string) => void;
    /** Amber-highlight rows whose PO differs from this (the header PO) — flags a split. */
    highlightWhenDiffersFrom?: string;
  };
  /** Optional per-row quick-fill: a "Qty" column between the lead columns and
   *  the first size. The operator types one TOTAL for the row and on Enter/Tab
   *  the caller distributes it across the sizes (via the style's stored size
   *  scale). Opt-in so the inventory-adjustment / transfer grids stay unchanged. */
  quickFill?: {
    /** Distribute `total` across this row's sizes. Caller owns the math + qty. */
    onApply: (rowKey: string, total: number) => void;
    /** Disable the input for a row that has no usable scale (tooltip explains). */
    enabledFor?: (rowKey: string) => boolean;
    /** Tooltip for a row whose scale is missing (when enabledFor returns false). */
    disabledTitle?: string;
    /** Pre-fill the Qty box for a row (e.g. an AI-imported total that was spread
     *  across the sizes). Shown as the box's value; re-applies on Enter/Tab. */
    valueFor?: (rowKey: string) => string | undefined;
  };
  /** Opt-in (SO / PO entry): once any cell carries a quantity, the FIRST size
   *  column header turns green and is clickable — clicking hides the all-zero
   *  size columns BEFORE the first sized column and AFTER the last, collapsing
   *  the grid to the range actually being ordered. Click again to show them all. */
  collapsibleSizes?: boolean;
  /** Opt-in: fired when a qty cell is committed (blur / Enter), with the committed
   *  value and the value the cell held when editing began. SO-from-ATS uses this
   *  to warn when the operator orders more than the available-to-ship quantity. */
  onCellCommit?: (rowKey: string, size: string, value: number, prevValue: number) => void;
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

/** Strip grouping commas and parse a money-ish string to a number (NaN-safe → null). */
function parseMoney(raw: string): number | null {
  const t = (raw ?? "").replace(/,/g, "").trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
/** Comma-grouped, fixed-decimal money string for display-only cells. */
function fmtMoney(n: number, decimals = 2): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

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
  rowKey, size, color, value, allowNegative, onChange, onCommit,
}: {
  rowKey: string;
  size: string;
  color: string | null;
  value: number;
  allowNegative: boolean;
  onChange: (rowKey: string, size: string, value: number) => void;
  /** Fired on blur / Enter with the committed value + the value at focus. */
  onCommit?: (rowKey: string, size: string, value: number, prevValue: number) => void;
}) {
  const display = value ? String(value) : "";
  const [buf, setBuf] = React.useState(display);
  // The cell's value when editing began — passed to onCommit so the caller can
  // offer a "cancel / revert" that restores it.
  const focusVal = React.useRef(value);
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
      onFocus={() => { focusVal.current = value; }}
      onChange={(e) => {
        const next = e.target.value;
        if (!re.test(next)) return; // reject invalid keystrokes
        setBuf(next);
        onChange(rowKey, size, toInt(next, allowNegative));
      }}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
      onBlur={() => { const committed = toInt(buf, allowNegative); setBuf(value ? String(value) : ""); onCommit?.(rowKey, size, committed, focusVal.current); }}
      placeholder="0"
      aria-label={`Qty ${color || ""} ${size}`}
      // #2 — auto-grow the qty field to the digits entered (monospace ch units,
      // +2 covers the box-border padding) so 4-5 digit quantities aren't clipped.
      style={{ ...cellInput, width: `${Math.max(5, buf.length + 2)}ch`, color: value ? C.text : C.emptyCell }}
    />
  );
}

/**
 * Quick-fill "Qty" cell — the operator types one total for the row and on
 * Enter/Tab the parent distributes it across the row's sizes via the style's
 * stored size scale. Local string buffer (digits only); the typed value stays
 * visible for reference (the row Total column shows the true distributed sum).
 */
function QuickFillCell({
  rowKey, enabled, disabledTitle, onApply, initial,
}: {
  rowKey: string;
  enabled: boolean;
  disabledTitle?: string;
  onApply: (rowKey: string, total: number) => void;
  initial?: string;
}) {
  // Seed the box with an imported total (e.g. from the AI PO upload). Re-sync if
  // it changes from the outside, but don't clobber what the operator is typing.
  const [buf, setBuf] = React.useState(initial || "");
  React.useEffect(() => { if (initial != null && initial !== "") setBuf(initial); }, [initial]);
  const apply = () => {
    const n = Math.floor(Number(buf));
    if (Number.isFinite(n) && n > 0) onApply(rowKey, n);
  };
  return (
    <input
      type="text"
      inputMode="numeric"
      value={buf}
      disabled={!enabled}
      onChange={(e) => { if (/^\d*$/.test(e.target.value)) setBuf(e.target.value); }}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); apply(); } }}
      onBlur={apply}
      placeholder={enabled ? "total" : "—"}
      title={enabled ? "Type a total and press Enter/Tab to fill every size from this style's size scale (rounded up to full cartons)" : (disabledTitle || "No size scale set for this style")}
      aria-label={`Quick-fill total ${rowKey}`}
      style={{ ...cellInput, width: "7ch", borderColor: enabled ? C.primary : C.cardBdr, opacity: enabled ? 1 : 0.5, color: C.text }}
    />
  );
}

export function EditableSizeMatrix({
  rows, sizes, showRise = false, riseLabel = "Rise", qty, onQtyChange, onHand, onHandTitle = "on-hand", unit, lot, customerPo,
  allowNegative = false, quickFill, collapsibleSizes = false, onCellCommit,
}: EditableSizeMatrixProps) {
  const [bulk, setBulk] = React.useState("");
  const [bulkEach, setBulkEach] = React.useState("");
  const [bulkLot, setBulkLot] = React.useState("");
  const [bulkPo, setBulkPo] = React.useState("");
  const [collapsed, setCollapsed] = React.useState(false);

  // Normalise a typed unit value for "set all": blank → null (no stamp); else
  // apply forceDecimals (plain, no commas) so the whole grid lands at 2 dp.
  function stampValue(raw: string): string | null {
    if (raw.trim() === "") return null;
    if (unit?.forceDecimals != null) {
      const n = parseMoney(raw);
      if (n != null) return n.toFixed(unit.forceDecimals);
    }
    return raw.trim();
  }

  const colTotals: Record<string, number> = {};
  let grandQty = 0;
  let grandExt = 0; // Σ row units × row unit value (only when unit.showLineTotal)
  for (const r of rows) {
    let rowQty = 0;
    for (const sz of sizes) {
      const q = qty[matrixCellKey(r.key, sz)] || 0;
      colTotals[sz] = (colTotals[sz] || 0) + q;
      grandQty += q;
      rowQty += q;
    }
    const u = unit ? parseMoney(unit.values[r.key] ?? "") : null;
    if (u != null) grandExt += rowQty * u;
  }
  const leadCols = 1 + (showRise ? 1 : 0);

  // Collapsible size range (opt-in). firstIdx/lastIdx bracket the columns that
  // actually carry a quantity; collapsing hides the all-zero columns outside
  // that bracket (mid-range zero sizes stay visible). Recomputed each render so
  // the visible range tracks the entered quantities live.
  const hasQty = grandQty > 0;
  let firstIdx = -1, lastIdx = -1;
  for (let i = 0; i < sizes.length; i++) {
    if ((colTotals[sizes[i]] || 0) > 0) { if (firstIdx < 0) firstIdx = i; lastIdx = i; }
  }
  const canCollapse = collapsibleSizes && hasQty && firstIdx >= 0 && (firstIdx > 0 || lastIdx < sizes.length - 1);
  const collapsedActive = collapsibleSizes && collapsed && firstIdx >= 0;
  const visibleSizes = collapsedActive ? sizes.slice(firstIdx, lastIdx + 1) : sizes;
  const canToggle = collapsibleSizes && (collapsedActive || canCollapse);
  const hiddenLeading = collapsedActive ? firstIdx : 0;
  const hiddenTrailing = collapsedActive ? sizes.length - 1 - lastIdx : 0;

  return (
    <div style={{ overflowX: "auto", background: C.headerBg, borderRadius: 8, border: `1px solid ${C.sectionBdr}` }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ background: C.headerBg }}>
            <th style={{ ...thBase, textAlign: "left" }}>Color</th>
            {showRise && <th style={{ ...thBase, textAlign: "left" }}>{riseLabel}</th>}
            {quickFill && <th style={{ ...thBase, textAlign: "center", minWidth: 64 }} title="Type a total here to auto-fill the sizes from the style's size scale">Qty</th>}
            {visibleSizes.map((sz, i) => {
              const isFirst = i === 0;
              const isLast = i === visibleSizes.length - 1;
              const green = collapsibleSizes && hasQty && isFirst;
              const clickable = isFirst && canToggle;
              return (
                <th
                  key={sz}
                  onClick={clickable ? () => setCollapsed((c) => !c) : undefined}
                  title={clickable
                    ? (collapsedActive ? "Show all size columns" : "Hide the empty size columns before/after the sizes with quantities")
                    : undefined}
                  style={{
                    ...thBase, textAlign: "center", minWidth: 56,
                    ...(green ? { color: C.green } : {}),
                    ...(clickable ? { cursor: "pointer", userSelect: "none" } : {}),
                  }}
                >
                  {collapsedActive && isFirst && hiddenLeading > 0 ? "⋯ " : ""}{sz}{collapsedActive && isLast && hiddenTrailing > 0 ? " ⋯" : ""}
                </th>
              );
            })}
            <th style={{ ...thBase, textAlign: "center" }}>Total</th>
            {unit?.each && (
              <th style={{ ...thBase, textAlign: "right", minWidth: 96, paddingRight: 6 }}>
                <div style={{ marginBottom: 4 }}>{unit.each.label}</div>
                {unit.each.onSetAll && (
                  <input
                    type="text"
                    inputMode="decimal"
                    value={bulkEach}
                    onChange={(e) => setBulkEach(e.target.value)}
                    onBlur={() => { const v = stampValue(bulkEach); if (v !== null) { unit.each!.onSetAll!(v); setBulkEach(v); } }}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); const v = stampValue(bulkEach); if (v !== null) { unit.each!.onSetAll!(v); setBulkEach(v); } } }}
                    placeholder={unit.each.placeholder || "set all"}
                    title="Type a per-each price and press Enter (or tab out) to stamp it onto every row; the pack price auto-fills."
                    style={{ ...unitInput, borderColor: C.primary }}
                  />
                )}
              </th>
            )}
            {unit && (
              // paddingRight matches the per-row unit cell (6px) so the "set all"
              // input lines up exactly under the per-row price inputs below it.
              <th style={{ ...thBase, textAlign: "right", minWidth: 110, paddingRight: 6 }}>
                <div style={{ marginBottom: 4 }}>{unit.label}</div>
                <input
                  type="text"
                  inputMode="decimal"
                  value={bulk}
                  onChange={(e) => setBulk(e.target.value)}
                  onBlur={() => { const v = stampValue(bulk); if (v !== null) { unit.onSetAll(v); setBulk(v); } }}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); const v = stampValue(bulk); if (v !== null) { unit.onSetAll(v); setBulk(v); } } }}
                  placeholder={unit.placeholder || "set all"}
                  title="Type a value and press Enter (or tab out) to stamp it onto every row, then edit individual rows as needed."
                  style={{ ...unitInput, borderColor: C.primary }}
                />
              </th>
            )}
            {unit?.showLineTotal && (
              <th style={{ ...thBase, textAlign: "right", minWidth: 96 }}>Total $</th>
            )}
            {lot && (
              <th style={{ ...thBase, textAlign: "left", minWidth: 120, paddingRight: 6 }}>
                <div style={{ marginBottom: 4 }}>{lot.label || "Lot"}</div>
                {lot.onSetAll && (
                  <input
                    type="text"
                    value={bulkLot}
                    onChange={(e) => setBulkLot(e.target.value)}
                    onBlur={() => { const v = bulkLot.trim(); if (v !== "") lot.onSetAll!(v); }}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); const v = bulkLot.trim(); if (v !== "") lot.onSetAll!(v); } }}
                    placeholder={lot.placeholder || "set all"}
                    title="Type a lot and press Enter (or tab out) to stamp it onto every row, then edit individual rows as needed."
                    style={{ ...unitInput, width: "16ch", textAlign: "left", fontSize: 12, borderColor: C.primary }}
                  />
                )}
              </th>
            )}
            {customerPo && (
              <th style={{ ...thBase, textAlign: "left", minWidth: 150, paddingRight: 6 }}>
                <div style={{ marginBottom: 4 }}>{customerPo.label || "Customer PO"}</div>
                {customerPo.onSetAll && (
                  <input
                    type="text"
                    value={bulkPo}
                    onChange={(e) => setBulkPo(e.target.value)}
                    onBlur={() => { const v = bulkPo.trim(); if (v !== "") customerPo.onSetAll!(v); }}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); const v = bulkPo.trim(); if (v !== "") customerPo.onSetAll!(v); } }}
                    placeholder={customerPo.placeholder || "set all"}
                    title="Type a Customer PO and press Enter to stamp it onto every color row; a row with a PO different from the header splits onto a new SO when you save."
                    style={{ ...unitInput, width: "16ch", textAlign: "left", fontSize: 12, borderColor: C.primary }}
                  />
                )}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => {
            const isLast = ri === rows.length - 1;
            let rowQty = 0;
            for (const sz of sizes) rowQty += qty[matrixCellKey(row.key, sz)] || 0;
            const rowUnit = unit ? parseMoney(unit.values[row.key] ?? "") : null;
            const rowExt = rowUnit != null ? rowQty * rowUnit : null;
            return (
              <tr key={row.key} style={{ borderBottom: isLast ? `2px solid ${C.sectionBdr}` : `1px solid ${C.rowBdr}` }}>
                <td style={{ padding: "6px 12px", color: "#D1D5DB", borderRight: `1px solid ${C.rowBdr}` }}>{row.color || "—"}</td>
                {showRise && (
                  <td style={{ padding: "6px 12px", color: "#C4B5FD", fontFamily: "monospace" }}>{row.rise || "—"}</td>
                )}
                {quickFill && (
                  <td style={{ padding: "4px 6px", textAlign: "center" }}>
                    <QuickFillCell
                      rowKey={row.key}
                      enabled={quickFill.enabledFor ? quickFill.enabledFor(row.key) : true}
                      disabledTitle={quickFill.disabledTitle}
                      onApply={quickFill.onApply}
                      initial={quickFill.valueFor ? quickFill.valueFor(row.key) : undefined}
                    />
                  </td>
                )}
                {visibleSizes.map((sz) => {
                  const k = matrixCellKey(row.key, sz);
                  const oh = onHand ? onHand[k] : undefined;
                  return (
                    <td key={sz} style={{ padding: "4px 6px", textAlign: "center" }}>
                      {oh != null && (
                        <div style={{ fontSize: 9, color: C.textMuted, lineHeight: 1, marginBottom: 2 }} title={onHandTitle}>{oh}</div>
                      )}
                      <QtyCell
                        rowKey={row.key}
                        size={sz}
                        color={row.color}
                        value={qty[k] || 0}
                        allowNegative={allowNegative}
                        onChange={onQtyChange}
                        onCommit={onCellCommit}
                      />
                    </td>
                  );
                })}
                <td style={{ padding: "6px 12px", textAlign: "center", color: rowQty ? C.amber : C.emptyCell, fontWeight: 700, fontFamily: "monospace" }}>
                  {rowQty || "—"}
                </td>
                {unit?.each && (
                  <td style={{ padding: "4px 6px", textAlign: "right" }}>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={unit.each.values[row.key] ?? ""}
                      onChange={(e) => unit.each!.onChange(row.key, e.target.value)}
                      onBlur={() => {
                        const n = parseMoney(unit.each!.values[row.key] ?? "");
                        if (n != null) unit.each!.onChange(row.key, n.toFixed(2));
                      }}
                      placeholder={unit.each.placeholder || "0.00"}
                      aria-label={`${unit.each.label} ${row.color || ""}`}
                      style={unitInput}
                    />
                  </td>
                )}
                {unit && (
                  <td style={{ padding: "4px 6px", textAlign: "right" }}>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={unit.values[row.key] ?? ""}
                      onChange={(e) => unit.onChange(row.key, e.target.value)}
                      onBlur={() => {
                        if (unit.forceDecimals == null) return;
                        const n = parseMoney(unit.values[row.key] ?? "");
                        if (n != null) unit.onChange(row.key, n.toFixed(unit.forceDecimals));
                      }}
                      placeholder={unit.placeholder || "0.00"}
                      aria-label={`${unit.label} ${row.color || ""}`}
                      style={unitInput}
                    />
                  </td>
                )}
                {unit?.showLineTotal && (
                  <td style={{ padding: "6px 12px", textAlign: "right", color: rowExt ? C.green : C.emptyCell, fontWeight: 700, fontFamily: "monospace" }}>
                    {rowExt ? `$${fmtMoney(rowExt)}` : "—"}
                  </td>
                )}
                {lot && (
                  <td style={{ padding: "4px 6px", textAlign: "left" }}>
                    <input
                      type="text"
                      value={lot.values[row.key] ?? ""}
                      onChange={(e) => lot.onChange(row.key, e.target.value)}
                      placeholder={lot.placeholder || "lot"}
                      aria-label={`Lot ${row.color || ""}`}
                      // #2 — slightly smaller font + a touch wider so a full
                      // lot/customer-PO number fits in the field without clipping.
                      style={{ ...unitInput, width: "16ch", textAlign: "left", fontSize: 12 }}
                    />
                  </td>
                )}
                {customerPo && (() => {
                  const val = customerPo.values[row.key] ?? "";
                  const hdr = customerPo.highlightWhenDiffersFrom;
                  const differs = hdr != null && val.trim() !== "" && val.trim() !== hdr.trim();
                  return (
                    <td style={{ padding: "4px 6px", textAlign: "left" }}>
                      <input
                        type="text"
                        value={val}
                        onChange={(e) => customerPo.onChange(row.key, e.target.value)}
                        placeholder={customerPo.placeholder || "PO #"}
                        aria-label={`Customer PO ${row.color || ""}`}
                        title={differs ? "Differs from the header PO — this color splits onto a new confirmed SO when you save." : undefined}
                        style={{ ...unitInput, width: "16ch", textAlign: "left", fontSize: 12, borderColor: differs ? C.amber : C.cardBdr }}
                      />
                    </td>
                  );
                })()}
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr style={{ borderTop: `2px solid ${C.sectionBdr}`, background: C.headerBg }}>
            <td colSpan={leadCols} style={{ padding: "10px 12px", color: C.desc, fontWeight: 700, textAlign: "left" }}>Grand Total</td>
            {quickFill && <td />}
            {visibleSizes.map((sz) => (
              <td key={sz} style={{ padding: "10px 12px", textAlign: "center", color: colTotals[sz] ? C.amber : C.emptyCell, fontWeight: 700, fontFamily: "monospace" }}>
                {colTotals[sz] || "—"}
              </td>
            ))}
            <td style={{ padding: "10px 12px", textAlign: "center", color: C.amber, fontWeight: 800, fontFamily: "monospace" }}>{grandQty || "—"}</td>
            {unit?.each && <td style={{ padding: "10px 12px" }} />}
            {unit && <td style={{ padding: "10px 12px" }} />}
            {unit?.showLineTotal && (
              <td style={{ padding: "10px 12px", textAlign: "right", color: grandExt ? C.green : C.emptyCell, fontWeight: 800, fontFamily: "monospace" }}>{grandExt ? `$${fmtMoney(grandExt)}` : "—"}</td>
            )}
            {lot && <td style={{ padding: "10px 12px" }} />}
            {customerPo && <td style={{ padding: "10px 12px" }} />}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export default EditableSizeMatrix;
