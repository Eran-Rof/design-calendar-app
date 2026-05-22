// api/_lib/accounting/posting/rules/apInvoicePaid.js
//
// Payment of a previously-recognized AP invoice.
//
// Accrual: DR ap_account / CR cash_account     (clears the AP liability)
// Cash:    DR expense_account / CR cash_account (cash basis recognizes the
//          expense at payment time; if the invoice was never accrued in the
//          cash book, this is the first time the expense lands there)

/**
 * @param {import('../types.js').PostingEvent} event
 *   event.data = {
 *     payment_id: string,
 *     invoice_id: string,
 *     vendor_id: string,
 *     payment_date: 'YYYY-MM-DD',
 *     amount: string,
 *     ap_account_id: string,
 *     cash_account_id: string,
 *     expense_account_id: string,    // for the cash-basis side
 *     payment_reference?: string
 *   }
 * @returns {import('../types.js').PostingRuleOutput}
 */
export function apInvoicePaid(event) {
  const d = event.data;
  required(d, ["payment_id", "invoice_id", "vendor_id", "payment_date", "amount",
               "ap_account_id", "cash_account_id", "expense_account_id"]);

  const desc = `AP payment for invoice ${d.invoice_id}${d.payment_reference ? ` (${d.payment_reference})` : ""}`;

  const accrual = {
    entity_id: event.entity_id,
    basis: "ACCRUAL",
    journal_type: "ap_payment",
    posting_date: d.payment_date,
    source_module: "ap",
    source_table: "payments",
    source_id: d.payment_id,
    description: desc,
    created_by_user_id: event.created_by_user_id ?? null,
    lines: [
      {
        line_number: 1,
        account_id: d.ap_account_id,
        debit: d.amount,
        credit: "0",
        memo: desc,
        subledger_type: "vendor",
        subledger_id: d.vendor_id,
      },
      {
        line_number: 2,
        account_id: d.cash_account_id,
        debit: "0",
        credit: d.amount,
        memo: desc,
        subledger_type: null,
        subledger_id: null,
      },
    ],
  };

  const cash = {
    entity_id: event.entity_id,
    basis: "CASH",
    journal_type: "ap_payment",
    posting_date: d.payment_date,
    source_module: "ap",
    source_table: "payments",
    source_id: d.payment_id,
    description: desc,
    created_by_user_id: event.created_by_user_id ?? null,
    lines: [
      {
        line_number: 1,
        account_id: d.expense_account_id,
        debit: d.amount,
        credit: "0",
        memo: desc,
        subledger_type: null,
        subledger_id: null,
      },
      {
        line_number: 2,
        account_id: d.cash_account_id,
        debit: "0",
        credit: d.amount,
        memo: desc,
        subledger_type: null,
        subledger_id: null,
      },
    ],
  };

  return { accrual, cash };
}

function required(obj, fields) {
  for (const f of fields) {
    if (obj?.[f] == null || obj[f] === "") {
      throw new Error(`apInvoicePaid: data.${f} is required`);
    }
  }
}
