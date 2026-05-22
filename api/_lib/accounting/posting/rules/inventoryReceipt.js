// api/_lib/accounting/posting/rules/inventoryReceipt.js
//
// Goods received from a vendor (PO receipt). Booked at receiving cost into a
// GR-IR clearing account; AP invoice match later clears GR-IR against AP.
//
// Accrual: DR inventory_account / CR gr_ir_account
// Cash:    none (cash basis recognizes cost at payment)

/**
 * @param {import('../types.js').PostingEvent} event
 *   event.data = {
 *     receipt_id: string,
 *     vendor_id: string,
 *     item_id: string,                 // SKU id for subledger tracking
 *     receipt_date: 'YYYY-MM-DD',
 *     amount: string,                  // total receipt value at cost
 *     inventory_account_id: string,
 *     gr_ir_account_id: string
 *   }
 * @returns {import('../types.js').PostingRuleOutput}
 */
export function inventoryReceipt(event) {
  const d = event.data;
  required(d, ["receipt_id", "vendor_id", "item_id", "receipt_date", "amount",
               "inventory_account_id", "gr_ir_account_id"]);

  const desc = `Inventory receipt ${d.receipt_id}`;

  const accrual = {
    entity_id: event.entity_id,
    basis: "ACCRUAL",
    journal_type: "inventory",
    posting_date: d.receipt_date,
    source_module: "inventory",
    source_table: "receipts",
    source_id: d.receipt_id,
    description: desc,
    created_by_user_id: event.created_by_user_id ?? null,
    lines: [
      {
        line_number: 1,
        account_id: d.inventory_account_id,
        debit: d.amount,
        credit: "0",
        memo: desc,
        subledger_type: "item",
        subledger_id: d.item_id,
      },
      {
        line_number: 2,
        account_id: d.gr_ir_account_id,
        debit: "0",
        credit: d.amount,
        memo: desc,
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
      throw new Error(`inventoryReceipt: data.${f} is required`);
    }
  }
}
