// usePopoverAnchor — shared positioning helper for portal-based popovers
// inside the costing grid. Grid body cells have overflow:hidden, so any
// absolute-positioned popover gets clipped inside the cell boundaries.
// The fix is to portal the popover into document.body with position:fixed
// coordinates computed from the trigger's bounding rect — and recompute
// on scroll/resize so it stays anchored when the grid moves.
//
// Returns:
//   anchorRef     — attach to the trigger element
//   pos           — { left, top, width } or null when closed/un-measured
//
// Caller controls open state and rendering. Width follows the trigger's
// width but clamps to minWidth.

import { useLayoutEffect, useRef, useState } from "react";

export interface AnchorPos {
  left: number;
  top: number;
  width: number;
}

export interface UsePopoverAnchorOpts {
  open: boolean;
  minWidth?: number;
  /** Where to anchor the popover horizontally relative to the trigger. */
  align?: "left" | "right";
}

export function usePopoverAnchor<T extends HTMLElement>(opts: UsePopoverAnchorOpts) {
  const { open, minWidth = 240, align = "left" } = opts;
  const anchorRef = useRef<T | null>(null);
  const [pos, setPos] = useState<AnchorPos | null>(null);

  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const compute = () => {
      const el = anchorRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const width = Math.max(r.width, minWidth);
      const left = align === "right"
        ? Math.max(8, r.right - width)
        : r.left;
      setPos({ left, top: r.bottom + 2, width });
    };
    compute();
    window.addEventListener("scroll", compute, true);
    window.addEventListener("resize", compute);
    return () => {
      window.removeEventListener("scroll", compute, true);
      window.removeEventListener("resize", compute);
    };
  }, [open, minWidth, align]);

  return { anchorRef, pos };
}
