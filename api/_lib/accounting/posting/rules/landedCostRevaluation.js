// api/_lib/accounting/posting/rules/landedCostRevaluation.js
//
// Late landed cost (customs duty / broker freight) for a posted goods receipt.
// The receipt already booked the goods at their PO/landed-at-receipt cost; this
// distributes the LATER broker/customs bill:
//
//   DR Inventory (per item)    = share on units still in stock (capitalized — the
//                                handler also bumps those FIFO layers' unit cost)
//   DR Landed Cost Variance    = share on units already sold (5150; consumed units
//     (5150)                     stay at receipt cost, so their duty is expensed)
//   CR AP (broker vendor)      = broker invoice total
//
// The handler mutates the FIFO layers' unit_cost AFTER this JE persists. This
// rule is a pure data producer; it creates NO inventory layers and runs no
// consume plan.

/**
 * @param {import('../types.js').PostingEvent} event
 *   event.data = {
 *     invoice_id, vendor_id, invoice_number, invoice_date,
 *     ap_account_id, inventory_account_id, variance_account_id,
 *     inventory_lines: [{ item_id, amount }],  // capitalized uplift, per item
 *     consumed_variance_amount,                // expensed to 5150 (may be "0.00")
 *     total_amount,                            // broker total = Σ uplift + consumed
 *   }
 * @returns {import('../types.js').PostingRuleOutput}
 */
export function landedCostRevaluation(event) {
  const d = event.data;
  required(d, ["invoice_id", "vendor_id", "invoice_number", "invoice_date",
               "ap_account_id", "inventory_account_id", "total_amount"]);

  const desc = `Landed-cost revaluation ${d.invoice_number}`;
  const lines = [];
  let n = 1;
  let drTotal = 0n;

  const invLines = Array.isArray(d.inventory_lines) ? d.inventory_lines : [];
  for (const ln of invLines) {
    if (!ln || ln.item_id == null || ln.item_id === "" || ln.amount == null || ln.amount === "") {
      throw new Error("landedCostRevaluation: each inventory line requires item_id + amount");
    }
    if (toCents(ln.amount) === 0n) continue; // skip no-op uplifts
    lines.push({
      line_number: n++,
      account_id: d.inventory_account_id,
      debit: ln.amount,
      credit: "0",
      memo: `${desc} — capitalize to stock`,
      subledger_type: "item",
      subledger_id: ln.item_id,
    });
    drTotal += toCents(ln.amount);
  }

  const consumed = d.consumed_variance_amount != null && d.consumed_variance_amount !== ""
    ? toCents(d.consumed_variance_amount) : 0n;
  if (consumed > 0n) {
    if (!d.variance_account_id) {
      throw new Error("landedCostRevaluation: variance_account_id (5150) required when consumed_variance_amount > 0");
    }
    lines.push({
      line_number: n++,
      account_id: d.variance_account_id,
      debit: fromCents(consumed),
      credit: "0",
      memo: `${desc} — duty on units already sold`,
      subledger_type: null,
      subledger_id: null,
    });
    drTotal += consumed;
  }

  const total = toCents(d.total_amount);
  if (drTotal !== total) {
    throw new Error(`landedCostRevaluation: DR (${drTotal}) != broker total (${total}); uplift + consumed variance must sum to the total`);
  }
  if (total <= 0n) {
    throw new Error("landedCostRevaluation: total_amount must be > 0");
  }

  // CR AP for the broker total (broker vendor subledger).
  lines.push({
    line_number: n++,
    account_id: d.ap_account_id,
    debit: "0",
    credit: fromCents(total),
    memo: desc,
    subledger_type: "vendor",
    subledger_id: d.vendor_id,
  });

  const accrual = {
    entity_id: event.entity_id,
    basis: "ACCRUAL",
    journal_type: "ap_invoice",
    posting_date: d.invoice_date,
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
      throw new Error(`landedCostRevaluation: data.${f} is required`);
    }
  }
}

function toCents(amountStr) {
  const s = typeof amountStr === "string" ? amountStr : String(amountStr);
  if (!/^-?\d+(\.\d+)?$/.test(s)) {
    throw new Error(`landedCostRevaluation: invalid amount: ${amountStr}`);
  }
  const [whole, frac = ""] = s.split(".");
  const padded = (frac + "00").slice(0, 2);
  const sign = whole.startsWith("-") ? -1n : 1n;
  const wholeAbs = whole.replace(/^-/, "");
  return sign * (BigInt(wholeAbs) * 100n + BigInt(padded));
}

function fromCents(cents) {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  return `${neg ? "-" : ""}${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, "0")}`;
}
