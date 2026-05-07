// Window-level arrow-key scrolling for grid containers. Used by
// ATS, the wholesale planning grid, and PO WIP so the operator
// can navigate the table without clicking it first.
//
// Suppression rules (don't hijack):
//   - text-entry surfaces: INPUT / TEXTAREA / SELECT / contentEditable
//   - modifier-arrow shortcuts: Alt / Ctrl / Cmd held
//
// Bindings:
//   ArrowLeft / ArrowRight  → ±stride horizontal
//   ArrowUp / ArrowDown     → ±stride vertical
//   PageUp / PageDown       → one viewport vertical
//   Shift+Home / Shift+End  → snap far-left / far-right
//
// Default stride is 60px — roughly one row vertically and one
// medium-width column horizontally. Holding the key produces native
// key-repeat which gives smooth continuous scroll.

import { useEffect } from "react";

export interface ArrowKeyScrollOpts {
  // Pixels to scroll per single arrow keypress. Default 60.
  stride?: number;
}

export function useArrowKeyScroll(
  tableRef: React.RefObject<HTMLDivElement>,
  opts: ArrowKeyScrollOpts = {},
): void {
  const stride = opts.stride ?? 60;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const tag = (t?.tagName || "").toUpperCase();
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (t && t.isContentEditable) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const el = tableRef.current;
      if (!el) return;
      switch (e.key) {
        case "ArrowLeft":  el.scrollLeft -= stride; e.preventDefault(); break;
        case "ArrowRight": el.scrollLeft += stride; e.preventDefault(); break;
        case "ArrowUp":    el.scrollTop  -= stride; e.preventDefault(); break;
        case "ArrowDown":  el.scrollTop  += stride; e.preventDefault(); break;
        case "PageUp":     el.scrollTop  -= el.clientHeight; e.preventDefault(); break;
        case "PageDown":   el.scrollTop  += el.clientHeight; e.preventDefault(); break;
        case "Home":       if (e.shiftKey) { el.scrollLeft = 0; e.preventDefault(); } break;
        case "End":        if (e.shiftKey) { el.scrollLeft = el.scrollWidth; e.preventDefault(); } break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tableRef, stride]);
}
