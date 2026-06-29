// api/_lib/shopify/bulkMatch.js
//
// Match a Shopify product to a Tangerine style for the bulk image pull.
//
// Validated against the live catalog (2026-06-08): Shopify variant SKUs are
// `{STYLE_CODE}-{color}-{size}` (e.g. "RYG1674H-Steel-SML"), so the STYLE CODE
// is the SKU prefix before the first "-". 245/257 products matched exactly; the
// remaining denim products carry a 2-digit INSEAM suffix on the prefix
// (e.g. "RYB004330" → style "RYB0043") — stripping the trailing inseam catches
// those (→ ~256/257). Pure + dependency-free for unit testing.

/** The style-code candidate from a variant SKU: text before the first "-". */
export function styleCodeFromSku(sku) {
  if (!sku || typeof sku !== "string") return "";
  return sku.split("-")[0].trim();
}

/**
 * Resolve a SKU-prefix to a real style_code using the provided set of known
 * style codes (compared case-insensitively).
 *   1. exact match
 *   2. denim fallback: if the prefix ends in a 2-digit inseam, drop it and retry
 * @param {string} prefix     styleCodeFromSku output
 * @param {Set<string>} upperCodeSet  style_master.style_code values, UPPER-cased
 * @returns {string|null} the matched style_code (UPPER) or null
 */
export function resolveStyleCode(prefix, upperCodeSet) {
  if (!prefix) return null;
  const p = prefix.trim().toUpperCase();
  if (upperCodeSet.has(p)) return p;
  // Denim inseam suffix: strip a trailing 2 digits and retry (e.g. RYB004330 → RYB0043).
  if (/\d{2}$/.test(p)) {
    const base = p.slice(0, -2);
    if (base && upperCodeSet.has(base)) return base;
  }
  return null;
}

/**
 * Given a Shopify product (REST shape, with `variants[].sku`) and the known
 * style-code set, return the matched style_code or null. Tries each variant's
 * SKU prefix; first hit wins.
 */
export function matchProductToStyleCode(product, upperCodeSet) {
  const variants = (product && product.variants) || [];
  for (const v of variants) {
    const hit = resolveStyleCode(styleCodeFromSku(v && v.sku), upperCodeSet);
    if (hit) return hit;
  }
  return null;
}
