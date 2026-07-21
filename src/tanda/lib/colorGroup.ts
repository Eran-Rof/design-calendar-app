// src/tanda/lib/colorGroup.ts
//
// Defensive colorway grouping helpers for every size-matrix body (PO / SO / AR).
//
// A matrix body groups colorway rows by the item's `color` string. The SAME
// physical color can arrive spelled with different CASE ("BLACK" vs "Black",
// "GREY" vs "Grey") because it is decoded from an item-master decoration that
// was written at different times. Grouping by the raw string therefore SPLITS
// one colorway into two matrix rows, each with only the sizes that happened to
// carry that spelling (verified on PO ROF-P000510: RYB1502 "BLACK" = SML-only
// row + "Black" = MED/LRG/XLG row).
//
// A parallel data patch normalizes existing rows to Title Case and the importer
// now writes Title Case for new rows (#1861 / #1874), so this is the *defensive*
// layer: group on a case-folded key so a future case variant can never split a
// row again, while DISPLAYING a canonical, human Title Case form.
//
// This is deliberately CASE-ONLY, unlike ./colorCanon's canonColor which ALSO
// expands abbreviations (Lt→Light, w→With). The normalized data direction is
// Title Case, not abbreviation-expanded, so the read side must faithfully show
// what the data now holds — it defends against case, it never rewrites words.

/** Case-folded grouping key for a colorway string. "BLACK", "Black", " black "
 *  all collapse to the same key so they merge into ONE matrix row. Blank / null
 *  → "" (callers apply their own "—" placeholder for an unlabelled colorway). */
export function colorGroupKey(color: string | null | undefined): string {
  return (color ?? "").trim().toUpperCase();
}

/** Plain word-wise Title Case for DISPLAY: the first letter of each whitespace-
 *  separated word upper, the rest lower. Deterministic and independent of which
 *  case variant was seen first, so two spellings display identically once merged
 *  AND two spellings that differ only in case produce the SAME string (making it
 *  safe to use directly as the grouping key where a map key doubles as display).
 *
 *  CASE-ONLY — it does NOT expand abbreviations (that is canonColor's job):
 *    "BLACK"      → "Black"
 *    "grey"       → "Grey"
 *    "Lt Wash"    → "Lt Wash"    (each word title-cased; "Lt" is NOT expanded)
 *    "NAVY/PEACH" → "Navy/peach" (only whitespace splits words; '/' does not)
 *    "wTint"      → "Wtint"      (one word → first letter upper, the rest lower)
 */
export function titleCaseColor(color: string | null | undefined): string {
  const s = (color ?? "").trim();
  if (!s) return "";
  return s.replace(/\S+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}
