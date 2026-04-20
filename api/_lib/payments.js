// api/_lib/payments.js
//
// Pure helpers for the payments flow (status machine + validation).
//
//   nextStatus(current, action) → next status or throws
//   validatePaymentInput(body, { partial }) → string[]
//
// Status machine:
//   initiated  →  processing | cancelled
//   processing →  completed  | failed
//   completed  → (terminal)
//   failed     → (terminal)
//   cancelled  → (terminal)

export const PAYMENT_STATUSES = ["initiated", "processing", "completed", "failed", "cancelled"];
export const PAYMENT_METHODS  = ["ach", "wire", "virtual_card", "check", "paypal", "wise", "manual"];

const ALLOWED_TRANSITIONS = {
  initiated:  new Set(["processing", "cancelled"]),
  processing: new Set(["completed", "failed"]),
  completed:  new Set(),
  failed:     new Set(),
  cancelled:  new Set(),
};

export function nextStatus(current, action) {
  if (!ALLOWED_TRANSITIONS[current]) throw new Error(`Unknown current status: ${current}`);
  if (!ALLOWED_TRANSITIONS[current].has(action)) {
    throw new Error(`Cannot transition from ${current} → ${action}`);
  }
  return action;
}

export function validatePaymentInput(body, { partial = false } = {}) {
  const errs = [];
  if (!partial) {
    if (!body?.entity_id) errs.push("entity_id required");
    if (!body?.vendor_id) errs.push("vendor_id required");
    const amt = Number(body?.amount);
    if (!Number.isFinite(amt) || amt <= 0) errs.push("amount must be > 0");
  }
  if (body?.method !== undefined && !PAYMENT_METHODS.includes(body.method)) {
    errs.push(`method must be one of ${PAYMENT_METHODS.join(", ")}`);
  }
  if (body?.currency !== undefined && body.currency && String(body.currency).length !== 3) {
    errs.push("currency must be a 3-letter ISO code");
  }
  return errs;
}

export const PAYMENT_PREF_FX_MODES = ["pay_in_vendor_currency", "pay_in_usd_vendor_absorbs", "pay_in_usd_we_absorb"];

export function validatePreferenceInput(body) {
  const errs = [];
  if (body?.preferred_currency && String(body.preferred_currency).length !== 3) errs.push("preferred_currency must be a 3-letter ISO code");
  if (body?.preferred_payment_method && !PAYMENT_METHODS.includes(body.preferred_payment_method)) {
    errs.push(`preferred_payment_method must be one of ${PAYMENT_METHODS.join(", ")}`);
  }
  if (body?.fx_handling && !PAYMENT_PREF_FX_MODES.includes(body.fx_handling)) {
    errs.push(`fx_handling must be one of ${PAYMENT_PREF_FX_MODES.join(", ")}`);
  }
  return errs;
}
