// ── GS1 GTIN-14 generation service ────────────────────────────────────────────
// Pure functions for check digit calculation and GTIN construction.
// The atomic DB counter increment is a separate async operation (supabaseGs1.ts).

import type { CompanySettings } from "../types";

// ── Check digit (GS1 Mod-10) ──────────────────────────────────────────────────
// Reference: https://www.gs1.org/services/check-digit-calculator/details
//
// Algorithm:
//   Given 13 digits (left to right), assign positions 13..1 from left to right.
//   Multiply each digit by 3 if its position (from right) is odd, else by 1.
//   Check digit = (10 − (sum mod 10)) mod 10
export function calculateGs1CheckDigit(digits13: string): number {
  if (digits13.length !== 13 || !/^\d{13}$/.test(digits13)) {
    throw new Error(`calculateGs1CheckDigit: expected 13 numeric digits, got "${digits13}" (len=${digits13.length})`);
  }
  let sum = 0;
  for (let i = 0; i < 13; i++) {
    const posFromRight = 13 - i;            // position 1 = rightmost
    const multiplier   = posFromRight % 2 === 1 ? 3 : 1;
    sum += parseInt(digits13[i], 10) * multiplier;
  }
  return (10 - (sum % 10)) % 10;
}

// ── Build a GTIN-14 string ─────────────────────────────────────────────────────
// indicatorDigit : single digit string, e.g. "1"
// gs1Prefix      : numeric string, e.g. "0310927"
// prefixLength   : length of gs1Prefix (used to determine item ref padding)
// itemReference  : integer item reference (user portion only, no prefix, no check)
//
// GTIN-14 layout:
//   [indicator_digit (1)][gs1_prefix (prefixLength)][item_ref (12-prefixLength)][check (1)]
//   Total = 14 digits
export function buildGtin14(
  indicatorDigit: string,
  gs1Prefix: string,
  prefixLength: number,
  itemReference: number
): string {
  if (!/^\d$/.test(indicatorDigit)) {
    throw new Error(`buildGtin14: indicator digit must be 0-9, got "${indicatorDigit}"`);
  }
  if (gs1Prefix.length !== prefixLength || !/^\d+$/.test(gs1Prefix)) {
    throw new Error(`buildGtin14: prefix "${gs1Prefix}" has length ${gs1Prefix.length}, expected ${prefixLength}`);
  }

  const itemRefLen = 12 - prefixLength;
  if (itemRefLen < 1) {
    throw new Error(`buildGtin14: prefixLength ${prefixLength} leaves no room for item reference`);
  }

  const maxRef = Math.pow(10, itemRefLen) - 1;
  if (itemReference < 1 || itemReference > maxRef) {
    throw new Error(`buildGtin14: item reference ${itemReference} out of range [1, ${maxRef}] for prefixLength ${prefixLength}`);
  }

  const itemRefStr = String(itemReference).padStart(itemRefLen, "0");
  const digits13   = `${indicatorDigit}${gs1Prefix}${itemRefStr}`;

  if (digits13.length !== 13) {
    throw new Error(`buildGtin14: constructed base has length ${digits13.length}, expected 13`);
  }

  const checkDigit = calculateGs1CheckDigit(digits13);
  return `${digits13}${checkDigit}`;
}

// ── Validate a complete GTIN-14 ───────────────────────────────────────────────
export function validateGtin14(gtin: string): boolean {
  if (!/^\d{14}$/.test(gtin)) return false;
  const expected = calculateGs1CheckDigit(gtin.slice(0, 13));
  return expected === parseInt(gtin[13], 10);
}

// ── Build GTIN from company settings + item reference ─────────────────────────
export function buildGtinFromSettings(settings: CompanySettings, itemReference: number): string {
  return buildGtin14(
    settings.gtin_indicator_digit,
    settings.gs1_prefix,
    settings.prefix_length,
    itemReference
  );
}

// ── Maximum item reference for a given prefix length ─────────────────────────
export function maxItemReference(prefixLength: number): number {
  return Math.pow(10, 12 - prefixLength) - 1;
}

// ── Format a GTIN-14 for human display (groups of 1-7-5-1) ───────────────────
export function formatGtin14Display(gtin: string): string {
  if (gtin.length !== 14) return gtin;
  return `${gtin[0]} ${gtin.slice(1, 8)} ${gtin.slice(8, 13)} ${gtin[13]}`;
}
