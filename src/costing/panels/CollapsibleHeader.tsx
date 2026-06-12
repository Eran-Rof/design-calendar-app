// Costing Module — CollapsibleHeader.
//
// Wraps an informational header block with a small ▾/▸ triangle (top-right)
// that collapses the block to reclaim vertical space. Collapsed state persists
// per `storageKey` in localStorage, so a header the operator hides stays hidden
// across reloads and across rows/projects of the same kind. When collapsed the
// body is replaced by an optional one-line `collapsedSummary`.
//
// Mirrors the chevron pattern already used by PlanFlowWidget so collapse
// affordances look identical everywhere a costing header is present.

import React, { useState } from "react";

interface Props {
  /** Stable key for localStorage persistence (namespaced under costing:collapse:). */
  storageKey: string;
  /** The header body that collapses. */
  children: React.ReactNode;
  /** Shown in place of the body when collapsed (e.g. a one-line summary). */
  collapsedSummary?: React.ReactNode;
  /** Start collapsed the first time (before any user toggle is stored). */
  defaultCollapsed?: boolean;
  /** Outer container style — move the wrapped block's card styling here. */
  style?: React.CSSProperties;
  /** Tooltip noun, e.g. "details" → "Collapse details". */
  title?: string;
}

export default function CollapsibleHeader({
  storageKey,
  children,
  collapsedSummary,
  defaultCollapsed = false,
  style,
  title = "section",
}: Props) {
  const key = `costing:collapse:${storageKey}`;
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(key);
      return v == null ? defaultCollapsed : v === "1";
    } catch {
      return defaultCollapsed;
    }
  });

  const toggle = () =>
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(key, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });

  return (
    <div style={{ position: "relative", ...style }}>
      <button
        onClick={toggle}
        title={collapsed ? `Expand ${title}` : `Collapse ${title}`}
        aria-expanded={!collapsed}
        style={{
          position: "absolute",
          top: 6,
          right: 8,
          zIndex: 2,
          background: "transparent",
          border: "none",
          color: "#94A3B8",
          fontSize: 12,
          cursor: "pointer",
          lineHeight: 1,
          padding: 4,
        }}
      >
        {collapsed ? "▸" : "▾"}
      </button>
      {collapsed ? (collapsedSummary ?? null) : children}
    </div>
  );
}
