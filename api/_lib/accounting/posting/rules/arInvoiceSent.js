// api/_lib/accounting/posting/rules/arInvoiceSent.js
//
// Customer invoice issued (accrual side only).
//
// Accrual: DR ar_account / CR revenue_account
// Cash:    none (cash basis recognizes revenue at payment receipt)

/**
 * @param {import('../types.js').PostingEvent} event
 *   event.data = {
 *     invoice_id: string,
 *     customer_id: string,
 *     invoice_number: string,
 *     invoice_date: 'YYYY-MM-DD',
 *     amount: string,
 *     ar_account_id: string,
 *     revenue_account_id: string
 *   }
 * @returns {import('../types.js').PostingRuleOutput}
 */
export function arInvoiceSent(event) {
  const d = event.data;
  required(d, ["invoice_id", "customer_id", "invoice_number", "invoice_date", "amount",
               "ar_account_id", "revenue_account_id"]);

  const accrual = {
    entity_id: event.entity_id,
    basis: "ACCRUAL",
    journal_type: "ar_invoice",
    posting_date: d.invoice_date,
    source_module: "ar",
    source_table: "ar_invoices",
    source_id: d.invoice_id,
    description: `AR invoice ${d.invoice_number}`,
    created_by_user_id: event.created_by_user_id ?? null,
    lines: [
      {
        line_number: 1,
        account_id: d.ar_account_id,
        debit: d.amount,
        credit: "0",
        memo: `AR invoice ${d.invoice_number}`,
        subledger_type: "customer",
        subledger_id: d.customer_id,
      },
      {
        line_number: 2,
        account_id: d.revenue_account_id,
        debit: "0",
        credit: d.amount,
        memo: `AR invoice ${d.invoice_number}`,
        subledger_type: null,
        subledger_id: null,
      },
    ],
  };

  return { accrual, cash: null };
}

function required(obj, fields) {
  for (const f of fields) {
    if (obj?.[f] == null || obj[f] === "") {
      throw new Error(`arInvoiceSent: data.${f} is required`);
    }
  }
}
