// api/_lib/accounting/posting/rules/arInvoiceSent.js
//
// Customer invoice issued (accrual side only).
//
// Accrual: DR ar_account / CR revenue_account
// Cash:    none (cash basis recognizes revenue at payment receipt)
//
// TODO P4 (FIFO COGS on AR side, arch §4.5 row 2):
//   For each line with inventory_item_id set, call
//   inventoryFifoAPI.consume(supabase, { entity_id, item_id, qty,
//   consumer_kind: 'ar_invoice', consumer_ref_id: invoice_id, user_id }).
//   The returned cogs_cents per line is summed and emitted as an
//   ADDITIONAL JE pair on the same accrual entry:
//     DR cogs_account_id (subledger_type='item', subledger_id=item_id)
//     CR inventory_account_id (subledger_type='item', subledger_id=item_id)
//   On insufficient_inventory the rule throws PostingError('out_of_stock',...)
//   so the AR invoice handler can surface it to the operator before the JE
//   commits. The COGS-side persist runs inside the same postEvent flow so
//   the GL stays balanced.
//
//   Cash-twin handling: the cash basis posts COGS at AR PAYMENT receipt
//   (arPaymentReceived), not here. See arch §4.7. We'll add an
//   inventoryConsumption[] field to the cash branch at that time, mirroring
//   the inventoryLayers[] pattern P3-4 uses on the AP side.

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
