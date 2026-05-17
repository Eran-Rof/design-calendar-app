// Pure list/filter/stats helpers extracted from TechPack.tsx.
// Used by the main dashboard + the email panel's tech-pack filter +
// any future panel that needs to count or scope tech packs.
//
// Keeping them in their own module means a future state-restructure
// can swap the inputs without touching the math AND lets unit tests
// hit the math directly.

import type { Sample, TechPack } from "./types";

export interface TechPackFilter {
  /** Empty string means "no filter". */
  status: string;
  /** Empty string means "no filter". */
  brand: string;
  /** Empty string means "no filter". */
  season: string;
  /** Empty / null / undefined means "no filter". Case-insensitive substring
   *  match against styleName / styleNumber / brand. */
  search?: string | null;
}

/**
 * Filter a list of tech packs by status / brand / season + a free-text
 * search across styleName, styleNumber, brand. Returns a new array;
 * never mutates input.
 */
export function filterTechPacks(techPacks: TechPack[], f: TechPackFilter): TechPack[] {
  const q = (f.search ?? "").toLowerCase();
  return techPacks.filter(tp => {
    if (f.status && tp.status !== f.status) return false;
    if (f.brand  && tp.brand  !== f.brand)  return false;
    if (f.season && tp.season !== f.season) return false;
    if (q) {
      const sn = (tp.styleName ?? "").toLowerCase();
      const snum = (tp.styleNumber ?? "").toLowerCase();
      const br = (tp.brand ?? "").toLowerCase();
      if (!sn.includes(q) && !snum.includes(q) && !br.includes(q)) return false;
    }
    return true;
  });
}

export interface DashboardStats {
  total:    number;
  draft:    number;
  review:   number;
  approved: number;
}

/** Counts for the four dashboard stat cards. */
export function computeDashboardStats(techPacks: TechPack[]): DashboardStats {
  let draft = 0, review = 0, approved = 0;
  for (const t of techPacks) {
    if      (t.status === "Draft")     draft++;
    else if (t.status === "In Review") review++;
    else if (t.status === "Approved")  approved++;
  }
  return { total: techPacks.length, draft, review, approved };
}

export type SampleWithStyle = Sample & { styleNumber: string; styleName: string };

/**
 * Flatten every sample across every tech pack, denormalising the
 * parent style number + name onto each entry. Used by the samples
 * view to show a global sample queue.
 */
export function flattenAllSamples(techPacks: TechPack[]): SampleWithStyle[] {
  return techPacks.flatMap(tp =>
    tp.samples.map(s => ({ ...s, styleNumber: tp.styleNumber, styleName: tp.styleName })),
  );
}

/** Sorted unique non-empty brand list pulled from `techPacks`. */
export function uniqueBrands(techPacks: TechPack[]): string[] {
  return Array.from(new Set(techPacks.map(t => t.brand).filter(Boolean))).sort();
}

/** Sorted unique non-empty season list pulled from `techPacks`. */
export function uniqueSeasons(techPacks: TechPack[]): string[] {
  return Array.from(new Set(techPacks.map(t => t.season).filter(Boolean))).sort();
}
