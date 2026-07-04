// api/_lib/accounting/posting/rules/partInventoryReceipt.js
//
// Manufacturing PARTS received against a native purchase order (a
// 'manufacturing_part' PO). The parts side of a goods receipt: parts are booked
// into part inventory (1360) at cost against the GR/IR clearing account (2050),
// which the matched vendor AP bill later clears — identical in shape to the
// style-goods inventoryReceipt rule, but debiting 1360 (subledger=part) instead
// of the style inventory account.
//
//   DR 1360 Inventory-Parts   = received part cost (per part, subledger=part)
//   CR 2050 GR/IR-goods       = vendor PO cost      → cleared by the vendor AP bill
//
// Cash basis recognizes cost at payment, so the cash JE is null (mirrors
// inventoryReceipt). The part FIFO layers themselves are created by the receipt
// handler (createPartLayer, source_kind='po_receipt'); this rule only books GL.
//
// Idempotency: source_table='tanda_po_receipts', source_id=receipt_id. A given
// receipt is EITHER a style-goods receipt OR a part receipt (po_type gate), so
// this never collides with the inventoryReceipt rule for the same receipt.

/**
 * @param {import('../types.js').PostingEvent} event
 *   event.data = {
 *     receipt_id, vendor_id, receipt_date,
 *     part_inventory_account_id,   // DR — 1360 Inventory-Parts
 *     gr_ir_account_id,            // CR — 2050 GR/IR
 *     lines: [{ part_id, amount }],// per-part DR at received cost (decimal strings)
 *     goods_amount,                // CR total (decimal string) = Σ line amounts
 *   }
 */
export function partInventoryReceipt(event) {
  const d = event.data;
  required(d, ["receipt_id", "vendor_id", "receipt_date", "part_inventory_account_id", "gr_ir_account_id", "goods_amount"]);
  if (!Array.isArray(d.lines) || d.lines.length === 0) throw new Error("partInventoryReceipt: at least one part line is required");

  const desc = `Part receipt ${d.receipt_id}`;
  const lines = [];
  let n = 1;
  let drTotal = 0n;
  for (const ln of d.lines) {
    if (!ln || ln.part_id == null || ln.part_id === "" || ln.amount == null || ln.amount === "") {
      throw new Error("partInventoryReceipt: each line requires part_id + amount");
    }
    lines.push({
      line_number: n++, account_id: d.part_inventory_account_id,
      debit: ln.amount, credit: "0", memo: desc,
      subledger_type: "part", subledger_id: ln.part_id,
    });
    drTotal += toCents(ln.amount);
  }

  const goodsCents = toCents(d.goods_amount);
  lines.push({
    line_number: n++, account_id: d.gr_ir_account_id,
    debit: "0", credit: d.goods_amount, memo: `${desc} — GR/IR goods`,
    subledger_type: "vendor", subledger_id: d.vendor_id,
  });

  if (drTotal !== goodsCents) {
    throw new Error(`partInventoryReceipt: part DR (${drTotal}) != goods (${goodsCents}); line amounts must sum to goods_amount`);
  }

  const accrual = {
    entity_id: event.entity_id,
    basis: "ACCRUAL",
    journal_type: "inventory",
    posting_date: d.receipt_date,
    source_module: "inventory",
    source_table: "tanda_po_receipts",
    source_id: d.receipt_id,
    description: desc,
    created_by_user_id: event.created_by_user_id ?? null,
    lines,
  };
  return { accrual, cash: null };
}

function required(obj, fields) {
  for (const f of fields) {
    if (obj?.[f] == null || obj[f] === "") throw new Error(`partInventoryReceipt: data.${f} is required`);
  }
}
function toCents(amountStr) {
  const s = typeof amountStr === "string" ? amountStr : String(amountStr);
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`partInventoryReceipt: invalid amount: ${amountStr}`);
  const [whole, frac = ""] = s.split(".");
  const padded = (frac + "00").slice(0, 2);
  const sign = whole.startsWith("-") ? -1n : 1n;
  return sign * (BigInt(whole.replace(/^-/, "")) * 100n + BigInt(padded));
}
