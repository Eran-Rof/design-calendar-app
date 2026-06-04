// Shared fused-tab button style for the Costing views.
//
// Modeled verbatim on the Tanda PO-detail tab strip (src/tanda/detailPanel.tsx):
// the active tab merges into the panel below it — it drops its bottom border and
// overlaps the card by -1px so the two read as one connected surface.
import type { CSSProperties } from "react";

export function tabStyle(active: boolean): CSSProperties {
  return {
    flex: 1, padding: "11px 18px", fontSize: 14, cursor: "pointer", fontWeight: 700,
    fontFamily: "inherit",
    border: "1px solid #334155", borderBottom: active ? "none" : "1px solid #334155",
    background: active ? "#1E293B" : "#0F172A",
    color: active ? "#60A5FA" : "#6B7280",
    borderRadius: "10px 10px 0 0",
    marginBottom: active ? -1 : 0,
    position: "relative", zIndex: active ? 1 : 0,
  };
}
