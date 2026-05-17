// Pure data-transformation helpers for the BOM tab and the sketch
// tab's callout list. Extracted from TechPack.tsx so the
// list-mutating logic can be unit-tested without React, and so the
// renderXxxTab functions only deal with state plumbing.
//
// Every helper returns a brand-new array / object — never mutates
// its input. This keeps React reconciliation happy and lets tests
// compare before/after by reference.

import type { BOMItem, BOMColorSpec, Colorway, SketchCallout } from "./types";
import { uid } from "./utils";

const blankColorSpec = (cwId: string): BOMColorSpec =>
  ({ colorwayId: cwId, color: "", pantone: "", trialSize: "" });

/** Make a new colorway with an uppercased trimmed name. */
export function createColorway(name: string): Colorway {
  return { id: uid(), name: name.trim().toUpperCase() };
}

/**
 * Append a blank color-spec entry for `cwId` to every BOM item.
 * Used when a new colorway is added so each item gets an editable
 * row in the new column.
 */
export function addColorwayToBOM(bom: BOMItem[], cwId: string): BOMItem[] {
  return bom.map(b => ({
    ...b,
    colorSpecs: [...(b.colorSpecs || []), blankColorSpec(cwId)],
  }));
}

/** Drop the color-spec entry matching `cwId` from every BOM item. */
export function removeColorwayFromBOM(bom: BOMItem[], cwId: string): BOMItem[] {
  return bom.map(b => ({
    ...b,
    colorSpecs: (b.colorSpecs || []).filter(cs => cs.colorwayId !== cwId),
  }));
}

/**
 * Factory for a fresh empty BOM item, pre-seeded with one blank
 * color-spec per existing colorway. Used by the "+ Add Item" button.
 */
export function createBOMItem(colorways: Colorway[]): BOMItem {
  return {
    id: uid(),
    materialNo: "",
    material: "",
    placement: "",
    content: "",
    weight: "",
    quantity: "",
    uom: "YDS",
    supplier: "",
    unitCost: 0,
    totalCost: 0,
    notes: "",
    image: null,
    colorSpecs: colorways.map(cw => blankColorSpec(cw.id)),
  };
}

/**
 * Apply `changes` to a single BOM item's color-spec entry for
 * `cwId`. If the entry already exists, it's merged; otherwise a
 * fresh spec is appended (so edits to a colorway that was added
 * AFTER this BOM item still work).
 */
export function updateColorSpecOnBOM(
  bom: BOMItem[],
  bomIdx: number,
  cwId: string,
  changes: Partial<BOMColorSpec>,
): BOMItem[] {
  const updated = [...bom];
  const specs = [...(updated[bomIdx].colorSpecs || [])];
  const si = specs.findIndex(cs => cs.colorwayId === cwId);
  if (si >= 0) specs[si] = { ...specs[si], ...changes };
  else specs.push({ ...blankColorSpec(cwId), ...changes });
  updated[bomIdx] = { ...updated[bomIdx], colorSpecs: specs };
  return updated;
}

// ── Sketch callouts ────────────────────────────────────────────────────────

/** Next free callout number = max existing + 1, or 1 if list is empty. */
export function nextCalloutNumber(callouts: SketchCallout[]): number {
  if (callouts.length === 0) return 1;
  return Math.max(...callouts.map(c => c.number)) + 1;
}

/** Append a fresh callout with the next sequential number. */
export function addSketchCallout(callouts: SketchCallout[]): SketchCallout[] {
  return [...callouts, { id: uid(), number: nextCalloutNumber(callouts), description: "" }];
}

/** Merge `changes` into the callout with matching `id`; others pass through. */
export function updateSketchCallout(
  callouts: SketchCallout[],
  id: string,
  changes: Partial<SketchCallout>,
): SketchCallout[] {
  return callouts.map(c => c.id === id ? { ...c, ...changes } : c);
}

/** Drop the callout with matching `id`. */
export function removeSketchCallout(callouts: SketchCallout[], id: string): SketchCallout[] {
  return callouts.filter(c => c.id !== id);
}

/** Stable, ascending sort by callout number. Returns a new array. */
export function sortCalloutsByNumber(callouts: SketchCallout[]): SketchCallout[] {
  return [...callouts].sort((a, b) => a.number - b.number);
}
