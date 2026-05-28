// Constants extracted from GridView.tsx. Column widths, page size,
// undo history cap, border/divider colors — anything tweakable that
// shouldn't be a magic number scattered through the main component.

import type React from "react";

export const PAGE_SIZE = 16;
export const MAX_UNDO  = 30;

// Fixed column widths: expand | notes | PO# | Vendor | Buyer | BuyerPO | DDP | Days from DDP.
// Per-column widths for the fixed (non-phase) columns in the PO WIP grid.
// Keyed so the hide-columns UI can selectively zero out a width without
// renumbering. The two leading 32px tracks (expand chevron + notes icon)
// always render — they're functional UI, not data columns the planner
// would hide.
export const HIDEABLE_COL_KEYS = ["poNum", "vendor", "buyer", "buyerPo", "ddp", "daysFromDdp"] as const;
export type HideableColKey = typeof HIDEABLE_COL_KEYS[number];

export const COL_WIDTHS: Record<HideableColKey, string> = {
  poNum:       "130px",
  vendor:      "160px",
  buyer:       "140px",
  buyerPo:     "110px",
  ddp:         "90px",
  daysFromDdp: "72px",
};

export const COL_LABELS: Record<HideableColKey, string> = {
  poNum:       "PO #",
  vendor:      "Vendor",
  buyer:       "Buyer",
  buyerPo:     "Buyer PO",
  ddp:         "DDP",
  daysFromDdp: "Days from DDP",
};

// Per-phase sub-columns sized to fit content + ~2-char breathing room:
//   Due Date 88 | Status ("Not Started") 90 | Status Date 82 | Days ("365 late") 56 | Phase Notes 26
export const PHASE_SUB  = "88px 90px 82px 56px 26px";
export const PHASE_COLS = 5;

// Border constants — standard borders 2px, phase divider 4px.
export const B_CELL = "2px solid #374151";   // standard cell border
export const B_HDR  = "2px solid #475569";   // header borders

// Phase divider: absolutely-positioned overlay inside the first sub-col of
// phases[1+]. The overlay extends top: -2px so it paints OVER the 2px
// borderBottom gap of the row above, and z-index keeps it on top of sibling
// grid items. overflow: visible on the host cell lets it bleed upward.
export const PHASE_DIV_COLOR = "#818CF8";

export const phaseDividerOverlay: React.CSSProperties = {
  position: "absolute",
  top: -2,
  left: 0,
  width: 4,
  height: "calc(100% + 2px)",
  background: PHASE_DIV_COLOR,
  pointerEvents: "none",
  zIndex: 3,
};

// Applied to the host cell that carries a divider overlay (left or right).
export const phaseDividerHost: React.CSSProperties = {
  position: "relative",
  zIndex: 1,
  overflow: "visible",
};

// Right-side overlay — used on the Notes cell of the LAST phase (closing border).
export const phaseDividerOverlayRight: React.CSSProperties = {
  position: "absolute",
  top: -2,
  right: 0,
  width: 4,
  height: "calc(100% + 2px)",
  background: PHASE_DIV_COLOR,
  pointerEvents: "none",
  zIndex: 3,
};

// Boundary divider — extends 4px PAST the host's right edge, landing at the
// same x as the phase-1 left-edge divider. Used on the Days-from-DDP cell
// (and the expanded-strip merged cell) so the fixed/phase boundary divider
// freezes together with col 8 when the operator expands a PO. With both
// overlays rendering at the same x, the frozen one stays visible while the
// phase-1 cell scrolls away underneath.
export const phaseDividerOverlayBoundary: React.CSSProperties = {
  position: "absolute",
  top: -2,
  right: -4,
  width: 4,
  height: "calc(100% + 2px)",
  background: PHASE_DIV_COLOR,
  pointerEvents: "none",
  zIndex: 3,
};
