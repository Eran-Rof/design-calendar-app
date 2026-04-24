// ── GS1 GTIN-14 + SSCC-18 generation service ──────────────────────────────────
// Pure functions — no async, no side effects.
// Atomic DB counter operations live in supabaseGs1.ts.

import type { CompanySettings } from "../types";

// ── Internal: GS1 Mod-10 check digit for any N-digit string ──────────────────
// Assign positions N..1 from left to right.
// Odd positions from right → ×3; even → ×1.
// Check = (10 − sum mod 10) mod 10.
function gs1CheckDigit(digits: string): number {
  const n = digits.length;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const posFromRight = n - i;
    sum += parseInt(digits[i], 10) * (posFromRight % 2 === 1 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

// ── GTIN-14 ───────────────────────────────────────────────────────────────────

export function calculateGs1CheckDigit(digits13: string): number {
  if (digits13.length !== 13 || !/^\d{13}$/.test(digits13)) {
    throw new Error(
      `calculateGs1CheckDigit: expected 13 numeric digits, got "${digits13}" (len=${digits13.length})`
    );
  }
  return gs1CheckDigit(digits13);
}

// GTIN-14 layout:
//   [indicator_digit (1)][gs1_prefix (prefixLength)][item_ref (12-prefixLength)][check (1)]
export function buildGtin14(
  indicatorDigit: string,
  gs1Prefix: string,
  prefixLength: number,
  itemReference: number
): string {
  if (!/^\d$/.test(indicatorDigit))
    throw new Error(`buildGtin14: indicator digit must be 0-9, got "${indicatorDigit}"`);
  if (gs1Prefix.length !== prefixLength || !/^\d+$/.test(gs1Prefix))
    throw new Error(`buildGtin14: prefix "${gs1Prefix}" has length ${gs1Prefix.length}, expected ${prefixLength}`);

  const itemRefLen = 12 - prefixLength;
  if (itemRefLen < 1) throw new Error(`buildGtin14: prefixLength ${prefixLength} leaves no room for item reference`);

  const maxRef = Math.pow(10, itemRefLen) - 1;
  if (itemReference < 1 || itemReference > maxRef)
    throw new Error(`buildGtin14: item reference ${itemReference} out of range [1, ${maxRef}]`);

  const base13 = `${indicatorDigit}${gs1Prefix}${String(itemReference).padStart(itemRefLen, "0")}`;
  return `${base13}${gs1CheckDigit(base13)}`;
}

export function validateGtin14(gtin: string): boolean {
  if (!/^\d{14}$/.test(gtin)) return false;
  return gs1CheckDigit(gtin.slice(0, 13)) === parseInt(gtin[13], 10);
}

export function buildGtinFromSettings(settings: CompanySettings, itemReference: number): string {
  return buildGtin14(
    settings.gtin_indicator_digit,
    settings.gs1_prefix,
    settings.prefix_length,
    itemReference
  );
}

export function maxItemReference(prefixLength: number): number {
  return Math.pow(10, 12 - prefixLength) - 1;
}

export function formatGtin14Display(gtin: string): string {
  if (gtin.length !== 14) return gtin;
  // Groups: indicator | prefix | item-ref | check
  return `${gtin[0]} ${gtin.slice(1, 8)} ${gtin.slice(8, 13)} ${gtin[13]}`;
}

// ── SSCC-18 ───────────────────────────────────────────────────────────────────
// Layout:
//   [extension_digit (1)][gs1_prefix (N)][serial_ref (16-N)][check (1)]
//   Total = 18 digits
//
// Serial reference fills (16 - prefixLength) digits, left-padded with zeros.
// Check digit uses GS1 Mod-10 on first 17 digits (same algorithm as GTIN).

export function buildSscc18(
  extensionDigit: string,
  gs1Prefix: string,
  prefixLength: number,
  serialReference: number
): string {
  if (!/^\d$/.test(extensionDigit))
    throw new Error(`buildSscc18: extension digit must be 0-9, got "${extensionDigit}"`);
  if (gs1Prefix.length !== prefixLength || !/^\d+$/.test(gs1Prefix))
    throw new Error(`buildSscc18: prefix "${gs1Prefix}" has length ${gs1Prefix.length}, expected ${prefixLength}`);

  const serialLen = 16 - prefixLength;
  if (serialLen < 1) throw new Error(`buildSscc18: prefixLength ${prefixLength} leaves no room for serial reference`);

  const maxSerial = Math.pow(10, serialLen) - 1;
  if (serialReference < 1 || serialReference > maxSerial)
    throw new Error(`buildSscc18: serial reference ${serialReference} out of range [1, ${maxSerial}]`);

  const base17 = `${extensionDigit}${gs1Prefix}${String(serialReference).padStart(serialLen, "0")}`;
  if (base17.length !== 17)
    throw new Error(`buildSscc18: constructed base has length ${base17.length}, expected 17`);

  return `${base17}${gs1CheckDigit(base17)}`;
}

export function validateSscc18(sscc: string): boolean {
  if (!/^\d{18}$/.test(sscc)) return false;
  return gs1CheckDigit(sscc.slice(0, 17)) === parseInt(sscc[17], 10);
}

export function buildSsccFromSettings(settings: CompanySettings, serialReference: number): string {
  return buildSscc18(
    settings.sscc_extension_digit,
    settings.gs1_prefix,
    settings.prefix_length,
    serialReference
  );
}

// Maximum serial reference for a given GS1 prefix length
export function maxSerialReference(prefixLength: number): number {
  return Math.pow(10, 16 - prefixLength) - 1;
}

// Human-readable: "(00) ext+prefix serial check"
export function formatSscc18Display(sscc: string): string {
  if (sscc.length !== 18) return sscc;
  // Application identifier (00) + SSCC is the standard label format
  return `(00) ${sscc}`;
}
