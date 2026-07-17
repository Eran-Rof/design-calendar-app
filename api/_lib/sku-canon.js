// api/_lib/sku-canon.js
//
// Single source of truth for SKU normalization across the planning API
// handlers (xoro-sales-sync, tanda-pos-sync, ats-supply-sync). Each
// handler used to carry its own copy of these regexes — they drifted
// over time, fragmented the item master, and made the grid show
// different SKUs depending on which source loaded last. Mirrored in
// src/inventory-planning/utils/skuCanon.ts for the browser side
// (Excel ingest) — keep the regexes identical.

// All known size suffixes we strip to roll items up to style+color grain.
// Covers numeric sizes (-30, -32, -2), single-letter (-XS..-XXXL),
// 2-letter combos (-SM/-MD/-LG), 3-letter combos (-SML/-MED/-LRG/-XLG/-XXLG/-XXXLG/-XSM),
// digit-prefixed XL family (-2XL/-3XLG/etc., generalized as [0-9]*X+LG?),
// one-size markers (-OS/-OSFA/-O/S), prepack suffixes (-PPK18, -PPK_24),
// and parenthesized ranges (-L(14-16) etc.).
const SIZE_SUFFIX_RE =
  /-(XS|XSM|S|SM|M|MD|L|LG|[0-9]*X+LG?|SML|MED|LRG|OS|OSFA|O\/S|PPK[\s_-]*\d+|[0-9]+|[A-Z]+\([0-9X\-]+\))$/;

// Strip whitespace + uppercase. Used for hash-key matching (sku_code in DB).
export function canonSku(raw) {
  return (raw ?? "").toString().trim().toUpperCase().replace(/\s+/g, "");
}

// Trailing SIZE-token vocabulary for parseSizeSuffix. DELIBERATELY richer than
// SIZE_SUFFIX_RE (which canonStyleColor uses to roll up): it also recognises the
// spelled-out apparel sizes (SMALL/MEDIUM/LARGE) and toddler month sizes
// (12MO/18MO) that appear in real sku_codes but which SIZE_SUFFIX_RE never
// stripped. We keep it SEPARATE from SIZE_SUFFIX_RE on purpose — widening the
// rollup regex would change how the whole planning system aggregates SKUs
// (item-master fragmentation / merges), a broad + risky change. parseSizeSuffix
// only READS a size for stub population; it must not alter rollup grain. The
// backfill (scripts/backfills/ar-mirror-size-resolution.mjs) mirrors this exact
// vocabulary in SQL so go-forward + historical agree. Alternatives are safe to
// order any way because the trailing `$` forces a full-suffix match.
const SIZE_TOKEN_RE =
  /-(XXXS|XXS|XSM|XS|SMALL|SML|SM|S|MEDIUM|MED|MD|M|LARGE|LRG|LG|L|XXXL|XXL|XL|[0-9]*X+LG?|OSFA|OS|O\/S|[0-9]+MO|[0-9]{1,3}|PPK[\s_-]*\d+)$/;

// Parse the trailing SIZE token off a canonical sku_code, if present.
// Returns the uppercased size (e.g. "LARGE", "12MO", "30", "SML", "PPK24")
// or null when the sku_code carries no size suffix (a style+color rollup).
//
// This is (a superset of) the inverse of canonStyleColor: canonStyleColor
// STRIPS the token; parseSizeSuffix RETURNS it. Used so stub-creating sync
// handlers can populate ip_item_master.size when the SKU embeds a size —
// otherwise every size-bearing stub lands with size=NULL and the AR / RMA
// color x size matrices can't place it (it falls to the non-matrix "other
// lines" bucket). See project memory project_xoro_unresolved_line_backfill +
// the AR-mirror size-resolution fix.
export function parseSizeSuffix(raw) {
  const s = canonSku(raw);
  if (!s) return null;
  const m = s.match(SIZE_TOKEN_RE);
  return m ? m[1] : null;
}

// Roll a raw Xoro/ATS SKU up to style+color grain (drop trailing size).
// Examples:
//   "RYB059430-ISLAND BREEZE LT WASH-30" → "RYB059430-ISLANDBREEZELTWASH"
//   "PTYA0019-Blackberry-M"              → "PTYA0019-BLACKBERRY"
//   "PTYA0019-Blackberry"                → "PTYA0019-BLACKBERRY" (no change)
//   "100221821BK-BRUSHEDALLOY-L(14-16)"  → "100221821BK-BRUSHEDALLOY"
export function canonStyleColor(raw) {
  let s = canonSku(raw);
  if (!s) return s;
  return s.replace(SIZE_SUFFIX_RE, "");
}

// Parse style (everything before first "-") and color (everything after)
// from a canonical sku_code. Returns { style, color } where either may
// be null when the SKU has no separator.
export function parseStyleColor(canonicalSku) {
  if (!canonicalSku) return { style: null, color: null };
  const dash = canonicalSku.indexOf("-");
  if (dash <= 0) return { style: canonicalSku, color: null };
  return {
    style: canonicalSku.substring(0, dash),
    color: canonicalSku.substring(dash + 1),
  };
}

