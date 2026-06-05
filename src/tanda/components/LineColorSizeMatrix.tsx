// src/tanda/components/LineColorSizeMatrix.tsx
//
// Read-only color × size matrix for document line items (RMA returns, AR/AP
// invoices). Unlike the PO matrix (src/shared/poMatrix.ts) — which parses a
// Xoro ItemNumber string — these documents store only an opaque
// inventory_item_id per line. The caller resolves each line's id to the SKU's
// {color, size} (via /api/internal/items?ids=…) and feeds the resolved entries
// here.
//
// Rows = color, columns = size, cells = summed qty, with a totals row and
// column. Entries that can't be resolved to BOTH a color and a size (e.g. AP
// expense lines, or items missing color/size) are NOT passed here — the caller
// renders them in a small "non-matrix lines" list so nothing is dropped.

import { sizeSort } from "../../utils/tandaTypes";

export type MatrixEntry = {
  color: string;
  size: string;
  qty: number;
};

const C = {
  card: "#1E293B",
  cardBdr: "#334155",
  text: "#F1F5F9",
  textMuted: "#94A3B8",
  amber: "#F59E0B",
  bg: "#0b1220",
};

const th: React.CSSProperties = {
  background: C.bg, color: C.textMuted, fontSize: 11, fontWeight: 600,
  padding: "7px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  textTransform: "uppercase", letterSpacing: 0.5, whiteSpace: "nowrap",
};
const td: React.CSSProperties = {
  padding: "6px 10px", borderBottom: `1px solid ${C.cardBdr}`,
  color: C.text, fontSize: 13,
};

export default function LineColorSizeMatrix({ entries }: { entries: MatrixEntry[] }) {
  if (!entries || entries.length === 0) {
    return (
      <div style={{ padding: 16, textAlign: "center", color: C.textMuted, fontSize: 13 }}>
        No line items resolve to a color × size grid.
      </div>
    );
  }

  // Distinct, sorted size columns (numeric asc, then alpha scale) + color rows.
  const sizeSet = new Set<string>();
  const colorSet = new Set<string>();
  // color → size → summed qty
  const grid: Record<string, Record<string, number>> = {};
  for (const e of entries) {
    const color = e.color || "—";
    const size = e.size || "—";
    sizeSet.add(size);
    colorSet.add(color);
    if (!grid[color]) grid[color] = {};
    grid[color][size] = (grid[color][size] || 0) + (e.qty || 0);
  }
  const sizes = [...sizeSet].sort(sizeSort);
  const colors = [...colorSet].sort((a, b) => a.localeCompare(b));

  const colTotals: Record<string, number> = {};
  let grandTotal = 0;
  for (const color of colors) {
    for (const size of sizes) {
      const v = grid[color][size] || 0;
      colTotals[size] = (colTotals[size] || 0) + v;
      grandTotal += v;
    }
  }

  return (
    <div style={{ background: C.card, border: `1px solid ${C.cardBdr}`, borderRadius: 8, overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={{ ...th, textAlign: "left" }}>Color</th>
            {sizes.map((sz) => (
              <th key={sz} style={{ ...th, textAlign: "center", minWidth: 52 }}>{sz}</th>
            ))}
            <th style={{ ...th, textAlign: "center" }}>Total</th>
          </tr>
        </thead>
        <tbody>
          {colors.map((color) => {
            const rowTotal = sizes.reduce((s, sz) => s + (grid[color][sz] || 0), 0);
            return (
              <tr key={color}>
                <td style={{ ...td, color: C.textMuted }}>{color}</td>
                {sizes.map((sz) => {
                  const v = grid[color][sz] || 0;
                  return (
                    <td key={sz} style={{ ...td, textAlign: "center", fontFamily: "SFMono-Regular, Menlo, monospace", color: v ? C.text : C.cardBdr }}>
                      {v ? v.toLocaleString() : "—"}
                    </td>
                  );
                })}
                <td style={{ ...td, textAlign: "center", color: C.amber, fontWeight: 700, fontFamily: "SFMono-Regular, Menlo, monospace" }}>
                  {rowTotal.toLocaleString()}
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr style={{ background: C.bg }}>
            <td style={{ ...td, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", fontSize: 11, letterSpacing: 0.5 }}>Total</td>
            {sizes.map((sz) => (
              <td key={sz} style={{ ...td, textAlign: "center", color: C.amber, fontWeight: 700, fontFamily: "SFMono-Regular, Menlo, monospace" }}>
                {colTotals[sz] ? colTotals[sz].toLocaleString() : "—"}
              </td>
            ))}
            <td style={{ ...td, textAlign: "center", color: C.amber, fontWeight: 800, fontFamily: "SFMono-Regular, Menlo, monospace" }}>
              {grandTotal.toLocaleString()}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
