// api/_lib/inventory/restCsvSize.js
//
// Repair the Xoro REST inventory CSV's kids/age-range size corruption.
//
// Xoro exports a child age-range size like "XS(5-6)" using an UNQUOTED comma —
// "XS(5,6)" — baked into the Color field: "DEEP BLACK-XS(5,6)". A comma is the
// CSV field delimiter, so a naive column split spills the range's upper bound
// into the very next (Size) column:
//
//     raw:   ...,DEEP BLACK-XS(5,6),58481,100222757BK-DEEP BLACK-XS(5-6),...
//     split: Color = "DEEP BLACK-XS(5"   Size = "6)"   ItemId = 58481
//
// (The ItemNumber column keeps the clean "…-XS(5-6)" form, but the ingest keys
// SKUs on the Color/Size columns.) Left unrepaired this forks 150+ garbage SKUs
// whose color holds a size fragment and whose "size" is a bare "6)", producing
// fake matrix colors + junk size columns ("6) 8) 12)…"). The quantities are
// correct; only the color/size FIELDS are broken. See
// [[project_phantom_opening_balance_onhand]] §3(B).
//
// The corruption is uniform in the feed: every case is
// "<COLOR>-<LABEL>(<lo>,<hi>)" with LABEL in {XS,S,M,L,XL} and exactly a two-bound
// range. We detect that exact signature (color ends "-<LABEL>(<lo>", size is
// "<hi>)") and rebuild color = "DEEP BLACK", size = "XS(5-6)". Any cell that does
// not match is returned unchanged, so normal rows ("Grey" / "30") are untouched
// and colors that legitimately contain digits/parens are never mangled.

// color tail:  <base>-<label>(<lo>   e.g. "DEEP BLACK-XS(5"  (label is paren/dash-free)
const COLOR_TAIL = /^(.*)-([A-Za-z0-9/]+)\((\d+)$/;
// size remainder: the spilled upper bound   e.g. "6)"
const SIZE_HI = /^(\d+)\)$/;

/**
 * Repair one (color, size) cell parsed from the REST CSV.
 * @param {string} color raw Color column value
 * @param {string} size  raw Size column value
 * @returns {{ color: string, size: string, repaired: boolean }}
 */
export function repairSizeCell(color, size) {
  const c = String(color ?? "").trim();
  const s = String(size ?? "").trim();
  const cm = c.match(COLOR_TAIL);
  const sm = s.match(SIZE_HI);
  if (cm && sm) {
    return { color: cm[1].trim(), size: `${cm[2]}(${cm[3]}-${sm[1]})`, repaired: true };
  }
  return { color: c, size: s, repaired: false };
}
