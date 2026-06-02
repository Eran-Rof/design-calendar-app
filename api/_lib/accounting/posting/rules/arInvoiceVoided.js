// api/_lib/accounting/posting/rules/arInvoiceVoided.js
//
// Void an AR invoice (P4-2; arch §4.3). Mirror of apInvoiceVoided.js.
//
// Reverses the accrual JE (if posted). Reverses the cash JE too iff the
// invoice received payment (i.e. cash_je_id was set by arPaymentReceived).
// Status guards short-circuit:
//   - 'draft' / 'pending_approval' → never posted → empty reversals
//   - 'void' / 'reversed'          → already terminal → empty reversals (idempotent)
//   - 'sent' / 'partial_paid' / 'paid' / 'posted_historical' → reverse
//
// Output shape (identical contract to apInvoiceVoided):
//   { accrual: null, cash: null, reversals: string[] }
//
// postEvent recognizes the reversals[] shape and calls reverseJournalEntry()
// for each. The AR handler (P4-3) flips ar_invoices.gl_status='void' after
// the reversal completes, and the COGS-side FIFO restoreConsumption() runs
// inside reverseJournalEntry when source_table='ar_invoices' (P4-2 wires the
// restore call into the reverse path).
//
// `reason` is recorded by the handler on ar_invoices.notes; the rule itself
// does not need it because reverseJournalEntry derives the memo from the
// original JE.

/**
 * @param {import('../types.js').PostingEvent} event
 *   event.data = {
 *     invoice_id: string,                  // ar_invoice.id
 *     accrual_je_id?: string|null,
 *     cash_je_id?: string|null,
 *     gl_status?: string,                  // current ar_invoices.gl_status; defaults 'sent'
 *     reason?: string,                     // operator notes; informational
 *   }
 * @returns {{ accrual: null, cash: null, reversals: string[] }}
 */
export function arInvoiceVoided(event) {
  const d = event.data;
  if (!d) {
    throw new Error("arInvoiceVoided: event.data is required");
  }
  if (!d.invoice_id) {
    throw new Error("arInvoiceVoided: data.invoice_id is required");
  }

  const status = d.gl_status || "sent";

  // Already terminal — idempotent re-void is a clean no-op.
  if (status === "reversed" || status === "void") {
    return { accrual: null, cash: null, reversals: [] };
  }

  // Never posted — empty reversals; handler flips gl_status='void' directly.
  if (status === "draft" || status === "pending_approval") {
    return { accrual: null, cash: null, reversals: [] };
  }

  // Reversible statuses (P4-2 arch §3.2 ar_invoices.gl_status enum):
  //   sent | partial_paid | paid | posted_historical
  const reversibleStatuses = new Set(["sent", "partial_paid", "paid", "posted_historical"]);
  if (!reversibleStatuses.has(status)) {
    throw new Error(`arInvoiceVoided: cannot void an AR invoice in status '${status}'`);
  }

  const reversals = [];
  if (d.accrual_je_id) reversals.push(d.accrual_je_id);
  // Cash JE only exists if at least one receipt was applied (deferred cash
  // recognition runs at payment receipt). Reverse it too — the
  // reverseJournalEntry call generates negated lines so AR is undone.
  if (d.cash_je_id) reversals.push(d.cash_je_id);

  return { accrual: null, cash: null, reversals };
}
