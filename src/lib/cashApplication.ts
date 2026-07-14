// src/lib/cashApplication.ts
//
// Pure helpers for the cash-side subledger backfill (2026-07-14). These
// encode the SAME deterministic rules the operational SQL backfill uses
// (scripts/gl-rebuild/stage5_ar_receipts_backfill.sql and
// stage6_ap_payments_backfill.sql) so the logic can be unit-tested in
// isolation:
//
//   • parseArInvoiceRef  — AR "Invoice Payment" leg memo → invoice number.
//   • parseApBillPayment — AP "Bill Payment" leg memo → { billNumber, cents }.
//   • magnitudeCents     — dollars → round(abs × 100) integer cents.
//   • allocateInvoiceApplications — clamp cumulative applications to an
//     invoice total, PARKING the excess (never silently dropping it).
//   • overApplicationCents — Σ legs − total, floored at 0.
//
// Every rule is EXACT-MATCH only: an unparseable / ambiguous memo yields
// null (the payment is parked as unapplied and reported), never a guess.

/**
 * Parse an AR Invoice-Payment leg memo of the exact form
 * `Invoice Ref # <invoice_number>` → the trimmed invoice number.
 * Anything else (cash leg, blank, dilution/chargeback leg) → null.
 */
export function parseArInvoiceRef(memo: string | null | undefined): string | null {
  if (memo == null) return null;
  const m = /^Invoice Ref # (.+)$/.exec(String(memo));
  if (!m) return null;
  const num = m[1].trim();
  return num.length > 0 ? num : null;
}

/**
 * Parse an AP Bill-Payment leg memo of the form
 * `...Bill# <bill_number> Amount Paid <amount>...` → the bill number and the
 * paid amount in integer cents. Non-matching memos → null.
 *
 * The bill number is the non-greedy run between `Bill#` and ` Amount Paid`
 * (matches the SQL `substring(memo from 'Bill#\s*(.+?)\s+Amount Paid')`).
 */
export function parseApBillPayment(
  memo: string | null | undefined,
): { billNumber: string; amountPaidCents: number } | null {
  if (memo == null) return null;
  const s = String(memo);
  const m = /Bill#\s*(.+?)\s+Amount Paid\s+(-?\d+(?:\.\d+)?)/.exec(s);
  if (!m) return null;
  const billNumber = m[1].trim();
  if (billNumber.length === 0) return null;
  return { billNumber, amountPaidCents: magnitudeCents(Number(m[2])) };
}

/**
 * Dollars → integer cents on the amount's MAGNITUDE (payment legs carry the
 * relief as a negative, so the subledger amount is always the absolute
 * value). Mirrors SQL `round(abs(amount_home) * 100)`.
 */
export function magnitudeCents(amount: number | string | null | undefined): number {
  const n = Number(amount);
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.abs(n) * 100);
}

export interface AllocatedLeg {
  appliedCents: number;
  parkedCents: number;
}

/**
 * Allocate a sequence of same-invoice payment legs against the invoice
 * total, clamping the CUMULATIVE applied amount to the total. Legs must be
 * passed in application order (caller sorts by receipt date then txn id).
 * Each leg's excess over remaining capacity is PARKED (returned, and logged
 * to cashside_backfill_exceptions by the backfill) rather than dropped.
 *
 * Matches the SQL window:
 *   applied = greatest(0, least(amt, total − Σ(prior leg amts)))
 * i.e. capacity is measured against the running sum of ORIGINAL leg amounts,
 * so a later leg is fully parked once earlier legs have filled the invoice.
 */
export function allocateInvoiceApplications(
  legCents: number[],
  invoiceTotalCents: number,
): AllocatedLeg[] {
  const out: AllocatedLeg[] = [];
  let priorSum = 0;
  for (const amt of legCents) {
    const capacity = invoiceTotalCents - priorSum;
    const applied = Math.max(0, Math.min(amt, capacity));
    out.push({ appliedCents: applied, parkedCents: amt - applied });
    priorSum += amt;
  }
  return out;
}

/**
 * Total over-application (Σ leg magnitudes − invoice total), floored at 0.
 * A positive result is the amount that will be parked across the invoice's
 * legs by allocateInvoiceApplications.
 */
export function overApplicationCents(legCents: number[], invoiceTotalCents: number): number {
  const sum = legCents.reduce((a, b) => a + b, 0);
  return Math.max(0, sum - invoiceTotalCents);
}
