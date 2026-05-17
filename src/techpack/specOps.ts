// Pure data transforms for the Spec tab (`tp.measurements`) and the
// Spec Sheet detail view (`sheet.rows` + `sheet.sizes`). Extracted
// from TechPack.tsx so the table-mutation logic can be unit-tested
// without React, and so the same primitives can be reused from any
// future panel that lets the user edit a measurement grid.
//
// Two shapes look alike but differ in field names:
//   - Measurement.sizes is the size-value map
//   - SpecSheetRow.values is the size-value map
// Helpers are kept separate per shape rather than reaching for a
// generic helper — explicit beats clever here.

import type { Measurement, SpecSheetRow } from "./types";
import { uid } from "./utils";

// ── tp.measurements (Spec tab) ──────────────────────────────────────────────

/** Default tolerance string used for fresh measurement rows. */
export const DEFAULT_TOLERANCE = "±0.5";

/** Build a new blank measurement row with one empty value per size. */
export function createMeasurementRow(sizes: string[]): Measurement {
  const sizeMap: Record<string, string> = {};
  sizes.forEach(s => { sizeMap[s] = ""; });
  return { id: uid(), pointOfMeasure: "", tolerance: DEFAULT_TOLERANCE, sizes: sizeMap };
}

/**
 * Add a new size column to every measurement row, back-filling with
 * empty strings. Trimmed input; no-op if the trimmed name is empty.
 */
export function addSizeToMeasurements(measurements: Measurement[], sizeName: string): Measurement[] {
  const n = sizeName.trim();
  if (!n) return measurements;
  return measurements.map(m => ({ ...m, sizes: { ...m.sizes, [n]: "" } }));
}

/** Drop a size column from every measurement row's sizes map. */
export function removeSizeFromMeasurements(measurements: Measurement[], sizeName: string): Measurement[] {
  return measurements.map(m => {
    const next = { ...m.sizes };
    delete next[sizeName];
    return { ...m, sizes: next };
  });
}

// ── sheet.rows + sheet.sizes (Spec Sheet detail) ────────────────────────────

/** Fresh blank row for a spec sheet — values pre-seeded per size. */
export function createSpecSheetRow(sizes: string[]): SpecSheetRow {
  const v: Record<string, string> = {};
  sizes.forEach(s => { v[s] = ""; });
  return { id: uid(), pointOfMeasure: "", tolerance: DEFAULT_TOLERANCE, values: v };
}

/**
 * Add a new size column to a spec sheet. Returns updated `sizes`
 * AND `rows` so the caller can splice both into the spec sheet in
 * one go. Empty/whitespace name → returns the inputs as-is.
 */
export function addSizeToSpecSheet(
  rows: SpecSheetRow[],
  sizes: string[],
  sizeName: string,
): { rows: SpecSheetRow[]; sizes: string[] } {
  const n = sizeName.trim();
  if (!n) return { rows, sizes };
  return {
    sizes: [...sizes, n],
    rows: rows.map(r => ({ ...r, values: { ...r.values, [n]: "" } })),
  };
}

/**
 * Drop a size column from a spec sheet + remove its value from
 * every row. Returns updated `sizes` and `rows` together.
 */
export function removeSizeFromSpecSheet(
  rows: SpecSheetRow[],
  sizes: string[],
  sizeName: string,
): { rows: SpecSheetRow[]; sizes: string[] } {
  return {
    sizes: sizes.filter(s => s !== sizeName),
    rows: rows.map(r => {
      const v = { ...r.values };
      delete v[sizeName];
      return { ...r, values: v };
    }),
  };
}
