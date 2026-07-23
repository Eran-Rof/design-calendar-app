// Shrink-to-fit math for the planning filter row.
//
// CEO 2026-07-23: "screen is too small to fit in one row — wrap starts next
// row far left; try to fit in one row dynamically, up to 15% smaller on all
// filter fields."
//
// So: measure what the row's controls actually occupy, compare against the
// available width, and derive a uniform scale for every field — never below
// MIN_FIT_SCALE (0.85 = the CEO's 15% floor) and never above 1 (fields never
// grow past their natural size). Applied to each control's min/max width, so
// they compress together and long labels ellipsize instead of stretching.
//
// The measurement feeds back into the layout (smaller fields → smaller total),
// so `nextFitScale` is iterative and converges: it multiplies the CURRENT
// scale by the ratio of available:occupied. A dead-band stops the
// measure → resize → measure loop from oscillating by a pixel forever.

/** The CEO's floor: fields may shrink to 85% of natural size, no further. */
export const MIN_FIT_SCALE = 0.85;
/** Ignore changes smaller than this so ResizeObserver can't oscillate. */
export const FIT_SCALE_DEADBAND = 0.02;

export interface FitInput {
  /** Width the row's controls currently occupy (sum of children + gaps). */
  occupied: number;
  /** Width actually available on one line. */
  available: number;
  /** The scale those measurements were taken at. */
  currentScale: number;
}

/**
 * Next uniform scale for the row's fields, or `null` when the change is
 * within the dead-band (caller should leave the scale alone).
 */
export function nextFitScale({ occupied, available, currentScale }: FitInput): number | null {
  if (!(occupied > 0) || !(available > 0) || !(currentScale > 0)) return null;
  // Ratio < 1 → overflowing, shrink. Ratio > 1 → room to spare, grow back.
  const ideal = clampScale(currentScale * (available / occupied));
  return Math.abs(ideal - currentScale) > FIT_SCALE_DEADBAND ? ideal : null;
}

export function clampScale(s: number): number {
  if (!Number.isFinite(s)) return 1;
  return Math.min(1, Math.max(MIN_FIT_SCALE, s));
}

/** Scale a pixel dimension, never below 1px. */
export function scaled(px: number, scale: number): number {
  return Math.max(1, Math.round(px * scale));
}
