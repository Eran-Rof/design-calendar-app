// api/_lib/scf.js
//
// Pure helpers for the Supply Chain Finance flow.
//
//   calculateFee({ amount, baseRatePct, daysToDue })
//     → { fee_pct, fee_amount, net_disbursement }
//   hasCapacity(program, requestedAmount) → boolean
//   isInvoiceEligible(invoice, existingRequests) → { ok, reason }
//   nextStatus(current, action) → next status, throws on illegal transition
//
// Fee model: linear proration of the annual base rate to the financing window.
//   fee_pct   = base_rate_pct * (days_to_due / 365)
//   fee_amt   = amount * fee_pct / 100
//   net       = amount - fee_amt

export const STATUSES = ["requested", "approved", "funded", "repaid", "rejected"];

const ALLOWED = {
  requested: new Set(["approved", "rejected"]),
  approved:  new Set(["funded", "rejected"]),
  funded:    new Set(["repaid"]),
  repaid:    new Set(),
  rejected:  new Set(),
};

export function nextStatus(current, action) {
  if (!ALLOWED[current]) throw new Error(`Unknown current status: ${current}`);
  if (!ALLOWED[current].has(action)) throw new Error(`Cannot transition from ${current} → ${action}`);
  return action;
}

export function round2(n) { return Math.round(n * 100) / 100; }
export function round4(n) { return Math.round(n * 10000) / 10000; }

export function calculateFee({ amount, baseRatePct, daysToDue }) {
  const safeDays = Math.max(0, Number(daysToDue) || 0);
  const amt = Number(amount) || 0;
  const rate = Number(baseRatePct) || 0;
  const fee_pct = round4((rate * safeDays) / 365);
  const fee_amount = round2((amt * fee_pct) / 100);
  const net_disbursement = round2(amt - fee_amount);
  return { fee_pct, fee_amount, net_disbursement };
}

export function daysToDueDate(dueDate, now = new Date()) {
  if (!dueDate) return 0;
  const ms = new Date(`${dueDate}T00:00:00Z`).getTime() - now.getTime();
  return Math.max(0, Math.round(ms / 86400000));
}

export function hasCapacity(program, requestedAmount) {
  if (!program || program.status !== "active") return false;
  const used = Number(program.current_utilization) || 0;
  const max  = Number(program.max_facility_amount) || 0;
  const req  = Number(requestedAmount) || 0;
  return used + req <= max;
}

export function isInvoiceEligible(invoice, existingRequests) {
  if (!invoice) return { ok: false, reason: "invoice_not_found" };
  if (invoice.status !== "approved") return { ok: false, reason: "invoice_not_approved" };
  const active = (existingRequests || []).find((r) => r.status !== "rejected" && r.invoice_id === invoice.id);
  if (active) return { ok: false, reason: "already_financed" };
  return { ok: true };
}

// Apply an approval: compute the approved_amount + fee + update program utilization (in-memory).
// Returns { patch, programPatch } so the caller can persist atomically.
export function planApproval({ program, request, invoice, approved_amount, fee_pct_override = null, now = new Date() }) {
  const amt = Math.min(Number(approved_amount) || Number(request.requested_amount), Number(request.requested_amount));
  const days = daysToDueDate(invoice?.due_date, now);
  const fee = fee_pct_override != null
    ? { fee_pct: round4(Number(fee_pct_override)), fee_amount: round2((amt * Number(fee_pct_override)) / 100), net_disbursement: round2(amt - (amt * Number(fee_pct_override)) / 100) }
    : calculateFee({ amount: amt, baseRatePct: program.base_rate_pct, daysToDue: days });

  return {
    patch: {
      status: "approved",
      approved_amount: amt,
      fee_pct: fee.fee_pct,
      fee_amount: fee.fee_amount,
      net_disbursement: fee.net_disbursement,
      approved_at: now.toISOString(),
      updated_at: now.toISOString(),
      // Default repayment due = invoice due_date; can be overridden by caller
      repayment_due_date: invoice?.due_date || null,
    },
    programPatch: null, // utilization is bumped at fund time, not approve
  };
}
