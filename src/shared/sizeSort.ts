// src/shared/sizeSort.ts
//
// ONE canonical size-token comparator for the frontend, so every size grid (PO
// row-detail, matrices, exports) orders sizes identically. Mirrors the backend
// api/_lib/styleMatrix.js sizeSortKey. Handles, in this order:
//   • letter sizes — incl kids AGE-RANGE forms: "XS(5-6)", "S(7-8)", "M(10-12)"
//   • numeric waists — "28", "30", "32.5"
//   • PPK pack tokens — "PPK18", "PPK24"
//   • anything else — alpha, last
// Replaces ad-hoc SIZE_RANK maps that mis-sorted age-range sizes (L,M,S,XL,XS).

const SIZE_TIER: Record<string, number> = {
  XXSMALL: -2, XSMALL: -1, SMALL: 0, MEDIUM: 1, LARGE: 2,
  XLARGE: 3, "2XLARGE": 4, "3XLARGE": 5, "4XLARGE": 6, "5XLARGE": 7,
};
const LETTER_CANON: Record<string, string> = {
  XXS: "XXSMALL", XS: "XSMALL", XSMALL: "XSMALL",
  S: "SMALL", SM: "SMALL", SML: "SMALL", SMALL: "SMALL",
  M: "MEDIUM", MD: "MEDIUM", MED: "MEDIUM", MEDIUM: "MEDIUM",
  L: "LARGE", LG: "LARGE", LRG: "LARGE", LARGE: "LARGE",
  XL: "XLARGE", XLG: "XLARGE", XLARGE: "XLARGE",
  XXL: "2XLARGE", "2XL": "2XLARGE", "2X": "2XLARGE", "2XLARGE": "2XLARGE",
  XXXL: "3XLARGE", "3XL": "3XLARGE", "3X": "3XLARGE", "3XLARGE": "3XLARGE",
  "4XL": "4XLARGE", "4X": "4XLARGE", "4XLARGE": "4XLARGE",
};

// Tiers: numeric waists FIRST, then letter sizes, then PPK pack tokens, then
// anything else. (Numeric-before-letter preserves the frontend's long-standing
// convention; the two systems don't coexist within one real style, so this only
// affects the rare mixed case.)
function rankOf(size: string): { tier: number; rank: number; sub: number; alpha: string } {
  const s = String(size ?? "").trim();
  if (!s) return { tier: 9, rank: 0, sub: 0, alpha: "" };
  if (/^\d+(\.\d+)?$/.test(s)) return { tier: 0, rank: Number(s), sub: 0, alpha: "" };  // numeric waist
  const base = s.split(/[\s(]/)[0];                 // "XS(5-6)" → "XS"; "MEDIUM" → "MEDIUM"
  const canon = LETTER_CANON[base.toUpperCase()] || base.toUpperCase();
  if (canon in SIZE_TIER) {
    const lo = (s.match(/\((\d+)/) || [])[1];        // age-range low bound as tiebreak
    return { tier: 1, rank: SIZE_TIER[canon], sub: lo ? Number(lo) : 0, alpha: "" };
  }
  const ppk = s.match(/^PPK(\d+)$/i);
  if (ppk) return { tier: 2, rank: Number(ppk[1]), sub: 0, alpha: "" };
  return { tier: 3, rank: 0, sub: 0, alpha: s.toUpperCase() };
}

/** Comparator for Array.sort — canonical apparel size order. */
export function compareSizes(a: string, b: string): number {
  const ka = rankOf(a), kb = rankOf(b);
  if (ka.tier !== kb.tier) return ka.tier - kb.tier;
  if (ka.tier === 3) return ka.alpha.localeCompare(kb.alpha);
  if (ka.rank !== kb.rank) return ka.rank - kb.rank;
  return ka.sub - kb.sub;
}
