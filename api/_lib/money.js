// api/_lib/money.js
//
// Decimal-safe money handling for vendor portal handlers.
//
// CLAUDE.md mandates: "Money fields: numeric/decimal, never float."
// JS `Number()` coerces strings like "1234.56" through IEEE-754, so
// "0.1 + 0.2" yields 0.30000000000000004 and a 2-decimal money string
// can round-trip with a different value. We avoid that by:
//
//   1. Validating the input matches a strict money-like regex.
//   2. Sending the value as a STRING to PostgREST (which parses it
//      directly into the Postgres numeric type — exact decimal arith).
//   3. Refusing NaN, Infinity, comma-thousand-separator strings, and
//      values with more than 4 decimal places (Postgres numeric(12,4)
//      caps the line-item precision in this schema).
//
// The helpers return either a string ("12.34") suitable for PostgREST
// JSON, or null when the field was omitted, or throw a `MoneyError`
// when the input is malformed — caller maps that to a 400.
//
// Path prefixed with _ so Vercel does not treat it as a function.

export class MoneyError extends Error {
  constructor(field, message) {
    super(`${field}: ${message}`);
    this.field = field;
    this.code = "INVALID_MONEY";
  }
}

const MONEY_RE = /^-?\d{1,12}(\.\d{1,4})?$/;

// Coerce arbitrary input (string | number | null | undefined) into a
// canonical decimal string suitable for PostgREST's JSON encoder.
// Returns null when the value is intentionally absent (null/undefined/"").
// Throws MoneyError on garbage. Use for vendor-portal handlers where
// CLAUDE.md mandates numeric/decimal money handling.
export function toMoneyString(value, fieldName = "amount") {
  if (value == null || value === "") return null;
  // Strip whitespace; reject thousand-separators and currency glyphs
  // before they sneak through Number() as NaN.
  const raw = typeof value === "number"
    ? (Number.isFinite(value) ? value.toString() : "")
    : String(value).trim();
  if (!raw) throw new MoneyError(fieldName, "empty after trim");
  // Common upstream artifacts: "$1,234.56", "1 234.56", "(123.45)" for
  // negative — none are accepted. The vendor must send canonical decimal.
  if (/[,\s]/.test(raw)) throw new MoneyError(fieldName, "must not contain spaces or commas");
  if (!MONEY_RE.test(raw)) throw new MoneyError(fieldName, "must be a decimal string with at most 4 fractional digits");
  // Normalize to canonical form (strip leading zeros, force at most 4
  // decimal places). Doing this via parseFloat then toFixed is unsafe
  // for very large values; we keep the input as-is once it matches the
  // regex.
  return raw;
}

// Returns true when value is null/undefined/"" — caller can treat as
// "field not provided" without invoking toMoneyString.
export function isAbsent(value) {
  return value == null || value === "";
}
