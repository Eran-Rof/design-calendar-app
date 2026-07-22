// src/tanda/components/InvoiceMatrixBody.tsx
//
// Shared invoice/bill BODY renderer — the size-matrix body used by the AR
// Invoices row expander, the AP Invoices bill body, and the Inventory Snapshot
// Sold/Purchased drill's full invoice/bill popup. Fed the built model from
// buildInvoiceMatrixBody, it renders a stack of per-style color × size grids
// (style code in blue + style name + a shared-inseam chip, color rows, per-size
// qty cells, unit money, per-row + per-style totals) with the same green
// first-size-header empty-column collapse as the PO/SO grids, plus a flat
// "Other lines" table for amount-only / non-sized lines. One component, many
// mounts — AR passes moneyLabel "Unit $", AP passes "Unit Cost $".

import { useState } from "react";
import { computeSizeCollapse, MatrixTotalsToggle, useHideEmptySizes, useTotalsOnly } from "../../shared/matrix";
import type { InvoiceMatrixModel } from "../lib/invoiceMatrixBody";

const C = {
  bg: "#0b1220", card: "#1E293B", cardBdr: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textSub: "#CBD5E1",
  primary: "#3B82F6", success: "#10B981", warn: "#F59E0B", danger: "#EF4444",
};

/** cents → "$1,234.56" (BigInt-free; inputs are already small integer cents). */
function fmtCents(c: number): string {
  const neg = c < 0;
  const abs = Math.abs(Math.round(c));
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (abs % 100).toString().padStart(2, "0");
  return `${neg ? "-" : ""}$${whole}.${frac}`;
}

export type InvoiceMatrixHeaderField = { label: string; value: string };

const th: React.CSSProperties = {
  background: C.bg, color: C.textMuted, fontSize: 11, fontWeight: 600, textAlign: "left",
  padding: "8px 10px", borderBottom: `1px solid ${C.cardBdr}`, textTransform: "uppercase", letterSpacing: 0.5,
};
const td: React.CSSProperties = { padding: "6px 10px", color: C.text, fontSize: 12 };
const chip: React.CSSProperties = {
  fontSize: 11, color: C.textSub, background: C.bg, border: `1px solid ${C.cardBdr}`,
  borderRadius: 4, padding: "1px 7px", fontFamily: "SFMono-Regular, Menlo, monospace",
};

