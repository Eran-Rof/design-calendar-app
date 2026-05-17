// Sortable table header cell extracted from WholesalePlanningGrid.tsx.
// Every column in the grid uses this — keeping it in its own module
// lets the (huge) grid component scroll faster and lets future
// header-cell tweaks land without touching the main file.

import { S, PAL } from "../../components/styles";
import type { SortKey } from "./types";

export function Th({ label, k, sortKey, sortDir, onSort, numeric, tint, title, hidden, widths }: {
  label: string; k: SortKey; sortKey: SortKey; sortDir: "asc" | "desc";
  onSort: (k: SortKey) => void; numeric?: boolean; tint?: string; title?: string; hidden?: boolean;
  // Per-column widths computed by the grid component from the current
  // displayRows content set. Drives the freeze-through-column CSS
  // offsets too (see the IIFE that emits the sticky-left style block).
  widths: Record<string, number>;
}) {
  const active = sortKey === k;
  const baseColor = tint ?? (active ? PAL.text : PAL.textMuted);
  const width = widths[k];
  return (
    <th
      style={{
        ...S.th,
        cursor: "pointer",
        textAlign: numeric ? "right" : "left",
        color: active ? PAL.text : baseColor,
        userSelect: "none",
        ...(width != null ? { width, minWidth: width, maxWidth: width } : null),
        ...(hidden ? { display: "none" as const } : null),
      }}
      onClick={() => onSort(k)}
      title={title}
    >
      {label}{active ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
    </th>
  );
}
