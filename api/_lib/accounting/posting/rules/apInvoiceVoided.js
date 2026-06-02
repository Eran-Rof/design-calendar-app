// api/_lib/accounting/posting/rules/apInvoiceVoided.js
//
// Void an AP invoice. Reverses the accrual JE (if posted). Reverses the cash
// JE too iff the invoice was paid (i.e. cash_je_id was set). If the invoice
// is already in 'reversed' or 'void' status, the rule emits no new JEs and
// the handler treats it as a no-op.
//
// Unlike the other rules in this module, this rule does NOT itself emit new
// journal-entry candidates — instead it returns a `reversals` array of JE
// ids that the posting service will hand to `reverseJournalEntry` after the
// guards short-circuit (there's nothing to balance-check for a reversal).
//
// Output shape:
//   { accrual: null, cash: null, reversals: string[] }
//
// `reversals` may be empty (already-void / never-posted) — that's a clean
// no-op, NOT an error. The handler can flip gl_status to 'void' regardless.

/**
 * @param {import('../types.js').PostingEvent} event
 *   event.data = {
 *     invoice_id: string,
 *     accrual_je_id?: string|null,   // current invoices.accrual_je_id (may be null)
 *     cash_je_id?: string|null,      // current invoices.cash_je_id (may be null)
 *     gl_status?: string,            // current invoices.gl_status; defaults 'posted'
 *   }
 * @returns {{ accrual: null, cash: null, reversals: string[] }}
 */
export function apInvoiceVoided(event) {
  const d = event.data;
  if (!d) {
    throw new Error("apInvoiceVoided: event.data is required");
  }
  if (!d.invoice_id) {
    throw new Error("apInvoiceVoided: data.invoice_id is required");
  }

  const status = d.gl_status || "posted";
  if (status === "reversed" || status === "void") {
    // Already done. Safe no-op.
    return { accrual: null, cash: null, reversals: [] };
  }

  if (status === "unposted" || status === "pending_approval") {
    // Nothing posted to GL yet — handler flips status to 'void' directly.
    return { accrual: null, cash: null, reversals: [] };
  }

  if (status !== "posted") {
    throw new Error(`apInvoiceVoided: cannot void an invoice in status '${status}'`);
  }

  const reversals = [];
  if (d.accrual_je_id) reversals.push(d.accrual_je_id);
  if (d.cash_je_id) reversals.push(d.cash_je_id);

  return { accrual: null, cash: null, reversals };
}
