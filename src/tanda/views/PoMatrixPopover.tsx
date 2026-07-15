// Small matrix popover shown on right-click of a PO number in the
// PO WIP grid. Mirrors the layout of detail/poMatrixTab.tsx in a
// compact form so a planner can sanity-check size / qty break
// without leaving the grid view. Read-only, dismisses on outside
// click or Escape.

import React, { useEffect, useRef, useState } from "react";
import { itemQty, isLineClosed, normalizeSize, sizeSort, type XoroPO } from "../../utils/tandaTypes";
import { extractPpk } from "../../shared/prepack";
import { computeSizeCollapse } from "../../shared/matrix";

export interface PoMatrixPopoverProps {
  po: XoroPO;
  // Anchor position in viewport coords (event.clientX / clientY at right-click).
  // The popover positions itself near this point and clamps to viewport edges.
  x: number;
  y: number;
  onClose: () => void;
  // EXPLODE PPK preference is shared with the detail-tab matrix via
  // the same localStorage key. The popover reads it once at open.
  explodePpk: boolean;
}

const EXPLODE_KEY = "tanda_matrix_explode_ppk";

function readExplode(): boolean {
  try { return localStorage.getItem(EXPLODE_KEY) !== "false"; } catch { return true; }
}

function rowExplodedTotal(sizes: Record<string, number>): number {
  let total = 0;
  for (const [sz, qty] of Object.entries(sizes)) {
    const mult = extractPpk(sz) ?? 1;
    total += (qty as number) * mult;
  }
  return total;
}

export function PoMatrixPopover({ po, x, y, onClose }: PoMatrixPopoverProps): React.ReactElement | null {
  const ref = useRef<HTMLDivElement | null>(null);
  const explodePpk = readExplode();
  // Empty-size-column collapse — same SO/PO model (green first header, click to
  // hide the all-zero leading/trailing size columns).
  const [sizesCollapsed, setSizesCollapsed] = useState(false);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const items = po.Items ?? po.PoLineArr ?? [];
  if (items.length === 0) {
    return (
      <FloatingShell ref={ref} x={x} y={y}>
        <div style={hdrStyle}>{po.PoNumber} · matrix</div>
        <div style={{ padding: "10px 14px", color: "#6B7280", fontSize: 11 }}>No line items on this PO.</div>
      </FloatingShell>
    );
  }

  const parsed = items.map((item: any) => {
    const sku = item.ItemNumber ?? "";
    const parts = sku.split("-");
    const color = parts.length === 4 ? `${parts[1]}-${parts[2]}` : (parts.length >= 2 ? parts[1] : "");
    const sz = normalizeSize(parts.length === 4 ? parts[3] : parts.length >= 3 ? parts.slice(2).join("-") : "");
    const closed = isLineClosed(item);
    const displayQty = closed ? (item.QtyOrder ?? 0) : itemQty(item);
    return { base: parts[0] || sku, color, size: sz, qty: displayQty, closed };
  });

  const sizeSet = new Set<string>();
  parsed.forEach((p) => { if (p.size) sizeSet.add(p.size); });
  const sizeOrder = [...sizeSet].sort(sizeSort);

  const bases: string[] = [];
  const byBase: Record<string, { color: string; sizes: Record<string, number>; closed: boolean }[]> = {};
  parsed.forEach((p) => {
    if (!byBase[p.base]) { byBase[p.base] = []; bases.push(p.base); }
    let row = byBase[p.base].find((r) => r.color === p.color && r.closed === p.closed);
    if (!row) { row = { color: p.color, sizes: {}, closed: p.closed }; byBase[p.base].push(row); }
    row.sizes[p.size] = (row.sizes[p.size] || 0) + p.qty;
  });

  // Green-collapse model: per-size totals across every rendered row so a column
  // with any visible qty is kept; only empty leading/trailing columns collapse.
  const colTotals: Record<string, number> = {};
  for (const sz of sizeOrder) colTotals[sz] = 0;
  for (const base of bases) for (const row of byBase[base]) for (const sz of sizeOrder) colTotals[sz] += row.sizes[sz] || 0;
  const sizeCollapse = computeSizeCollapse(sizeOrder, colTotals, { enabled: true, collapsed: sizesCollapsed });
  const visibleSizes = sizeCollapse.visibleSizes;

  const totalPacks = parsed.reduce((s, p) => s + (p.closed ? 0 : (p.qty ?? 0)), 0);
  const totalUnits = parsed.reduce((s, p) => {
    if (p.closed) return s;
    const mult = extractPpk(p.size) ?? 1;
    return s + (p.qty ?? 0) * mult;
  }, 0);
  const totalIsPrepack = totalUnits !== totalPacks;
  const totalDisplay = explodePpk ? totalUnits : totalPacks;

  return (
    <FloatingShell ref={ref} x={x} y={y}>
      <div style={hdrStyle}>
        <span style={{ color: "#60A5FA", fontFamily: "monospace", fontWeight: 700 }}>{po.PoNumber}</span>
        <span style={{ color: "#94A3B8", marginLeft: 8, fontWeight: 600 }}>· {po.VendorName ?? "—"}</span>
        <span style={{ color: "#6B7280", marginLeft: "auto", fontSize: 10, display: "inline-flex", flexDirection: "column", alignItems: "flex-end", lineHeight: 1.2 }}>
          <span>{bases.length} line{bases.length !== 1 ? "s" : ""} · {sizeOrder.length} size{sizeOrder.length !== 1 ? "s" : ""}</span>
          <span style={{ color: "#9CA3AF", fontFamily: "monospace" }}>
            Units: {totalDisplay.toLocaleString()}
            {totalIsPrepack && (
              <span style={{ color: "#4B5563", marginLeft: 4 }}>
                ({explodePpk ? `${totalPacks.toLocaleString()}p` : `= ${totalUnits.toLocaleString()}u`})
              </span>
            )}
          </span>
        </span>
      </div>
      <div style={{ overflow: "auto", maxHeight: "60vh" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
          <thead>
            <tr style={{ background: "#0F172A" }}>
              <th style={thStyle}>Base</th>
              <th style={thStyle}>Color</th>
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
                    style={{ ...thStyle, textAlign: "center", minWidth: 44, ...(green ? { color: "#10B981" } : {}), ...(clickable ? { cursor: "pointer", userSelect: "none" } : {}) }}
                  >
                    {sizeCollapse.collapsedActive && isFirst && sizeCollapse.hiddenLeading > 0 ? "⋯ " : ""}{sz}{sizeCollapse.collapsedActive && isLast && sizeCollapse.hiddenTrailing > 0 ? " ⋯" : ""}
                  </th>
                );
              })}
              <th style={{ ...thStyle, textAlign: "center" }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {bases.map((base) => byBase[base].map((row, ri) => {
              const rowTotalPacks = Object.values(row.sizes).reduce((s, q) => s + q, 0);
              const rowTotalUnits = rowExplodedTotal(row.sizes);
              const rowIsPrepack = rowTotalUnits !== rowTotalPacks;
              const dim = row.closed ? { opacity: 0.55, textDecoration: "line-through" as const } : {};
              return (
                <tr key={`${base}-${row.color}-${ri}-${row.closed ? "c" : "o"}`} style={{ borderBottom: "1px solid #1E293B" }}>
                  <td style={{ ...tdStyle, color: "#60A5FA", fontFamily: "monospace", fontWeight: 700, ...dim }}>{base}</td>
                  <td style={{ ...tdStyle, color: "#D1D5DB", ...dim }}>{row.color || "—"}</td>
                  {visibleSizes.map((sz) => (
                    <td key={sz} style={{ ...tdStyle, textAlign: "center", color: row.sizes[sz] ? "#E5E7EB" : "#334155", fontFamily: "monospace", ...dim }}>
                      {row.sizes[sz] || "—"}
                    </td>
                  ))}
                  <td style={{ ...tdStyle, textAlign: "center", color: "#F59E0B", fontFamily: "monospace", fontWeight: 700, ...dim }}>
                    {(explodePpk ? rowTotalUnits : rowTotalPacks).toLocaleString()}
                    {rowIsPrepack && (
                      <div style={{ color: "#6B7280", fontSize: 9, fontWeight: 400, marginTop: 1 }}>
                        {explodePpk ? `${rowTotalPacks.toLocaleString()}p` : `= ${rowTotalUnits.toLocaleString()}u`}
                      </div>
                    )}
                  </td>
                </tr>
              );
            }))}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: "2px solid #334155", background: "#0F172A" }}>
              <td colSpan={2} style={{ ...tdStyle, color: "#9CA3AF", fontWeight: 700, textAlign: "right" }}>Grand Total</td>
              {visibleSizes.map((sz) => {
                const colTotal = parsed.filter((p) => p.size === sz && !p.closed).reduce((s, p) => s + (p.qty ?? 0), 0);
                return <td key={sz} style={{ ...tdStyle, textAlign: "center", color: "#F59E0B", fontWeight: 700, fontFamily: "monospace" }}>{colTotal || "—"}</td>;
              })}
              <td style={{ ...tdStyle, textAlign: "center", color: "#F59E0B", fontWeight: 700, fontFamily: "monospace" }}>
                {totalDisplay.toLocaleString()}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div style={{ padding: "6px 10px", color: "#4B5563", fontSize: 9, textAlign: "right", borderTop: "1px solid #1E293B" }}>
        Right-click to dismiss · click PO# for full detail
      </div>
    </FloatingShell>
  );
}

