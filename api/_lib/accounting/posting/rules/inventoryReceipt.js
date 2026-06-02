// api/_lib/accounting/posting/rules/inventoryReceipt.js
//
// Goods received from a vendor (PO receipt). Booked into inventory at landed
// cost against clearing accounts that the later vendor + rollup AP invoices
// settle — so goods (and capitalized freight/duty) are never double-counted.
//
//   DR Inventory                 = landed total (goods + capitalized rollups)
//   CR GR/IR-goods (2050)         = vendor PO goods cost      → cleared by the matched vendor AP invoice
//   CR Accrued Landed (2150)      = capitalized rollup total  → cleared by the rollup AP invoices
//
// Cash basis recognizes cost at payment, so the cash JE is null.
//
// Two payload shapes are supported:
//   1. Single-amount (legacy/simple): event.data.amount + item_id +
//      inventory_account_id + gr_ir_account_id. One DR inventory line + one
//      CR GR/IR line. (No landed split.)
//   2. Multi-line (P13 GL-C1): event.data.lines = [{ item_id, amount }] (per-SKU
//      DR inventory at landed cost) + goods_amount (CR GR/IR-goods total) +
//      gr_ir_account_id, and OPTIONALLY accrued_landed_amount (CR Accrued
//      Landed total) + accrued_landed_account_id when capitalized rollups
//      exist. inventory_account_id is the asset account every DR line hits.

/**
 * @param {import('../types.js').PostingEvent} event
 *   Single-amount shape: data = {
 *     receipt_id, vendor_id, item_id, receipt_date, amount,
 *     inventory_account_id, gr_ir_account_id }
 *   Multi-line shape: data = {
 *     receipt_id, vendor_id, receipt_date,
 *     inventory_account_id, gr_ir_account_id,
 *     lines: [{ item_id, amount }],          // per-SKU landed DR
 *     goods_amount: string,                  // CR GR/IR-goods total
 *     accrued_landed_amount?: string,        // CR Accrued Landed total (rollups)
 *     accrued_landed_account_id?: string,    // required when accrued_landed_amount > 0
 *     source_table?: string }                // defaults to 'tanda_po_receipts' for multi-line
 * @returns {import('../types.js').PostingRuleOutput}
 */
export function inventoryReceipt(event) {
  const d = event.data;
  const desc = `Inventory receipt ${d.receipt_id}`;
  const useMultiLine = Array.isArray(d.lines) && d.lines.length > 0;

  let lines;
  let sourceTable;
  if (useMultiLine) {
    required(d, ["receipt_id", "vendor_id", "receipt_date",
                 "inventory_account_id", "gr_ir_account_id", "goods_amount"]);
    sourceTable = d.source_table || "tanda_po_receipts";

    lines = [];
    let lineNumber = 1;
    let drTotal = 0n;
    for (const ln of d.lines) {
      if (!ln || ln.item_id == null || ln.item_id === "" || ln.amount == null || ln.amount === "") {
        throw new Error("inventoryReceipt: each line requires item_id + amount");
      }
      lines.push({
        line_number: lineNumber++,
        account_id: d.inventory_account_id,
        debit: ln.amount,
        credit: "0",
        memo: desc,
        subledger_type: "item",
        subledger_id: ln.item_id,
      });
      drTotal += toCents(ln.amount);
    }

    // CR GR/IR-goods (vendor PO cost) — cleared by the matched vendor AP invoice.
    const goodsCents = toCents(d.goods_amount);
    lines.push({
      line_number: lineNumber++,
      account_id: d.gr_ir_account_id,
      debit: "0",
      credit: d.goods_amount,
      memo: `${desc} — GR/IR goods`,
      subledger_type: "vendor",
      subledger_id: d.vendor_id,
    });

    // CR Accrued Landed (capitalized rollups) — cleared by the rollup AP invoices.
    let accruedCents = 0n;
    if (d.accrued_landed_amount != null && d.accrued_landed_amount !== "" && toCents(d.accrued_landed_amount) > 0n) {
      if (!d.accrued_landed_account_id) {
        throw new Error("inventoryReceipt: accrued_landed_account_id required when accrued_landed_amount > 0");
      }
      accruedCents = toCents(d.accrued_landed_amount);
      lines.push({
        line_number: lineNumber++,
        account_id: d.accrued_landed_account_id,
        debit: "0",
        credit: d.accrued_landed_amount,
        memo: `${desc} — accrued landed cost`,
        subledger_type: null,
        subledger_id: null,
      });
    }

    // Guard: DR landed total must equal CR (goods + accrued landed). The
    // balanced-guard in postEvent enforces this at the DB too, but failing here
    // gives a clearer message tied to the receipt's own numbers.
    if (drTotal !== goodsCents + accruedCents) {
      throw new Error(
        `inventoryReceipt: landed DR (${drTotal}) != goods (${goodsCents}) + accrued landed (${accruedCents}); ` +
        `allocate rollups so the per-line landed costs sum to goods + capitalized rollups`,
      );
    }
  } else {
    required(d, ["receipt_id", "vendor_id", "item_id", "receipt_date", "amount",
                 "inventory_account_id", "gr_ir_account_id"]);
    sourceTable = d.source_table || "receipts";
    lines = [
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
    ];
  }

  const accrual = {
    entity_id: event.entity_id,
    basis: "ACCRUAL",
    journal_type: "inventory",
    posting_date: d.receipt_date,
    source_module: "inventory",
    source_table: sourceTable,
    source_id: d.receipt_id,
    description: desc,
    created_by_user_id: event.created_by_user_id ?? null,
    lines,
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

// decimal-string -> bigint(cents).
function toCents(amountStr) {
  const s = typeof amountStr === "string" ? amountStr : String(amountStr);
  if (!/^-?\d+(\.\d+)?$/.test(s)) {
    throw new Error(`inventoryReceipt: invalid amount: ${amountStr}`);
  }
  const [whole, frac = ""] = s.split(".");
  const padded = (frac + "00").slice(0, 2);
  const sign = whole.startsWith("-") ? -1n : 1n;
  const wholeAbs = whole.replace(/^-/, "");
  return sign * (BigInt(wholeAbs) * 100n + BigInt(padded));
}
