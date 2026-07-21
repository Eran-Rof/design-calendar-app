// api/_lib/xoroLineMatch.js
//
// Pure, side-effect-free matching helpers for the Xoro → Tangerine order
// importer (scripts/import-xoro-orders.mjs). Extracted here so the tier logic
// is unit-testable WITHOUT a DB round-trip (the script itself opens a PostgREST
// connection at import time). The script imports these; keep it the single
// source of truth — do NOT fork copies back into the script.
//
// Covers:
//   • parseItemNumber        — split a Xoro "STYLE-COLOR-SIZE" ItemNumber
//   • canonSize / sizeVariantsOf — letter-size canonicalisation (mirrors
//                              api/_lib/styleMatrix.js LETTER_SIZE_CANON + the
//                              SQL canonical_size()); keep JS↔SQL in lock-step
//   • expandTokens / expandedColorKey / expandedKey — colour-abbreviation
//                              expansion (Lt↔Light, Blk↔Black, Gray↔Grey …)
//   • resolveStyleToken      — inseam-aware style-token → style id (the
//                              RYB147730 = RYB1477 + inseam 30 composite)
//   • pickColorSizeMatch     — EXACTLY-ONE colour+size(+inseam) catalog match
//                              (never guesses on zero-or-multi)
//   • mergePreservedLinks    — churn guard: a prior line's manual/auto link
//                              survives the delete+reinsert re-import

// ── ItemNumber parse ───────────────────────────────────────────────────────
// Parse a Xoro ItemNumber "STYLE-COLOR-SIZE" -> {style_code, color, size}.
export function parseItemNumber(item) {
  const s = String(item ?? "").trim();
  if (!s) return null;
  const parts = s.split("-");
  if (parts.length < 2) return { style_code: parts[0], color: null, size: null };
  const style_code = parts[0];
  const size = parts[parts.length - 1];
  const color = parts.slice(1, -1).join("-") || null;
  return { style_code, color, size };
}

// ── size canon (mirrors styleMatrix.js LETTER_SIZE_CANON + SQL canonical_size) ─
const SIZE_CANON = {
  XS: "XSMALL", XSM: "XSMALL", "X-SMALL": "XSMALL", XSMALL: "XSMALL",
  S: "SMALL", SM: "SMALL", SML: "SMALL", SMALL: "SMALL",
  M: "MEDIUM", MD: "MEDIUM", MED: "MEDIUM", MEDIUM: "MEDIUM",
  L: "LARGE", LG: "LARGE", LRG: "LARGE", LARGE: "LARGE",
  XL: "XLARGE", XLG: "XLARGE", "X-LARGE": "XLARGE", XLARGE: "XLARGE",
  XXL: "2XLARGE", "2X": "2XLARGE", "2XL": "2XLARGE", XXLARGE: "2XLARGE", "2XLARGE": "2XLARGE",
  XXXL: "3XLARGE", "3X": "3XLARGE", "3XL": "3XLARGE", "3XLARGE": "3XLARGE",
};
export const canonSize = (raw) => (raw == null ? raw : (SIZE_CANON[String(raw).trim().toUpperCase()] || String(raw).trim()));
const SIZE_VARIANTS = (() => {
  const m = {};
  for (const [tok, c] of Object.entries(SIZE_CANON)) (m[c] ||= new Set()).add(tok).add(c);
  return m;
})();
// All DB size tokens that mean the same size as `raw` (incl. raw itself).
export function sizeVariantsOf(raw) {
  if (raw == null) return [];
  const c = canonSize(raw);
  const set = SIZE_VARIANTS[c];
  return set ? [...new Set([...set, String(raw).trim()])] : [String(raw).trim()];
}

export const looseKey = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, "");

