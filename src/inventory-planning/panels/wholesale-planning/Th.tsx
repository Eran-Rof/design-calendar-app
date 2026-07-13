// Sortable table header cell extracted from WholesalePlanningGrid.tsx.
// Every column in the grid uses this — keeping it in its own module
// lets the (huge) grid component scroll faster and lets future
// header-cell tweaks land without touching the main file.
//
// Multi-column sort: the grid holds a sort STACK (array of {key,dir}).
// Plain click = single-column sort (this column only). Shift+click = add /
// toggle this column as an additional sort key, keeping the already-sorted
// columns as parents. Each sorted column shows its direction (▲/▼) and, when
// more than one column is sorted, its priority number (1 = parent).

import { S, PAL } from "../../components/styles";
import type { SortKey, SortEntry } from "./types";

export function Th({ label, k, sortStack, onSort, numeric, tint, title, hidden, widths }: {
  label: string; k: SortKey; sortStack: SortEntry[];
  onSort: (k: SortKey, additive: boolean) => void; numeric?: boolean; tint?: string; title?: string; hidden?: boolean;
  // Per-column widths computed by the grid component from the current
  // displayRows content set. Drives the freeze-through-column CSS
  // offsets too (see the IIFE that emits the sticky-left style block).
  widths: Record<string, number>;
}) {
  const idx = sortStack.findIndex((s) => s.key === k);
  const active = idx !== -1;
  const dir = active ? sortStack[idx].dir : null;
  const priority = active ? idx + 1 : null;
  const baseColor = tint ?? (active ? PAL.text : PAL.textMuted);
  const width = widths[k];
  const arrow = dir === "asc" ? "▲" : dir === "desc" ? "▼" : "";
  // Priority number only when there's a multi-column sort — a single sort
  // needs no "1" badge.
  const badge = active && sortStack.length > 1 ? String(priority) : "";
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
      onClick={(e) => onSort(k, e.shiftKey)}
      title={title ? `${title}\n\nClick to sort; Shift+click to add a secondary sort.` : "Click to sort; Shift+click to add a secondary sort."}
    >
      {label}{active ? ` ${arrow}` : ""}
      {badge ? <sup style={{ fontSize: 9, color: PAL.accent, marginLeft: 1 }}>{badge}</sup> : ""}
    </th>
  );
}
