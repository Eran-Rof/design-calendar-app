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

// ── Drill-through facets (#1744 audit drill) ────────────────────────────────
// Every dilution number is a sum over the SAME resolved chargeback set that
// dilution-summary aggregates. These pure helpers let the drill endpoint
// reproduce, for any aggregate cell, EXACTLY the constituent rows that sum to
// it — so any on-screen figure reconciles to the rows behind it, which in turn
// trace to their AR invoice and the GL journal entries that posted them.

// Aggregate dimensions the dilution tables render (a clickable row/cell).
export const DRILL_FACETS = ["total", "customer", "customer_month", "month", "reason"];
// The specific measure a clicked cell represents. `dilution` drills into the
// numerator (gross chargeback deductions); `gross_sales` drills to the AR
// invoices in the denominator (handled invoice-side by the endpoint).
export const DRILL_MEASURES = [
  "chargeback", "creditback", "excluded", "net", "count", "matched", "dilution", "gross_sales",
];

/**
 * Resolve one raw factor_chargebacks row to the grouping keys the dilution
 * aggregation uses: the effective customer (own customer_id, else the matched
 * invoice's), the YYYY-MM period, the governed reason group, the churn flag and
 * the signed amount. `reasonById` maps reason_code_id → { code }.
 *
 * @returns {{ id:string, cid:string|null, period:string|null, amount:number, excluded:boolean, reason_group:string }}
 */
export function resolveDrillRow(r, reasonById) {
  const excluded = isFactorChurnChargeback(r);
  const cid = r.customer_id || (r.matched && r.matched.customer_id) || null;
  const period = r.report_month ? String(r.report_month).slice(0, 7) : null;
  const amount = Number(r.amount_cents) || 0;
  const rc = r.reason_code_id && reasonById ? reasonById.get(r.reason_code_id) : null;
  const reason_group = excluded ? "__factor_churn__" : rc ? rc.code : "__uncoded__";
  return { id: r.id, cid, period, amount, excluded, reason_group };
}

/** Does a resolved row belong to the aggregate group (by, key)? */
export function drillRowInGroup(rr, by, key) {
  switch (by) {
    case "total": return true;
    case "customer": return rr.cid != null && rr.cid === key;
    case "customer_month": {
      const s = String(key);
      const i = s.indexOf("|");
      if (i < 0) return false;
      return rr.cid === s.slice(0, i) && rr.period === s.slice(i + 1);
    }
    case "month": return rr.period === key;
    case "reason": return rr.reason_group === key;
    default: return false;
  }
}

/**
 * Does a resolved row contribute to the clicked measure? Mirrors exactly the
 * sign/exclusion rules aggregateDilution applies, so the constituent list ties
 * to the number. `dilution` reuses the chargeback (numerator) rule.
 */
export function drillRowInMeasure(rr, measure) {
  switch (measure) {
    case "chargeback":
    case "dilution": return !rr.excluded && rr.amount > 0;
    case "creditback": return !rr.excluded && rr.amount < 0;
    case "excluded": return rr.excluded;
    case "net": return !rr.excluded;
    case "matched": return rr.cid != null;
    case "count": return true;
    default: return true;
  }
}

/**
 * Signed cents a row adds to the measure's reconciling sum. Returns 0 for
 * count/matched (which reconcile by row-count) and gross_sales (summed from the
 * AR invoices, not the chargeback rows).
 */
export function drillMeasureCents(rr, measure) {
  switch (measure) {
    case "chargeback":
    case "dilution": return !rr.excluded && rr.amount > 0 ? rr.amount : 0;
    case "creditback": return !rr.excluded && rr.amount < 0 ? rr.amount : 0;
    case "excluded": return rr.excluded ? rr.amount : 0;
    case "net": return rr.excluded ? 0 : rr.amount;
    default: return 0;
  }
}

// ── Net-open-by-document (#1848 true-exposure metric) ───────────────────────
// PROVEN from PROD (2026-07-19): 69% of the "Un-coded" gross chargeback figure
// was same-document chargeback/creditback churn — Rosenthal debits a document
// and re-credits the identical document number later (e.g. doc 573164:
// +$191,560 then −$191,560). Gross therefore overstates real exposure ~3×. The
// number worth managing is NET OPEN BY DOCUMENT: per document, gross deductions
// minus the credits posted against that same document, summed over documents
// still net-positive.

/**
 * Pure net-open-by-document aggregation. Groups rows by their exact trimmed
 * document number (`item_num` — no zero-stripping: "00000017565" and "17565"
 * are DIFFERENT Rosenthal documents) and nets signed amounts within each.
 *
 * Rows flagged `excluded: true` (factor receivable churn — see
 * isFactorChurnChargeback) are skipped entirely, mirroring aggregateDilution.
 *
 * @param {Array<{item_num?:string|null, amount_cents:number|string|null, cb_date?:string|null, excluded?:boolean}>} rows
 * @returns {{
 *   docs: Array<{doc:string, gross_cents:number, credit_cents:number, net_cents:number, count:number, first_date:string|null, last_date:string|null}>,
 *   doc_count:number, open_doc_count:number,
 *   gross_cents:number, credit_cents:number, offset_cents:number, net_open_cents:number,
 * }}  `docs` holds only net-positive (still-open) documents, largest first.
 *     gross = Σ positive amounts; credit = Σ negative amounts (signed);
 *     offset = Σ per-doc min(gross, |credits|) — the part of gross already
 *     cancelled by same-doc credits; net_open = Σ per-doc max(0, net).
 *     Invariant: gross_cents === offset_cents + net_open_cents (credits are
 *     never netted ACROSS documents — a credit only offsets its own doc).
 */
export function netOpenByDocument(rows) {
  const byDoc = new Map();
  for (const r of rows || []) {
    if (r && r.excluded) continue;
    const doc = String(r?.item_num ?? "").trim() || "(blank)";
    let d = byDoc.get(doc);
    if (!d) {
      d = { doc, gross_cents: 0, credit_cents: 0, net_cents: 0, count: 0, first_date: null, last_date: null };
      byDoc.set(doc, d);
    }
    const amt = Number(r?.amount_cents) || 0;
    if (amt > 0) d.gross_cents += amt;
    else if (amt < 0) d.credit_cents += amt;
    d.net_cents += amt;
    d.count += 1;
    const dt = r?.cb_date ? String(r.cb_date) : null;
    if (dt) {
      if (!d.first_date || dt < d.first_date) d.first_date = dt;
      if (!d.last_date || dt > d.last_date) d.last_date = dt;
    }
  }
  let gross_cents = 0, credit_cents = 0, offset_cents = 0, net_open_cents = 0, open_doc_count = 0;
  const open = [];
  for (const d of byDoc.values()) {
    gross_cents += d.gross_cents;
    credit_cents += d.credit_cents;
    offset_cents += Math.min(d.gross_cents, -d.credit_cents);
    if (d.net_cents > 0) {
      net_open_cents += d.net_cents;
      open_doc_count += 1;
      open.push(d);
    }
  }
  open.sort((a, b) => b.net_cents - a.net_cents);
  return { docs: open, doc_count: byDoc.size, open_doc_count, gross_cents, credit_cents, offset_cents, net_open_cents };
}
