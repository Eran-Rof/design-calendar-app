// api/_lib/accounting/posting/rules/arPaymentReceived.js
//
// Customer payment received.
//
// Accrual: DR cash_account / CR ar_account     (clears the AR receivable)
// Cash:    DR cash_account / CR revenue_account (cash basis recognizes revenue)

/**
 * @param {import('../types.js').PostingEvent} event
 *   event.data = {
 *     receipt_id: string,
 *     invoice_id?: string,
 *     customer_id: string,
 *     receipt_date: 'YYYY-MM-DD',
 *     amount: string,
 *     ar_account_id: string,
 *     cash_account_id: string,
 *     revenue_account_id: string,    // for the cash-basis side
 *     payment_reference?: string
 *   }
 * @returns {import('../types.js').PostingRuleOutput}
 */
export function arPaymentReceived(event) {
  const d = event.data;
  required(d, ["receipt_id", "customer_id", "receipt_date", "amount",
               "ar_account_id", "cash_account_id", "revenue_account_id"]);

  const desc = d.invoice_id
    ? `AR receipt for invoice ${d.invoice_id}${d.payment_reference ? ` (${d.payment_reference})` : ""}`
    : `AR receipt — on-account${d.payment_reference ? ` (${d.payment_reference})` : ""}`;

  const accrual = {
    entity_id: event.entity_id,
    basis: "ACCRUAL",
    journal_type: "ar_receipt",
    posting_date: d.receipt_date,
    source_module: "ar",
    source_table: "ar_receipts",
    source_id: d.receipt_id,
    description: desc,
    created_by_user_id: event.created_by_user_id ?? null,
    lines: [
      {
        line_number: 1,
        account_id: d.cash_account_id,
        debit: d.amount,
        credit: "0",
        memo: desc,
        subledger_type: null,
        subledger_id: null,
      },
      {
        line_number: 2,
        account_id: d.ar_account_id,
        debit: "0",
        credit: d.amount,
        memo: desc,
        subledger_type: "customer",
        subledger_id: d.customer_id,
      },
    ],
  };

  const cash = {
    entity_id: event.entity_id,
    basis: "CASH",
    journal_type: "ar_receipt",
    posting_date: d.receipt_date,
    source_module: "ar",
    source_table: "ar_receipts",
    source_id: d.receipt_id,
    description: desc,
    created_by_user_id: event.created_by_user_id ?? null,
    lines: [
      {
        line_number: 1,
        account_id: d.cash_account_id,
        debit: d.amount,
        credit: "0",
        memo: desc,
        subledger_type: null,
        subledger_id: null,
      },
      {
        line_number: 2,
        account_id: d.revenue_account_id,
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
      throw new Error(`arPaymentReceived: data.${f} is required`);
    }
  }
}
