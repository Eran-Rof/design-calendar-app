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
// one-size markers (-OS/-OSFA/-O/S), and parenthesized ranges (-L(14-16) etc.).
const SIZE_SUFFIX_RE =
  /-(XS|XSM|S|SM|M|MD|L|LG|XL|XLG|XXL|XXLG|XXXL|XXXLG|SML|MED|LRG|OS|OSFA|O\/S|[0-9]+|[A-Z]+\([0-9X\-]+\))$/;

// Strip whitespace + uppercase. Used for hash-key matching (sku_code in DB).
export function canonSku(raw) {
  return (raw ?? "").toString().trim().toUpperCase().replace(/\s+/g, "");
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

// Build an ip_item_master row payload for a given SKU + optional source-
// specific overrides. Always sets style_code + color from sku_code so the
// grid's Style/Color columns populate consistently.
//
// `description` is only included when non-empty so we don't clobber a
// real description (e.g. from ATS) with null on a subsequent sync.
export function buildItemRow(canonicalSku, overrides = {}) {
  const { style, color } = parseStyleColor(canonicalSku);
  const row = {
    sku_code: canonicalSku,
    style_code: style,
    color: overrides.colorDisplay ?? color, // colorDisplay preserves source spacing
    uom: overrides.uom ?? "each",
    active: true,
    ...(overrides.unit_cost != null ? { unit_cost: overrides.unit_cost } : {}),
    ...(overrides.unit_price != null ? { unit_price: overrides.unit_price } : {}),
    ...(overrides.external_refs ? { external_refs: overrides.external_refs } : {}),
  };
  const desc = overrides.description != null ? String(overrides.description).trim() : "";
  if (desc) row.description = desc;
  return row;
}
