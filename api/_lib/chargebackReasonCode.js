// api/_lib/chargebackReasonCode.js
//
// Pattern-based auto-coding for the Chargeback Management module (#1744).
// Maps a raw Rosenthal reason string to one of the 14 governed reason `code`s
// in chargeback_reason_codes (see migration 20260988000000_chargeback_management.sql).
//
// WHY: the manual PATCH /api/internal/chargebacks/:id is the only per-row writer
// of reason_code_id, and the migration's literal map covers just 10 exact
// strings — so ~$740K of book stays un-coded. This generalizes each literal to a
// case-insensitive keyword/pattern so new reasons classify at ingest without a
// human touching every row.
//
// HOUSE RULE (mirrors chargebackMatch.js): a wrong code is worse than none. Each
// rule is a deliberate keyword; anything that matches no rule returns null and
// stays un-coded. Factor-churn rows (reason_code 610 / "Manual Charge Back") are
// NEVER mapped — they are intentionally excluded from dilution.
//
// Rule ORDER matters: the more specific reason wins (e.g. "Short Pay" before the
// generic "short"; "Packing Violation" before the generic "violation"; a
// return-to-vendor before a plain return). First match wins.

import { isFactorChurnChargeback } from "./chargebackMatch.js";

// Ordered [code, RegExp] rules. Derived from the 14 seeded codes and the 10
// literal mappings in the migration, each literal generalized to a pattern:
//   'Short Pay (Inv/Ck Difference)' → shortpay   'Discount taken …' → discount
//   'Packing Violation' → packing                'Freight' → freight
//   'Warehouse Allowance' → pricing              'Processing Charge' → fees
//   'Return/refused' → returns                   'No Reason Given' → unknown
//   'Miscellaneous' / 'Miscellaneous credit …' → misc
const RULES = [
  // ── pricing family (three distinct codes — most specific first) ──
  ["shortpay",   /short\s*pay|inv.*c[kh].*diff|invoice.*check.*diff|inv\/ck/i],
  ["discount",   /discount|unearned|anticipation/i],
  // ── shortage / non-receipt ──
  ["shortage",   /shortage|short\s*ship|short\b|non[-\s]*receipt|not\s*received|missing\s*(goods|units|cartons)/i],
  // ── markdown / margin allowance ──
  ["markdown",   /mark\s*down|markdown|mkdn|margin\s*(allow|agreement)|gross\s*margin|md\b/i],
  // ── packing / carton (before the generic compliance "violation") ──
  ["packing",    /packing|carton|pack\s*(violation|slip)|ucc\s*128|mis[-\s]*pack/i],
  // ── compliance / vendor violation ──
  ["compliance", /compliance|violation|charge\s*back\s*fine|chgbk\s*fine|vendor\s*(guide|manual|fine)|asn\b|edi\b|routing\s*guide|label|ticket|handling\s*(violation|fine)/i],
  // ── freight / routing ──
  ["freight",    /freight|fedex|\bups\b|routing|carrier|\bltl\b|drayage|prepaid.*freight|collect.*freight/i],
  // ── advertising / co-op ──
  ["coop",       /co[-\s]*op|coop|advertis|\bmdf\b|marketing\s*(fund|allow)|promo(tion)?\s*allow/i],
  // ── defective / return-to-vendor (before the generic "return") ──
  ["defective",  /defective|defect|damage|damaged|\brtv\b|return\s*to\s*vendor|quality/i],
  // ── return / refused merchandise ──
  ["returns",    /return|refused|refusal|\brtn\b|rejected\s*merch/i],
  // ── pricing / allowance (generic price differences & warehouse allowance) ──
  ["pricing",    /pricing|price\s*(diff|discrepan|adjust)|allowance|warehouse\s*allow|deal\s*(diff|price)|cost\s*diff/i],
  // ── interest / processing fees ──
  ["fees",       /processing|\bfee(s)?\b|interest|finance\s*charge|service\s*charge|admin\s*charge|bank\s*charge/i],
  // ── unknown / no reason given ──
  ["unknown",    /no\s*reason|unknown|not\s*given|unspecified/i],
  // ── miscellaneous (last catch for the explicit "misc" label only) ──
  ["misc",       /miscellaneous|\bmisc\b/i],
];

/**
 * Map a raw reason string to a governed reason-code `code`, or null when no
 * rule matches (leave un-coded). Optionally pass the raw 3-digit reason_code so
 * factor-churn rows (610) are declined even when the reason text is atypical.
 *
 * @param {string|null|undefined} reason  the raw Rosenthal reason string
 * @param {string|number|null} [rawReasonCode]  the raw reason_code (e.g. "610")
 * @returns {string|null}  a chargeback_reason_codes.code, or null
 */
export function mapReasonToCode(reason, rawReasonCode = null) {
  const text = reason == null ? "" : String(reason).trim();
  if (!text) return null;
  // Never classify factor-churn — it is intentionally excluded from dilution.
  if (isFactorChurnChargeback({ reason: text, reason_code: rawReasonCode })) return null;
  for (const [code, re] of RULES) {
    if (re.test(text)) return code;
  }
  return null;
}

// Exposed for tests / callers that want the ordered rule set.
export const REASON_CODE_RULES = RULES.map(([code, re]) => ({ code, pattern: re.source }));
