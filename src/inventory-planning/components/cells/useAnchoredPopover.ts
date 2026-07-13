// Shared open/position/dismiss logic for the TBD cell pickers (Customer,
// Color, Description). The popover renders in a portal on document.body with
// FIXED positioning anchored to the trigger's rect, so the grid's horizontal-
// scroll overflow can't clip it (the old position:absolute popovers rendered
// behind later rows). Position is recomputed on scroll (capture phase, so the
// inner grid container's scroll is caught too) + resize, and flips above the
// cell when there's more room up top (rows near the viewport bottom).

import { useEffect, useRef, useState } from "react";

export interface AnchoredPopoverPos {
  left: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}

export function useAnchoredPopover() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<AnchoredPopoverPos | null>(null);

  useEffect(() => {
    if (!open) { setPos(null); return; }
    function reposition() {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const spaceBelow = window.innerHeight - r.bottom;
      const spaceAbove = r.top;
      const openUp = spaceBelow < 260 && spaceAbove > spaceBelow;
      const maxHeight = Math.max(160, Math.min(360, (openUp ? spaceAbove : spaceBelow) - 12));
      setPos(openUp
        ? { left: r.left, bottom: window.innerHeight - r.top + 4, maxHeight }
        : { left: r.left, top: r.bottom + 4, maxHeight });
    }
    reposition();
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    function onDocClick(e: MouseEvent) {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (popoverRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setOpen(false); }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return { open, setOpen, triggerRef, popoverRef, pos };
}
