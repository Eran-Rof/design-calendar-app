// VendorPoMatrix — the PO's line items rendered as a size matrix (base part +
// color rows × size columns), mirroring the Tanda PO "Item Matrix" tab. Shares
// the exact transform via src/shared/poMatrix.ts; styled in the vendor theme.
//
// Pack-grain totals (sum of the size cells) — Xoro UnitPrice is per-pack, so
// "Total cost" = pack total × unit price. Prepack rows surface their pack token
// (e.g. PPK24) as its own size column.

import { useState } from "react";
import { TH } from "../theme";
import { fmtMoney, fmtMoney2 } from "../utils";
import { buildPoMatrix } from "../../shared/poMatrix";
import { computeSizeCollapse } from "../../shared/matrix";

const AMBER = "#F59E0B"; // total-qty highlight, matches the Tanda matrix
const GREEN = "#34D399"; // cost highlight
const COLLAPSE_GREEN = "#10B981"; // green first-size header (matches the SO grid)

export default function VendorPoMatrix({ items }: { items: any[] }) {
  const { bases, byBase, sizeOrder, parsed } = buildPoMatrix(items);
  // Empty-size-column collapse — same SO/PO model: first size header with qty
  // turns green + is clickable to hide the all-zero leading/trailing columns.
  const [sizesCollapsed, setSizesCollapsed] = useState(false);
  const colTotals: Record<string, number> = {};
  for (const sz of sizeOrder) colTotals[sz] = 0;
  for (const base of bases) for (const row of byBase[base]) for (const sz of sizeOrder) colTotals[sz] += row.sizes[sz] || 0;
  const sizeCollapse = computeSizeCollapse(sizeOrder, colTotals, { enabled: true, collapsed: sizesCollapsed });
  const visibleSizes = sizeCollapse.visibleSizes;

  if (bases.length === 0) {
    return (
      <div style={{ padding: 20, textAlign: "center", color: TH.textMuted, fontSize: 13 }}>
        No line items on this PO.
      </div>
    );
  }

  const th: React.CSSProperties = { padding: "10px 14px", color: TH.textSub2, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, borderBottom: `2px solid ${TH.border}`, fontWeight: 700, whiteSpace: "nowrap" };
  const td: React.CSSProperties = { padding: "8px 14px", fontSize: 13 };

  // Grand totals (open lines only — closed lines excluded, matching Tanda).
  let grandQty = 0;
  let grandCost = 0;

  return (
    <div style={{ background: TH.surface, border: `1px solid ${TH.border}`, borderRadius: 8, overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr>
            <th style={{ ...th, textAlign: "left" }}>Base Part</th>
            <th style={{ ...th, textAlign: "left" }}>Description</th>
            <th style={{ ...th, textAlign: "left" }}>Color</th>
            {visibleSizes.map((sz, i) => {
              const isFirst = i === 0;
              const isLast = i === visibleSizes.length - 1;
              const green = sizeCollapse.hasQty && isFirst;
              const clickable = isFirst && sizeCollapse.canToggle;
              return (
                <th
                  key={sz}
                  onClick={clickable ? () => setSizesCollapsed((c) => !c) : undefined}
                  title={clickable
                    ? (sizeCollapse.collapsedActive ? "Show all size columns" : "Hide the empty size columns before/after the sizes with quantities")
                    : undefined}
                  style={{ ...th, textAlign: "center", minWidth: 56, ...(green ? { color: COLLAPSE_GREEN } : {}), ...(clickable ? { cursor: "pointer", userSelect: "none" } : {}) }}
                >
                  {sizeCollapse.collapsedActive && isFirst && sizeCollapse.hiddenLeading > 0 ? "⋯ " : ""}{sz}{sizeCollapse.collapsedActive && isLast && sizeCollapse.hiddenTrailing > 0 ? " ⋯" : ""}
                </th>
              );
            })}
            <th style={{ ...th, textAlign: "center" }}>Total</th>
            <th style={{ ...th, textAlign: "right" }}>Avg Cost</th>
            <th style={{ ...th, textAlign: "right" }}>Total Cost</th>
          </tr>
        </thead>
        <tbody>
          {bases.map((base, bi) => {
            const rows = byBase[base];
            return rows.map((row, ri) => {
              const rowTotal = Object.values(row.sizes).reduce((s, q) => s + q, 0);
              const rowCost = rowTotal * row.price;
              if (!row.closed) { grandQty += rowTotal; grandCost += rowCost; }
              const isLast = ri === rows.length - 1;
              const dim = row.closed ? { opacity: 0.55, textDecoration: "line-through" as const } : {};
              return (
                <tr key={base + "-" + row.color + "-" + ri} style={{ borderBottom: isLast && bi < bases.length - 1 ? `2px solid ${TH.border}` : `1px solid ${TH.bg}`, background: row.closed ? "#1E1B1B" : undefined }}>
                  <td style={{ ...td, color: TH.primaryLt, fontFamily: "monospace", fontWeight: 700, borderRight: `1px solid ${TH.border}`, ...dim }}>{base}</td>
                  <td style={{ ...td, color: TH.textSub2, fontSize: 12, ...dim }}>{row.desc || "—"}</td>
                  <td style={{ ...td, color: TH.textSub }}>
                    <span style={dim}>{row.color || "—"}</span>
                    {row.closed && <span style={{ marginLeft: 8, padding: "2px 6px", borderRadius: 4, background: "#7F1D1D", color: "#FCA5A5", fontSize: 10, fontWeight: 700, letterSpacing: 0.5 }}>CLOSED</span>}
                  </td>
                  {visibleSizes.map((sz) => (
                    <td key={sz} style={{ ...td, textAlign: "center", fontFamily: "monospace", color: row.sizes[sz] ? TH.text : TH.border, ...dim }}>
                      {row.sizes[sz] ? row.sizes[sz].toLocaleString() : "—"}
                    </td>
                  ))}
                  <td style={{ ...td, textAlign: "center", color: AMBER, fontWeight: 700, fontFamily: "monospace", ...dim }}>{rowTotal.toLocaleString()}</td>
                  <td style={{ ...td, textAlign: "right", color: TH.textSub, fontFamily: "monospace", ...dim }}>{row.price ? fmtMoney2(row.price) : "—"}</td>
                  <td style={{ ...td, textAlign: "right", color: GREEN, fontWeight: 600, fontFamily: "monospace", ...dim }}>{rowCost ? fmtMoney2(rowCost) : "—"}</td>
                </tr>
              );
            });
          })}
        </tbody>
        <tfoot>
          <tr style={{ borderTop: `2px solid ${TH.border}`, background: TH.surfaceHi }}>
            <td colSpan={3} style={{ padding: "12px 14px", color: TH.textSub, fontWeight: 700, textAlign: "right" }}>Grand Total</td>
            {visibleSizes.map((sz) => {
              const colTotal = parsed.filter((p) => p.size === sz && !p.closed).reduce((s, p) => s + p.qty, 0);
              return <td key={sz} style={{ padding: "12px 14px", textAlign: "center", color: AMBER, fontWeight: 700, fontFamily: "monospace" }}>{colTotal ? colTotal.toLocaleString() : "—"}</td>;
            })}
            <td style={{ padding: "12px 14px", textAlign: "center", color: AMBER, fontWeight: 800, fontFamily: "monospace" }}>{grandQty.toLocaleString()}</td>
            <td style={{ padding: "12px 14px" }} />
            <td style={{ padding: "12px 14px", textAlign: "right", color: GREEN, fontWeight: 800, fontFamily: "monospace" }}>{fmtMoney(grandCost)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