// ── colour-abbreviation expansion ──────────────────────────────────────────
// Xoro writes abbreviated colour words ("Carbon- Blck", "Gray Wolf - Lt Gray")
// while the catalog spells them out ("Carbon - Black", "Grey Wolf - Light
// Grey"). Expand ONLY the known abbreviation TOKENS and PRESERVE every other
// word, applied identically to BOTH sides so they converge.
// NOTE: this fold dictionary is MIRRORED by the SQL function po_dq_norm_color()
// (migration 20265400000000_v_po_data_quality_size_coverage_normalize.sql), which
// normalises PO-line colours for the v_po_data_quality incomplete_size_coverage
// check. Keep the two lists EXACTLY in sync — add a fold here, add it there.
// Folds are TOKEN-based (whole-word), so word boundaries are safe: "CAMEL" is a
// single token that never matches the "CAM" key, so it never folds to "CAMOEL".
const COLOR_ABBR = {
  LT: "LIGHT", LITE: "LIGHT", LGT: "LIGHT", DK: "DARK", DRK: "DARK",
  MD: "MEDIUM", MED: "MEDIUM", MDM: "MEDIUM",
  BLK: "BLACK", BLCK: "BLACK", BLAK: "BLACK",
  GRY: "GREY", GRAY: "GREY", GRYE: "GREY", HTHR: "HEATHER", HTR: "HEATHER",
  CHRCL: "CHARCOAL", CHRC: "CHARCOAL", WSH: "WASH", WHT: "WHITE", WHTE: "WHITE",
  BLU: "BLUE", NVY: "NAVY", BRN: "BROWN", GRN: "GREEN", W: "WITH", WTINT: "WITHTINT",
  CAM: "CAMO", CBO: "COMBO",
};
export function expandTokens(s) {
  return String(s ?? "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")     // camelCase  → camel Case
    .replace(/([A-Za-z])([0-9])/g, "$1 $2")  // letter+digit boundary
    .replace(/([0-9])([A-Za-z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim().toUpperCase()
    .split(/\s+/)
    .map((t) => COLOR_ABBR[t] || t)
    .join(" ");
}
// Abbreviation-expanded loose key (no separators) — full ItemNumber↔sku_code.
export const expandedKey = (s) => expandTokens(s).replace(/[^A-Z0-9]+/g, "");
// Abbreviation-expanded colour key — for choosing the right sibling colour.
export const expandedColorKey = (s) => expandTokens(s).replace(/\s+/g, " ").trim();
// Space-STRIPPED colour comparison key. expandedColorKey keeps single spaces, so
// it splits on tokenisation differences that mean the same colour: Xoro's camel-
// case "wTint" expands to "WITH TINT" (two tokens) while the catalog's "Wtint"
// expands to "WITHTINT" (one token) — same colour, unequal spaced keys. Dropping
// every separator collapses both to "…WITHTINT" so the tuple match still binds.
export const colorMatchKey = (s) => expandedColorKey(s).replace(/[^A-Z0-9]/g, "");

// ── inseam-aware style-token resolution ────────────────────────────────────
// Resolve a Xoro ItemNumber style token to a style id, unwrapping the INSEAM
// COMPOSITE when the raw token is not itself a known style_code: the catalog's
// sized SKUs embed the inseam in the style token ("RYB147730" = base style
// "RYB1477" + inseam "30"), but style_master keys on the base ("RYB1477"). So a
// composite token never resolves to a style, the tuple tier is skipped, and the
// line imports null-linked. We first try the raw token verbatim (direct hit
// wins — never strip a code that IS a real style); only on a miss do we peel a
// trailing 2-digit inseam and re-check.
//   styleByCode : Map<UPPER(style_code|alias), styleId>
//   returns { styleId, inseam } — inseam is the peeled 2-digit token or null.
export function resolveStyleToken(styleByCode, rawToken) {
  const t = String(rawToken ?? "").trim().toUpperCase();
  if (!t || !styleByCode) return { styleId: null, inseam: null };
  if (styleByCode.has(t)) return { styleId: styleByCode.get(t), inseam: null };
  const m = t.match(/^(.+?)(\d{2})$/);
  if (m && styleByCode.has(m[1])) return { styleId: styleByCode.get(m[1]), inseam: m[2] };
  return { styleId: null, inseam: null };
}

// ── exactly-one colour+size(+inseam) match ─────────────────────────────────
// From a pool of catalog rows (each {id,color,size,inseam,…}), return the SINGLE
// row whose colour (abbreviation-expanded, so Xoro's "Gray Wolf - Lt Gray"
// matches the catalog "Grey Wolf - Light Grey") and canonical size match the
// parsed line — optionally constrained to a known inseam so a style with
// multiple inseam composites can't cross-bind. NEVER guesses: zero OR multiple
// candidates → null (leave the line unlinked, current behaviour), only an
// unambiguous single hit is accepted.
export function pickColorSizeMatch(rows, { color, size, inseam } = {}) {
  if (!Array.isArray(rows) || !rows.length) return null;
  if (size == null || color == null) return null;
  const wantColor = colorMatchKey(color);
  if (!wantColor) return null;
  const sizeSet = new Set(sizeVariantsOf(size).map((s) => String(s).trim().toUpperCase()));
  const wantInseam = inseam == null ? null : String(inseam).trim();
  const cand = rows.filter((r) =>
    r && r.size != null &&
    sizeSet.has(String(r.size).trim().toUpperCase()) &&
    (wantInseam == null || String(r.inseam ?? "").trim() === wantInseam) &&
    colorMatchKey(r.color) === wantColor
  );
  return cand.length === 1 ? cand[0] : null;
}

// ── churn guard: preserve prior line links across delete+reinsert ───────────
// The importer re-materialises an existing PO/SO's lines by delete-then-insert.
// Left alone that discards every manual re-link an operator set on a line (and
// any prior successful auto-link) — the line reverts to whatever the resolver
// produces this run, which is null for the hard spelling-variant cases. Merge
// the prior links back in, keyed by line_number (deterministic from the stable
// Xoro Items ordering):
//   • prior non-null WINS over the resolver → a manual/auto link survives.
//   • prior null leaves the resolver's result → previously-unlinked lines get
//     RE-RESOLVED each run, so catalog fixes retroactively heal old orders
//     (and a link the churn already dropped is re-linked once the resolver can).
// Returns { rows, preserved } — preserved = count of lines whose link we
// restored from the prior row (differs from what the resolver produced).
export function mergePreservedLinks(lineRows, priorLinkByLineNo) {
  if (!priorLinkByLineNo || priorLinkByLineNo.size === 0) return { rows: lineRows, preserved: 0 };
  let preserved = 0;
  const rows = (lineRows || []).map((l) => {
    const prior = priorLinkByLineNo.get(l.line_number);
    if (prior == null) return l;                  // no prior link → keep resolver (heals nulls)
    if (prior === l.inventory_item_id) return l;  // agree — nothing to restore
    preserved++;                                  // prior non-null differs → preserve it
    return { ...l, inventory_item_id: prior };
  });
  return { rows, preserved };
}
