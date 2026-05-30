// src/tanda/components/ScrollHighlightRow.tsx
//
// Tangerine universal-row-click primitive (operator ask #4) — companion
// component to `useRowClickEdit`.
//
// Adopting panels swap their per-row <tr> for <ScrollHighlightRow>. The
// component renders a normal <tr> and, when its `data-row-id` matches the
// `highlightedRowId` prop, paints a translucent blue background that fades
// to transparent over ~2s. The fade is pure CSS (a keyframe animation on a
// data attribute), so there is no JS rAF loop and the animation is paused
// in inactive tabs by the browser for free.
//
// The fade is RE-TRIGGERED whenever `highlightedRowId` flips to this row's
// id (so clicking the same row twice replays the highlight) and whenever
// the row is scrolled BACK into view after being scrolled out (so the
// operator sees where their click landed when they scroll back). The
// IntersectionObserver in `useScrollHighlight` handles the second case.
//
// CSS lives next to this component as a sibling import — Vite handles it
// via its built-in CSS pipeline. No CSS module hashing is required since
// the class names are namespaced under `tanda-row-`.

import React, { useEffect, useRef, useState } from "react";
import "./ScrollHighlightRow.css";

export interface ScrollHighlightRowProps
  extends React.HTMLAttributes<HTMLTableRowElement> {
  /** Stable id for this row. Compared against `highlightedRowId`. */
  rowId: string;
  /** The id of the row to highlight, or null. Usually from useRowClickEdit. */
  highlightedRowId: string | null;
  /**
   * Fade duration in milliseconds. Default 2000. Exposed so visual tests
   * can shorten it to 0 to test the no-highlight branch deterministically.
   */
  fadeMs?: number;
  /** Child <td> cells. */
  children: React.ReactNode;
}

/**
 * Wrapper that paints + fades a highlight bg when this row matches the
 * currently-tracked "last-clicked" id. Behaves like a plain <tr> otherwise.
 */
export default function ScrollHighlightRow({
  rowId,
  highlightedRowId,
  fadeMs = 2000,
  children,
  className,
  style,
  ...rest
}: ScrollHighlightRowProps) {
  const ref = useRef<HTMLTableRowElement | null>(null);
  // A bump counter so the CSS animation restarts each time we want to
  // replay the fade. Incrementing it changes the `data-highlight-tick`
  // attribute, which the keyframe selector keys off of.
  const [tick, setTick] = useState(0);
  const isHighlighted = highlightedRowId != null && highlightedRowId === rowId;

  // (Re)trigger the fade whenever this row becomes the highlighted one.
  useEffect(() => {
    if (!isHighlighted) return;
    setTick((t) => t + 1);
  }, [isHighlighted]);

  // Replay the fade when the row scrolls back into view after being out
  // of view. We only re-trigger if THIS row is the currently-highlighted
  // one; otherwise the observer is a no-op.
  useEffect(() => {
    if (!isHighlighted) return;
    const node = ref.current;
    if (!node) return;
    // IntersectionObserver may not exist in some test environments.
    if (typeof IntersectionObserver === "undefined") return;
    let wasOutOfView = false;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) {
            wasOutOfView = true;
          } else if (wasOutOfView) {
            wasOutOfView = false;
            setTick((t) => t + 1);
          }
        }
      },
      { threshold: 0.1 },
    );
    obs.observe(node);
    return () => obs.disconnect();
  }, [isHighlighted]);

  const mergedClassName = [
    "tanda-row",
    "tanda-row--clickable",
    isHighlighted ? "tanda-row--highlighted" : "",
    className || "",
  ]
    .filter(Boolean)
    .join(" ");

  // Expose the fade duration as a CSS custom property so the keyframe can
  // honour it. Cast through unknown because React's CSSProperties does not
  // know about custom properties.
  const mergedStyle = {
    ...(style || {}),
    ["--tanda-row-fade-ms" as string]: `${fadeMs}ms`,
  } as React.CSSProperties;

  return (
    <tr
      {...rest}
      ref={ref}
      className={mergedClassName}
      style={mergedStyle}
      data-row-id={rowId}
      data-highlight-tick={isHighlighted ? tick : undefined}
      data-testid={rest["data-testid"] ?? "scroll-highlight-row"}
    >
      {children}
    </tr>
  );
}
