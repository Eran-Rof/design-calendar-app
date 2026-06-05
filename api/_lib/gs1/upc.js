// api/_lib/gs1/upc.js
//
// UPC-A (12-digit) minter for the GS1 company prefix.
//
// Layout:
//   [gs1_prefix (prefixLength)][item_reference (11 - prefixLength)][check (1)]
//   Total = 12 digits.
//
// The check digit is the standard UPC-A / GS1 mod-10:
//   sum( odd-position-from-right digit ×3 ) + sum( even-position-from-right ×1 )
//   check = (10 − sum mod 10) mod 10
// This matches the GTIN mod-10 used in src/gs1/services/gtinService.ts, applied
// to the first 11 digits.
//
// Uniqueness: the item reference is claimed from the SAME atomic counter the
// pack-GTIN minter uses (`gs1_claim_next_item_reference()` RPC on
// company_settings). The RPC increments under a row lock, so two concurrent
// mints can never receive the same value — every UPC number is used at most
// once for the lifetime of the company prefix. We never reuse or recycle a
// claimed reference, even on a downstream insert failure.
//
// Pure functions here — no DB. The atomic claim + insert lives in the
// style-master create handler (and mintUpcsForStyle below, which takes an
// already-supplied list of claimed references).

// GS1 mod-10 check digit over an arbitrary-length numeric string. Positions are
// numbered from the RIGHT (1 = rightmost data digit); odd → ×3, even → ×1.
function gs1Mod10(digits) {
  const n = digits.length;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const posFromRight = n - i; // leftmost char has the largest position
    sum += parseInt(digits[i], 10) * (posFromRight % 2 === 1 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

// Public: check digit for the 11 data digits of a UPC-A.
export function upcACheckDigit(digits11) {
  if (!/^\d{11}$/.test(digits11)) {
    throw new Error(`upcACheckDigit: expected 11 numeric digits, got "${digits11}" (len=${String(digits11).length})`);
  }
  return gs1Mod10(digits11);
}

// Build a valid 12-digit UPC-A from prefix + item reference.
//   prefixLength comes from company_settings.prefix_length (6..11).
//   itemReference must fit in (11 - prefixLength) digits, ≥ 1.
export function buildUpcA(gs1Prefix, prefixLength, itemReference) {
  if (gs1Prefix.length !== prefixLength || !/^\d+$/.test(gs1Prefix)) {
    throw new Error(`buildUpcA: prefix "${gs1Prefix}" has length ${gs1Prefix.length}, expected ${prefixLength}`);
  }
  const refLen = 11 - prefixLength;
  if (refLen < 1) {
    throw new Error(`buildUpcA: prefixLength ${prefixLength} leaves no room for an item reference (UPC-A is 12 digits)`);
  }
  const maxRef = Math.pow(10, refLen) - 1;
  if (!Number.isInteger(itemReference) || itemReference < 1 || itemReference > maxRef) {
    throw new Error(`buildUpcA: item reference ${itemReference} out of range [1, ${maxRef}] for prefix length ${prefixLength}`);
  }
  const base11 = `${gs1Prefix}${String(itemReference).padStart(refLen, "0")}`;
  return `${base11}${gs1Mod10(base11)}`;
}

// Build directly from a company_settings row.
export function buildUpcAFromSettings(settings, itemReference) {
  return buildUpcA(settings.gs1_prefix, settings.prefix_length, itemReference);
}

// Validate a 12-digit UPC-A (numeric + correct check digit).
export function validateUpcA(upc) {
  if (!/^\d{12}$/.test(upc)) return false;
  return gs1Mod10(upc.slice(0, 11)) === parseInt(upc[11], 10);
}

// Maximum number of distinct UPC item references available for a prefix length.
export function maxUpcItemReference(prefixLength) {
  return Math.pow(10, 11 - prefixLength) - 1;
}
