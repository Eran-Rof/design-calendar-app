// api/_lib/prepack.js
//
// Plain-JS ESM mirror of src/shared/prepack/index.ts — re-implemented here
// because API handlers are ESM .js files and cannot import TypeScript sources
// directly. Keep in lockstep with the .ts original: same regex, same priority
// chain, same identity gate.
//
// Exports:
//   extractPpk(value)                                 → number | null
//   ppkMultiplier(color, size, description, style, sku) → number (≥1)

/**
 * Extract the PPK multiplier from a single string field.
 * Returns null when no "PPKn" pattern is present.
 *
 * Matches: "PPK24", "PPK 24", "PPK-24", "PPK_24", "PPK24-Black"
 * Does NOT match: "RYB059430PPK" (no number after PPK)
 */
export function extractPpk(value) {
  if (!value) return null;
  const m = String(value).match(/PPK[\s_-]*(\d+)/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Resolve the units-per-pack multiplier by checking each input field
 * in priority order. Returns 1 when no PPK token is found — callers
 * can divide cost / multiply qty unconditionally without a guard.
 *
 * Priority: color → size → description → style → sku
 *
 * Identity gate: sku, style, OR size must contain "PPK" before we'll
 * return a multiplier > 1 (description alone can carry a stray PPK token
 * on a non-prepack row that shares a style family with a prepack).
 *
 * @param {string|null|undefined} color
 * @param {string|null|undefined} size
 * @param {string|null|undefined} description
 * @param {string|null|undefined} style
 * @param {string|null|undefined} sku
 * @returns {number}
 */
export function ppkMultiplier(color, size, description, style, sku) {
  const skuLooksPpk  = !!sku   && /PPK/i.test(sku);
  const styleLooksPpk = !!style && /PPK/i.test(style);
  const sizeLooksPpk = !!size  && /PPK/i.test(size);
  if (!skuLooksPpk && !styleLooksPpk && !sizeLooksPpk) return 1;
  return (
    extractPpk(color)       ??
    extractPpk(size)        ??
    extractPpk(description) ??
    extractPpk(style)       ??
    extractPpk(sku)         ??
    1
  );
}

/**
 * Strip trailing PPK variant tokens from a style code so that
 * "RYB059430PPK24", "RYB059430PPK", and "RYB059430" all resolve
 * to the base style "RYB059430".
 *
 * Used by comp handlers to match PPK sales history rows against a
 * base-style costing line (which never carries the PPK suffix).
 *
 * @param {string} styleCode
 * @returns {string}
 */
export function baseStyle(styleCode) {
  if (!styleCode) return styleCode;
  // Remove an optional separator (-, _, space) followed by PPK + optional digits at end of string.
  return styleCode.replace(/[-_\s]*PPK\d*$/i, "").trim();
}
