// api/_lib/accounting/posting/guards/balanced.js
//
// Σ(debit) = Σ(credit) per JournalEntryCandidate. Database trigger enforces
// this again at status='posted'; this guard fails fast in JS so we don't waste
// a round-trip on a JE that can't possibly post.
//
// Money handled as decimal strings (see api/_lib/money.js — float math would
// silently lose pennies). We compare via integer cents to avoid JS Number drift.

/**
 * @param {import('../types.js').JournalEntryCandidate} candidate
 * @returns {import('../types.js').GuardResult}
 */
export function checkBalanced(candidate) {
  if (!candidate || !Array.isArray(candidate.lines) || candidate.lines.length === 0) {
    return { ok: false, code: "no_lines", message: "Journal entry has no lines" };
  }

  let debit_cents = 0n;
  let credit_cents = 0n;

  for (const line of candidate.lines) {
    const d = toCents(line.debit, `line ${line.line_number} debit`);
    const c = toCents(line.credit, `line ${line.line_number} credit`);
    if (d > 0n && c > 0n) {
      return {
        ok: false,
        code: "line_two_sided",
        message: `Line ${line.line_number} has both debit and credit nonzero`,
      };
    }
    if (d < 0n || c < 0n) {
      return {
        ok: false,
        code: "negative_amount",
        message: `Line ${line.line_number} has a negative amount`,
      };
    }
    debit_cents += d;
    credit_cents += c;
  }

  if (debit_cents === 0n && credit_cents === 0n) {
    return { ok: false, code: "zero_totals", message: "All lines sum to zero" };
  }

  if (debit_cents !== credit_cents) {
    return {
      ok: false,
      code: "unbalanced",
      message: `Debits (${fmt(debit_cents)}) do not equal credits (${fmt(credit_cents)})`,
      details: { debit_cents: debit_cents.toString(), credit_cents: credit_cents.toString() },
    };
  }

  return { ok: true };
}

function toCents(s, fieldLabel) {
  if (s == null || s === "") return 0n;
  // Allow string ("12.34"), number, or BigInt-ish.
  const str = typeof s === "string" ? s.trim() : String(s);
  if (!/^-?\d{1,12}(\.\d{1,2})?$/.test(str)) {
    throw new Error(`${fieldLabel}: invalid money value "${s}"`);
  }
  const neg = str.startsWith("-");
  const u = neg ? str.slice(1) : str;
  const [whole, frac = ""] = u.split(".");
  const padded = (frac + "00").slice(0, 2);
  const cents = BigInt(whole) * 100n + BigInt(padded);
  return neg ? -cents : cents;
}

function fmt(cents) {
  const sign = cents < 0n ? "-" : "";
  const abs = cents < 0n ? -cents : cents;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${sign}${whole}.${frac}`;
}
