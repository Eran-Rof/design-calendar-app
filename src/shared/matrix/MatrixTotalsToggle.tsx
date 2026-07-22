// src/shared/matrix/MatrixTotalsToggle.tsx
//
// Compact "Totals only" toggle chip, wired to the shared `useTotalsOnly` pref so
// one click flips every size-matrix on the page to per-colorway totals (and back)
// and the choice follows the operator across surfaces. House style: dark chip,
// functional ✓ glyph (no emoji), blue when active. Drop it in any matrix header.

import React from "react";
import { useTotalsOnly } from "./matrixPrefs";

export function MatrixTotalsToggle({ style, size = "sm" }: { style?: React.CSSProperties; size?: "sm" | "md" }): React.ReactElement {
  const [totalsOnly, setTotalsOnly] = useTotalsOnly();
  const fs = size === "md" ? 11 : 10;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); setTotalsOnly((v) => !v); }}
      title={totalsOnly
        ? "Showing per-colorway totals only. Click to show the full size grid."
        : "Hide the size grid and show per-colorway totals only."}
      style={{
        display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer",
        padding: "3px 8px", borderRadius: 6, whiteSpace: "nowrap", userSelect: "none",
        border: `1px solid ${totalsOnly ? "#3B82F6" : "#334155"}`,
        background: totalsOnly ? "rgba(59,130,246,0.12)" : "transparent",
        color: totalsOnly ? "#93C5FD" : "#9CA3AF",
        fontSize: fs, fontWeight: totalsOnly ? 700 : 400,
        ...style,
      }}
    >
      <span style={{ width: 10, textAlign: "center", color: "#3B82F6" }}>{totalsOnly ? "✓" : ""}</span>
      Totals only
    </button>
  );
}

export default MatrixTotalsToggle;
