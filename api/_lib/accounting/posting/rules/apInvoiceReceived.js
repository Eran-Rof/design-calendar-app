// api/_lib/accounting/posting/rules/apInvoiceReceived.js
//
// Vendor bill recognized (accrual side only). Cash basis recognizes expense
// at PAYMENT, not at bill receipt, so the cash JE for this event is null.
//
// Accrual: DR expense_account / CR ap_account (control account → subledger)
// Cash:    none

/**
 * @param {import('../types.js').PostingEvent} event
 *   event.data = {
 *     invoice_id: string,
 *     vendor_id: string,
 *     invoice_number: string,
 *     invoice_date: 'YYYY-MM-DD',   // used as posting_date
 *     amount: string,                // decimal string, e.g. "1234.56"
 *     ap_account_id: string,         // from vendor.default_gl_ap_account_id
 *     expense_account_id: string     // from vendor.default_gl_expense_account_id or line coding
 *   }
 * @returns {import('../types.js').PostingRuleOutput}
 */
export function apInvoiceReceived(event) {
  const d = event.data;
  required(d, ["invoice_id", "vendor_id", "invoice_number", "invoice_date", "amount", "ap_account_id", "expense_account_id"]);

  const accrual = {
    entity_id: event.entity_id,
    basis: "ACCRUAL",
    journal_type: "ap_invoice",
    posting_date: d.invoice_date,
    source_module: "ap",
    source_table: "invoices",
    source_id: d.invoice_id,
    description: `AP invoice ${d.invoice_number}`,
    created_by_user_id: event.created_by_user_id ?? null,
    lines: [
      {
        line_number: 1,
        account_id: d.expense_account_id,
        debit: d.amount,
        credit: "0",
        memo: `AP invoice ${d.invoice_number}`,
        subledger_type: null,
        subledger_id: null,
      },
      {
        line_number: 2,
        account_id: d.ap_account_id,
        debit: "0",
        credit: d.amount,
        memo: `AP invoice ${d.invoice_number}`,
        subledger_type: "vendor",
        subledger_id: d.vendor_id,
      },
    ],
  };

  return { accrual, cash: null };
}

function required(obj, fields) {
  for (const f of fields) {
    if (obj?.[f] == null || obj[f] === "") {
      throw new Error(`apInvoiceReceived: data.${f} is required`);
    }
  }
}
