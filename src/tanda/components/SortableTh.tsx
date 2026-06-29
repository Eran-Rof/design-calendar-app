// src/tanda/components/SortableTh.tsx
//
// Sortable table-header cell — the companion to the useSort hook
// (src/tanda/hooks/useSort.ts). Drop-in replacement for a panel's plain
// `<th style={th} hidden={!isVisible("key")}>Label</th>`:
//
//   <SortableTh
//     label="Code" sortKey="code"
//     activeKey={sortKey} dir={sortDir} onSort={onHeaderClick}
//     style={th} hidden={!isVisible("code")}
//   />
//
// Coexists with the column-visibility primitive: the `hidden` prop is applied
// exactly like the static cell so a hidden column still collapses. Matches the
// Tangerine dark palette (active label brightens to near-white; inactive
// columns show no indicator).
//
// IMPORTANT — only wire SortableTh for columns whose key maps to a DIRECT
// scalar field on the row (or a trivially-correct accessor). For computed /
// JSX-only / aggregate columns, keep the plain `<th>` so no sort icon appears
// and the header is inert.

import React from "react";
import type { SortDir } from "../hooks/useSort";

const ACTIVE_COLOR = "#F1F5F9";

export interface SortableThProps {
  /** Visible header text. */
  label: string;
  /** The column's sort key — must match the key useSort resolves a value for. */
  sortKey: string;
  /** The currently-active sort key from useSort (null when unsorted). */
  activeKey: string | null;
  /** The active sort direction from useSort. */
  dir: SortDir;
  /** useSort's tri-state click handler. */
  onSort: (key: string) => void;
  /** The panel's existing `th` style object (background, padding, etc.). */
  style?: React.CSSProperties;
  /** Mirror the static cell's `hidden={!isVisible(key)}` so the column collapses. */
  hidden?: boolean;
  /** Optional native title / tooltip. */
  title?: string;
  /** Per-cell style override merged after `style` (e.g. textAlign:'right'). */
  cellStyle?: React.CSSProperties;
}

export const SortableTh: React.FC<SortableThProps> = ({
  label,
  sortKey,
  activeKey,
  dir,
  onSort,
  style,
  hidden,
  title,
  cellStyle,
}) => {
  const active = activeKey === sortKey;
  // When inactive, render a transparent placeholder arrow so the header width
  // doesn't shift when a column becomes the active sort.
  const indicator = active ? (dir === "asc" ? " ▲" : " ▼") : " ▲";
  return (
    <th
      style={{
        ...style,
        ...cellStyle,
        cursor: "pointer",
        userSelect: "none",
        ...(active ? { color: ACTIVE_COLOR } : null),
      }}
      hidden={hidden}
      title={title ?? `Sort by ${label}`}
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
      onClick={() => onSort(sortKey)}
    >
      {label}
      <span aria-hidden="true" style={{ opacity: active ? 1 : 0 }}>{indicator}</span>
    </th>
  );
};

export default SortableTh;