// Derive the COLOR token embedded in a full size-grain SKU — the middle
// dash-segment between style and trailing size. Robust for multi-dash sizes:
// we FIRST roll the SKU up to style+color grain (canonStyleColor strips the
// trailing size token, incl. paren ranges like "-L(14-16)"), THEN split the
// color off the front. Returns the uppercased, whitespace-stripped color token
// (e.g. "BLACKSHADOWGD" from "100203712MN-Black Shadow GD-29") or null when the
// SKU carries no color segment (no dash, e.g. a bare numeric style rollup).
//
// WHY (#1825 residual): private-label ItemNumbers are dash-delimited
// style-color-size (Xoro's own authoritative encoding). Xoro carries no
// separate per-line colour attribute, so this embedded segment IS the colour of
// record. Size-grain stubs MUST carry it: without a colour, two different
// colours of the same style+size (…-BLACKSHADOWGD-29 and …-SIMPLESAGEGD-29)
// both land as (style_id, color='', size='29') and collide on
// uq_ip_item_master_logical_sku — poisoning the whole invoice's explosion.
export function deriveColorFromSku(rawSku) {
  const { color } = parseStyleColor(canonStyleColor(rawSku));
  return color || null;
}

// Collapse a size to its canonical form — a 1:1 JS MIRROR of the SQL
// canonical_size() (migration 20260724000000) that keys uq_ip_item_master_
// logical_sku. Keep the two in lock-step: any divergence lets a twin-reuse
// match a row the DB then rejects (or miss one it would have merged). Numeric
// waist sizes (30/32) and unknown tokens pass through as upper(trim). NULL → "".
const _CANON_SIZE = {
  XS: "XSMALL", XSM: "XSMALL",
  S: "SMALL", SM: "SMALL", SML: "SMALL",
  M: "MEDIUM", MD: "MEDIUM", MED: "MEDIUM",
  L: "LARGE", LG: "LARGE", LRG: "LARGE",
  XL: "XLARGE", XLG: "XLARGE",
  XXL: "2XLARGE", "2X": "2XLARGE", "2XL": "2XLARGE",
  "3X": "3XLARGE", "3XL": "3XLARGE", XXXL: "3XLARGE",
};
export function canonicalSize(s) {
  if (s == null) return "";
  const u = String(s).trim().toUpperCase();
  return _CANON_SIZE[u] || u;
}

// Normalize a colour to a comparison KEY: uppercase, strip every non-alphanumeric
// character. Collapses the catalog's punctuation/spacing variance for the SAME
// colour — "Black Shadow Gd", "BLACK-SHADOW-GD", "BLACKSHADOWGD" all → "BLACKSHADOWGD"
// — so a size-grain payload SKU can find its authoritative logical twin already in
// ip_item_master (whose colour may be stored spaced, dashed, or squished).
export function normalizeColorKey(color) {
  return (color == null ? "" : String(color)).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// Build an ip_item_master row payload for a given SKU.
//
// Default mode (`minimal: true`) — for sync handlers (Xoro sales, TandA
// POs, ATS supply). Writes ONLY sku_code + sku-derived style_code +
// active=true. Does NOT include description, color (display), unit_cost,
// or unit_price even if overrides has them — so an existing master row
// keeps its authoritative values from the Item Master Excel upload.
//
// Set `minimal: false` only from the Item Master Excel uploader, which
// IS the authoritative source.
export function buildItemRow(canonicalSku, overrides = {}) {
  const { style, color } = parseStyleColor(canonicalSku);
  const minimal = overrides.minimal !== false; // default true
  const row = {
    sku_code: canonicalSku,
    style_code: style,
    uom: overrides.uom ?? "each",
    active: true,
  };
  if (minimal) {
    // A minimal stub carries no size/inseam/length/fit, so it MUST be
    // is_apparel:false — otherwise ip_item_master's apparel_dims_required
    // CHECK rejects every new bottoms/apparel SKU, the insert chunk errors,
    // and the SKU is dropped from the sync ("no id ... after stub insert"
    // in planning-sync). Same workaround /api/master/sync uses on its
    // new-row path; the merchandiser flips is_apparel back to true via the
    // admin UI once dims are backfilled.
    row.is_apparel = false;
    // Populate `size` when the sku_code embeds a trailing size token (e.g.
    // "...-LARGE", "...-12MO", "...-30"). Without this the stub lands with
    // size=NULL and downstream color x size matrices (AR/RMA invoices) can't
    // place the line — it falls into the non-matrix "other lines" bucket even
    // though the size is right there in the code. Only sets it when a token is
    // actually present, so style+color rollup stubs (canonStyleColor input)
    // stay size-less. is_apparel remains false so apparel_dims_required (which
    // only fires when is_apparel=true) can't reject the row for missing
    // inseam/length/fit.
    const parsedSize = parseSizeSuffix(canonicalSku);
    if (parsedSize) row.size = parsedSize;
  } else {
    row.color = overrides.colorDisplay ?? color;
    if (overrides.unit_cost != null) row.unit_cost = overrides.unit_cost;
    if (overrides.unit_price != null) row.unit_price = overrides.unit_price;
    if (overrides.external_refs) row.external_refs = overrides.external_refs;
    const desc = overrides.description != null ? String(overrides.description).trim() : "";
    if (desc) row.description = desc;
  }
  return row;
}
