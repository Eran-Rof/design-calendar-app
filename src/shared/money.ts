// src/shared/money.ts
//
// Canonical money formatting — every $ amount in the app shows EXACTLY two
// decimals (e.g. 15 → "15.00", 1234.5 → "1,234.50"). Use this for any monetary
// display so decimals never vary (no whole-dollar rounding, no 1-decimal, etc.).
// NOT for quantities, percentages, weights (kg) or CBM — those keep their own
// formatting.

const MONEY_2DP: Intl.NumberFormatOptions = { minimumFractionDigits: 2, maximumFractionDigits: 2 };

/** Format a dollar amount with thousands separators and exactly 2 decimals. */
export function fmtMoney(n: number | string | null | undefined): string {
  const x = typeof n === "number" ? n : Number(String(n ?? "").replace(/,/g, ""));
  return (Number.isFinite(x) ? x : 0).toLocaleString(undefined, MONEY_2DP);
}

/** Same as fmtMoney but prefixed with "$". */
export function fmtUsd(n: number | string | null | undefined): string {
  return `$${fmtMoney(n)}`;
}

/** Format a CENTS integer as "$X.XX". */
export function fmtCentsUsd(cents: number | string | null | undefined): string {
  const c = typeof cents === "number" ? cents : Number(String(cents ?? "").replace(/,/g, ""));
  return fmtUsd((Number.isFinite(c) ? c : 0) / 100);
}
