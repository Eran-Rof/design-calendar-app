// api/_lib/accounting/posting/rules/qcVendorCredit.js
//
// QC "vendor credit only" disposition. Defective units are credited by the
// vendor (a vendor credit memo reduces what we owe) and removed from inventory.
// The handler FIFO-consumes the units first to get the cost, then posts this at
// that amount:
//
//   DR AP (vendor subledger)   = credit amount (reduces the payable)
//   CR Inventory (item)        = same (the defective units leave the asset)
//
// Cash basis: none.

/**
 * @param {import('../types.js').PostingEvent} event
 *   event.data = {
 *     invoice_id,            // the vendor_credit_memo invoices row
 *     vendor_id, item_id,
 *     amount,                // decimal string — FIFO cost of the credited units
 *     ap_account_id, inventory_account_id,
 *     posting_date, memo?,
 *   }
 * @returns {import('../types.js').PostingRuleOutput}
 */
export function qcVendorCredit(event) {
  const d = event.data;
  required(d, ["invoice_id", "vendor_id", "item_id", "amount", "ap_account_id", "inventory_account_id", "posting_date"]);
  if (toCents(d.amount) <= 0n) throw new Error("qcVendorCredit: amount must be > 0");

  const desc = d.memo || `QC vendor credit ${d.invoice_id}`;
  const lines = [
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
      account_id: d.inventory_account_id,
      debit: "0",
      credit: d.amount,
      memo: desc,
      subledger_type: "item",
      subledger_id: d.item_id,
    },
  ];

  const accrual = {
    entity_id: event.entity_id,
    basis: "ACCRUAL",
    journal_type: "ap_credit_memo",
    posting_date: d.posting_date,
    source_module: "ap",
    source_table: "invoices",
    source_id: d.invoice_id,
    description: desc,
    created_by_user_id: event.created_by_user_id ?? null,
    lines,
  };
  return { accrual, cash: null };
}

function required(obj, fields) {
  for (const f of fields) {
    if (obj?.[f] == null || obj[f] === "") {
      throw new Error(`qcVendorCredit: data.${f} is required`);
    }
  }
}
function toCents(amountStr) {
  const s = typeof amountStr === "string" ? amountStr : String(amountStr);
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`qcVendorCredit: invalid amount: ${amountStr}`);
  const [whole, frac = ""] = s.split(".");
  const padded = (frac + "00").slice(0, 2);
  const sign = whole.startsWith("-") ? -1n : 1n;
  return sign * (BigInt(whole.replace(/^-/, "")) * 100n + BigInt(padded));
}
