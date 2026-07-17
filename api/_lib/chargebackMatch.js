// api/_lib/chargebackMatch.js
//
// Pure, deterministic helpers for the Chargeback Management module (#1744).
// These mirror, in JS, the exact normalization the auto-match migration
// (20260988000000_chargeback_management.sql) runs in SQL — kept here as a
// tested reference and reused by the dilution endpoint.
//
// HOUSE RULE (non-negotiable): matching is by EXACT normalized equality only.
// A token that resolves to 2+ invoices is left UNMATCHED. No fuzzy guessing —
// a wrong link is worse than no link.

/** Uppercase + strip every non-alphanumeric character. "ROF-I141259" → "ROFI141259". */
export function normalizeAlnum(s) {
  if (s == null) return "";
  return String(s).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Numeric-suffix key: only for a purely numeric item_num (optionally
 * zero-padded). Strips leading zeros. "00000010360" → "10360". Anything with a
 * non-digit character (e.g. "ROF-I141259", "0000403555_696759") → null.
 */
export function numericSuffix(s) {
  if (s == null) return null;
  const str = String(s).trim();
  if (!/^[0-9]+$/.test(str)) return null;
  const stripped = str.replace(/^0+/, "");
  return stripped === "" ? null : stripped;
}

/** The invoice-number's own suffix key: trailing digit-run, leading zeros stripped. */
export function invoiceSuffix(invoiceNumber) {
  if (invoiceNumber == null) return null;
  const m = String(invoiceNumber).match(/(\d+)\s*$/);
  if (!m) return null;
  const stripped = m[1].replace(/^0+/, "");
  return stripped === "" ? null : stripped;
}

/**
 * Build a lookup index over invoices for matching. Keys that map to 2+ distinct
 * invoice ids are marked AMBIGUOUS (value === null) so they never match.
 *
 * @param {Array<{id:string, invoice_number:string}>} invoices
 * @returns {{ byAlnum: Map<string,string|null>, bySuffix: Map<string,string|null> }}
 */
export function buildInvoiceIndex(invoices) {
  const byAlnum = new Map();
  const bySuffix = new Map();
  const add = (map, key, id) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, id);
    else if (map.get(key) !== id) map.set(key, null); // collision → ambiguous
  };
  for (const inv of invoices || []) {
    add(byAlnum, normalizeAlnum(inv.invoice_number), inv.id);
    add(bySuffix, invoiceSuffix(inv.invoice_number), inv.id);
  }
  return { byAlnum, bySuffix };
}

/**
 * Resolve one chargeback item_num to an invoice via the two disjoint,
 * unambiguous methods. Returns null when nothing matches OR the only candidate
 * key is ambiguous.
 *
 * @returns {{ invoiceId:string, method:'invoice_number_exact'|'invoice_number_suffix' } | null}
 */
export function matchChargeback(itemNum, index) {
  if (!index) return null;
  // 1. alnum full-string exact (handles prefixed item_num like "ROF-I141259")
  const alnumKey = normalizeAlnum(itemNum);
  if (alnumKey) {
    const hit = index.byAlnum.get(alnumKey);
    if (hit) return { invoiceId: hit, method: "invoice_number_exact" };
    if (hit === null) return null; // ambiguous → no match
  }
  // 2. numeric-suffix (zero-padded numeric item_num → invoice trailing digits)
  const suffixKey = numericSuffix(itemNum);
  if (suffixKey) {
    const hit = index.bySuffix.get(suffixKey);
    if (hit) return { invoiceId: hit, method: "invoice_number_suffix" };
  }
  return null;
}

// Raw Rosenthal reason codes that are NOT a customer deduction but the factor
// moving the FULL receivable back to us (recourse / credit-risk churn). See
// isFactorChurnChargeback below.
export const FACTOR_CHURN_REASON_CODES = new Set(["610"]);

/**
 * Is this factor row a "Manual Charge Back" (Rosenthal code 610) — i.e. the
 * factor recoursing the WHOLE invoice back to us, not a customer deduction?
 *
 * PROVEN from PROD (#1832): every code-610 row is a full-invoice amount (some
 * EXCEED the invoice), matched to an invoice the customer PAID IN FULL, and none
 * is ever reversed. Counting these as "chargeback deductions" wildly overstated
 * dilution (e.g. Macy's Backstage read 44% when its real customer dilution is
 * ~0%). They are excluded from the dilution rate — never deleted or rewritten.
 *
 * @param {{reason_code?:string|number|null, reason?:string|null}} row
 * @returns {boolean}
 */
export function isFactorChurnChargeback(row) {
  if (!row) return false;
  const code = row.reason_code == null ? "" : String(row.reason_code).trim();
  if (FACTOR_CHURN_REASON_CODES.has(code)) return true;
  const reason = row.reason == null ? "" : String(row.reason).toLowerCase();
  return /manual\s*charge\s*back/.test(reason);
}

/**
 * Pure dilution aggregation. Given chargeback rows (each with a resolved
 * customer_id, a period key, and signed amount_cents where POSITIVE = a
 * chargeback deduction and NEGATIVE = a creditback/recovery) and a gross-sales
 * map, produce per-group metrics.
 *
 * A row flagged `excluded: true` (factor receivable churn — see
 * isFactorChurnChargeback) is NOT counted in chargeback/creditback/net or the
 * dilution rate; its amount is tracked separately in `excluded_cents` so the UI
 * can surface it honestly.
 *
 * @param {Array<{group:string, label?:string, amount_cents:number, excluded?:boolean}>} rows
 * @param {Record<string, number>} grossByGroup  group key → gross sales cents
 * @returns {Array<{group,label,chargeback_cents,creditback_cents,excluded_cents,net_cents,gross_sales_cents,dilution_pct,count}>}
 */
export function aggregateDilution(rows, grossByGroup = {}) {
  const acc = new Map();
  for (const r of rows || []) {
    const g = r.group;
    if (g == null) continue;
    let a = acc.get(g);
    if (!a) { a = { group: g, label: r.label ?? g, chargeback_cents: 0, creditback_cents: 0, excluded_cents: 0, net_cents: 0, count: 0 }; acc.set(g, a); }
    const amt = Number(r.amount_cents) || 0;
    if (r.excluded) {
      a.excluded_cents += amt; // factor churn — recorded, not dilution
    } else if (amt > 0) {
      a.chargeback_cents += amt;
      a.net_cents += amt;
    } else if (amt < 0) {
      a.creditback_cents += amt;
      a.net_cents += amt;
    }
    a.count += 1;
    if (r.label != null) a.label = r.label;
  }
  const out = [];
  for (const a of acc.values()) {
    const gross = Number(grossByGroup[a.group]) || 0;
    out.push({
      ...a,
      gross_sales_cents: gross,
      // dilution rate = gross chargeback deductions / gross sales (standard chargeback rate)
      dilution_pct: gross > 0 ? Math.round((a.chargeback_cents / gross) * 10000) / 100 : null,
    });
  }
  // rank by gross deductions taken (biggest offenders first)
  out.sort((x, y) => y.chargeback_cents - x.chargeback_cents);
  return out;
}