// Floating container that clamps to viewport edges so the popover
// stays visible regardless of where the right-click happened.
const FloatingShell = React.forwardRef<HTMLDivElement, { x: number; y: number; children: React.ReactNode }>(
  function FloatingShell({ x, y, children }, ref) {
    // Clamp position so the popover (estimated 720x420) doesn't fall
    // off-screen. Refines once mounted via the ref's actual size.
    const W_EST = 720;
    const H_EST = 420;
    const left = Math.min(x + 4, window.innerWidth - W_EST - 8);
    const top = Math.min(y + 4, window.innerHeight - H_EST - 8);
    return (
      <div
        ref={ref}
        onContextMenu={(e) => { e.preventDefault(); }}
        style={{
          position: "fixed",
          left: Math.max(8, left),
          top: Math.max(8, top),
          zIndex: 1100,
          background: "#0F172A",
          border: "1px solid #334155",
          borderRadius: 8,
          boxShadow: "0 12px 32px rgba(0,0,0,0.55)",
          minWidth: 360,
          maxWidth: "min(90vw, 900px)",
          maxHeight: "80vh",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {children}
      </div>
    );
  },
);

const hdrStyle: React.CSSProperties = {
  padding: "8px 12px",
  display: "flex",
  alignItems: "center",
  background: "#0B1220",
  borderBottom: "1px solid #1E293B",
  fontSize: 12,
};

const thStyle: React.CSSProperties = {
  padding: "6px 8px",
  textAlign: "left",
  color: "#6B7280",
  fontSize: 9,
  textTransform: "uppercase",
  letterSpacing: 1,
  borderBottom: "1px solid #334155",
  position: "sticky",
  top: 0,
  background: "#0F172A",
  zIndex: 1,
};

const tdStyle: React.CSSProperties = {
  padding: "5px 8px",
  whiteSpace: "nowrap",
};
