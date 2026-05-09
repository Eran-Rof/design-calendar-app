// Always-visible, app-themed scrollbars for grid containers. Drop
// next to a `<div className="...">` that has overflow set, and the
// browser's native auto-hide horizontal scrollbar becomes a
// permanent slate-on-bg bar that matches the vertical one.
//
// Two pieces working together:
//   - Firefox uses scrollbarColor/scrollbarWidth on the parent
//     style (apply directly via CSS / inline style on the wrapper).
//   - Chromium / Safari use ::-webkit-scrollbar pseudo-elements,
//     which can only be set via a stylesheet — hence this <style>
//     component scoped via the `scope` className.
//
// Usage:
//   <GridScrollbarStyles scope="ip-grid-table-wrap" />
//   <div className="ip-grid-table-wrap" style={{ overflowX: "scroll", ... }}>
//     ... your table ...
//   </div>
//
// Caller still owns: overflowX (use "scroll" if you want the bar
// always visible, "auto" to let the browser hide it when not needed).
// Caller also owns scrollbarColor + scrollbarWidth on the wrapper
// style for Firefox.

import React from "react";

export interface GridScrollbarStylesProps {
  // CSS class on the wrapper div these styles target. Scoped so
  // the rules don't bleed into other tables / overflow regions on
  // the page.
  scope: string;
  // Track color (the channel the thumb slides in). Default slate-bg.
  trackColor?: string;
  // Thumb color (the draggable handle). Default border-color.
  thumbColor?: string;
  // Thumb hover color. Default a slightly brighter shade.
  thumbHoverColor?: string;
  // Bar thickness in px. Default 12.
  size?: number;
}

export function GridScrollbarStyles({
  scope,
  trackColor = "#0F172A",
  thumbColor = "#334155",
  thumbHoverColor = "#475569",
  size = 12,
}: GridScrollbarStylesProps): React.ReactElement {
  // Border on the track top creates a visual separator between
  // the table body and the scrollbar — makes the bar feel like
  // part of the grid card, not floating beneath it.
  // -webkit-appearance: none disables the native macOS overlay scrollbar
  // (the one that fades out when not actively scrolling). Without this,
  // Chrome / Safari ignore explicit width/height in some macOS configs
  // and keep the auto-hiding overlay regardless. With it + width set,
  // both browsers switch to a permanent inline scrollbar.
  const css = `
    .${scope}::-webkit-scrollbar { -webkit-appearance: none; width: ${size}px; height: ${size}px; background: ${trackColor}; }
    .${scope}::-webkit-scrollbar-track { background: ${trackColor}; }
    .${scope}::-webkit-scrollbar-thumb { background: ${thumbColor}; border-radius: ${Math.floor(size / 2)}px; border: 2px solid ${trackColor}; }
    .${scope}::-webkit-scrollbar-thumb:hover { background: ${thumbHoverColor}; }
    .${scope}::-webkit-scrollbar-corner { background: ${trackColor}; }
  `;
  return <style>{css}</style>;
}