export default function InvoiceMatrixBody({
  model, moneyLabel = "Unit $", header, title = "Line detail", emptyLabel = "No lines on this document.",
}: {
  model: InvoiceMatrixModel;
  /** Money-column label — "Unit $" for AR (price), "Unit Cost $" for AP (cost). */
  moneyLabel?: string;
  /** Optional header meta chips (vendor/customer, bill #, dates, PO, total). */
  header?: InvoiceMatrixHeaderField[];
  title?: string;
  emptyLabel?: string;
}) {
  const { styles, flat } = model;
  // Empty-size-column collapse, per style block (keyed by style code) — same
  // green first-size-header behavior as the SO/PO grids + Inventory Matrix. Each
  // block's Set membership is an OVERRIDE on top of the shared default (DEFAULTS
  // ON), so a block's green-header click flips only that block yet the default
  // follows the shared, persisted cross-surface pref.
  const [hideEmptyDefault] = useHideEmptySizes();
  const [totalsOnly] = useTotalsOnly();
  const [collapsedStyles, setCollapsedStyles] = useState<Set<string>>(new Set());
  const toggleCollapsedStyle = (style: string) =>
    setCollapsedStyles((prev) => { const n = new Set(prev); n.has(style) ? n.delete(style) : n.add(style); return n; });
  const styleCollapsedFor = (style: string) => (collapsedStyles.has(style) ? !hideEmptyDefault : hideEmptyDefault);

  if (styles.length === 0 && flat.length === 0) {
    return <div style={{ padding: "10px 14px", color: C.textMuted, fontSize: 12 }}>{emptyLabel}</div>;
  }

  return (
    <div style={{ padding: "10px 14px 14px", display: "flex", flexDirection: "column", gap: 14 }}>
      {(title || styles.length > 0) && (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {title && <span style={{ color: C.textMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 1, fontWeight: 700 }}>{title}</span>}
          {styles.length > 0 && <MatrixTotalsToggle style={{ marginLeft: "auto" }} />}
        </div>
      )}

      {header && header.length > 0 && (
        <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
          {header.map((f, i) => (
            <div key={i} style={{ fontSize: 12, color: C.text }}>
              <div style={{ fontSize: 10, color: C.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>{f.label}</div>
              <div>{f.value || "—"}</div>
            </div>
          ))}
        </div>
      )}

      {styles.map((st) => {
        const sizes = st.sizes;
        const colTotals: Record<string, number> = {};
        for (const sz of sizes) colTotals[sz] = 0;
        for (const cm of st.colors.values()) for (const [sz, cell] of cm) colTotals[sz] += cell.qty;
        const sizeCollapse = computeSizeCollapse(sizes, colTotals, { enabled: true, collapsed: styleCollapsedFor(st.styleCode) });
        const vSizes = totalsOnly ? [] : sizeCollapse.visibleSizes;
        let styleQty = 0, styleExt = 0;
        for (const cm of st.colors.values()) for (const cell of cm.values()) { styleQty += cell.qty; styleExt += cell.extCents; }
        return (
          <div key={st.styleCode} style={{ border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden", background: C.bg }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, padding: "6px 10px", background: C.card, flexWrap: "wrap" }}>
              <span style={{ color: C.primary, fontFamily: "monospace", fontWeight: 700 }}>{st.styleCode}</span>
              {st.styleName && <span style={{ color: C.textSub, fontSize: 12 }}>{st.styleName}</span>}
              {st.inseam && <span style={chip}>Inseam {st.inseam}&quot;</span>}
              {st.poNumbers.length > 0 && (
                <span style={{ ...chip, color: C.textMuted }}>PO {st.poNumbers.join(", ")}</span>
              )}
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead><tr>
                  <th style={th}>Color</th>
                  {vSizes.map((sz, i) => {
                    const isFirst = i === 0;
                    const isLast = i === vSizes.length - 1;
                    const green = sizeCollapse.hasQty && isFirst;
                    const clickable = isFirst && sizeCollapse.canToggle;
                    return (
                      <th
                        key={sz}
                        onClick={clickable ? () => toggleCollapsedStyle(st.styleCode) : undefined}
                        title={clickable
                          ? (sizeCollapse.collapsedActive ? "Show all size columns" : "Hide the empty size columns before/after the sizes with quantities")
                          : undefined}
                        style={{ ...th, textAlign: "center", ...(green ? { color: C.success } : {}), ...(clickable ? { cursor: "pointer", userSelect: "none" } : {}) }}
                      >
                        {sizeCollapse.collapsedActive && isFirst && sizeCollapse.hiddenLeading > 0 ? "⋯ " : ""}{sz}{sizeCollapse.collapsedActive && isLast && sizeCollapse.hiddenTrailing > 0 ? " ⋯" : ""}
                      </th>
                    );
                  })}
                  <th style={{ ...th, textAlign: "center" }}>Qty</th>
                  <th style={{ ...th, textAlign: "right" }}>{moneyLabel}</th>
                  <th style={{ ...th, textAlign: "right" }}>Ext $</th>
                </tr></thead>
                <tbody>
                  {[...st.colors.entries()].map(([color, cm]) => {
                    let rowQty = 0, rowExt = 0;
                    for (const cell of cm.values()) { rowQty += cell.qty; rowExt += cell.extCents; }
                    const avgUnit = rowQty > 0 ? rowExt / rowQty : 0;
                    return (
                      <tr key={color} style={{ borderTop: `1px solid ${C.cardBdr}` }}>
                        <td style={td}>{color}</td>
                        {vSizes.map((sz) => {
                          const cell = cm.get(sz);
                          return <td key={sz} style={{ ...td, textAlign: "center", fontFamily: "monospace", color: cell?.qty ? C.text : C.cardBdr }}>{cell?.qty ? cell.qty.toLocaleString() : "—"}</td>;
                        })}
                        <td style={{ ...td, textAlign: "center", fontFamily: "monospace", color: C.warn, fontWeight: 700 }}>{rowQty.toLocaleString()}</td>
                        <td style={{ ...td, textAlign: "right", fontFamily: "monospace", color: C.textSub }}>{fmtCents(Math.round(avgUnit))}</td>
                        <td style={{ ...td, textAlign: "right", fontFamily: "monospace", color: C.success, fontWeight: 600 }}>{fmtCents(Math.round(rowExt))}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: `2px solid ${C.cardBdr}` }}>
                    <td style={{ ...td, color: C.textMuted, fontWeight: 700 }} colSpan={vSizes.length + 1}>Style total</td>
                    <td style={{ ...td, textAlign: "center", fontFamily: "monospace", color: C.warn, fontWeight: 800 }}>{styleQty.toLocaleString()}</td>
                    <td style={td} />
                    <td style={{ ...td, textAlign: "right", fontFamily: "monospace", color: C.success, fontWeight: 800 }}>{fmtCents(Math.round(styleExt))}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        );
      })}

      {/* Amount-only / unresolved lines — freight, fees, expense lines, non-apparel
          SKUs, or SKUs with no per-size resolution. Shown as a plain list. */}
      {flat.length > 0 && (
        <div style={{ border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflow: "hidden", background: C.bg }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, padding: "6px 10px", background: C.card }}>
            <span style={{ color: C.warn, fontWeight: 700, fontSize: 12 }}>Other lines</span>
            <span style={{ color: C.textMuted, fontSize: 11 }}>amount-only charges / lines with no per-size SKU</span>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead><tr>
                <th style={th}>Description</th>
                <th style={{ ...th, textAlign: "center" }}>Qty</th>
                <th style={{ ...th, textAlign: "right" }}>{moneyLabel}</th>
                <th style={{ ...th, textAlign: "right" }}>Ext $</th>
              </tr></thead>
              <tbody>
                {flat.map((l, i) => (
                  <tr key={i} style={{ borderTop: `1px solid ${C.cardBdr}` }}>
                    <td style={td}>{l.label}</td>
                    <td style={{ ...td, textAlign: "center", fontFamily: "monospace", color: l.qty != null ? C.warn : C.textMuted, fontWeight: 700 }}>{l.qty != null ? l.qty.toLocaleString() : "—"}</td>
                    <td style={{ ...td, textAlign: "right", fontFamily: "monospace", color: C.textSub }}>{l.unitCents != null ? fmtCents(l.unitCents) : "—"}</td>
                    <td style={{ ...td, textAlign: "right", fontFamily: "monospace", color: C.success, fontWeight: 600 }}>{fmtCents(l.extCents)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: `2px solid ${C.cardBdr}` }}>
                  <td style={{ ...td, color: C.textMuted, fontWeight: 700 }} colSpan={3}>Total</td>
                  <td style={{ ...td, textAlign: "right", fontFamily: "monospace", color: C.success, fontWeight: 800 }}>{fmtCents(flat.reduce((s, l) => s + l.extCents, 0))}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
