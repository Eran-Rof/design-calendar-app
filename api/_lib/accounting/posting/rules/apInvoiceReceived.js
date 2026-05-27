// api/_lib/accounting/posting/rules/apInvoiceReceived.js
//
// Vendor bill recognized (accrual side only). Cash basis recognizes expense
// at PAYMENT, not at bill receipt, so the cash JE for this event is null.
//
// Accrual: DR expense_account (or inventory_account, per line) / CR ap_account
// Cash:    none
//
// Two payload shapes are supported:
//   1. Single-amount (legacy/simple): event.data.amount + expense_account_id +
//      ap_account_id. Produces one DR line + one CR AP line.
//   2. Multi-line (arch §3.2/§3.5): event.data.lines = [{ amount,
//      expense_account_id, inventory_item_id?, inventory_account_id?, memo? }].
//      Produces one DR line per input line + one CR AP line for the total.
//      Lines with inventory_item_id MUST also carry inventory_account_id
//      (the gl_accounts.id for inventory; the FIFO layer row is written
//      separately in P3-4).

/**
 * @param {import('../types.js').PostingEvent} event
 *   event.data = {
 *     invoice_id: string,
 *     vendor_id: string,
 *     invoice_number: string,
 *     invoice_date: 'YYYY-MM-DD',
 *     ap_account_id: string,
 *     // EITHER (single-amount path):
 *     amount?: string,                 // decimal string
 *     expense_account_id?: string,
 *     // OR (multi-line path):
 *     lines?: Array<{
 *       amount: string,
 *       expense_account_id: string,
 *       inventory_item_id?: string,    // when set, this is an inventory line
 *       inventory_account_id?: string, // required when inventory_item_id set
 *       memo?: string,
 *     }>,
 *   }
 * @returns {import('../types.js').PostingRuleOutput}
 */
export function apInvoiceReceived(event) {
  const d = event.data;
  required(d, ["invoice_id", "vendor_id", "invoice_number", "invoice_date", "ap_account_id"]);

  const desc = `AP invoice ${d.invoice_number}`;
  const useMultiLine = Array.isArray(d.lines) && d.lines.length > 0;

  let drLines;
  let totalCents;

  if (useMultiLine) {
    drLines = [];
    totalCents = 0n;
    let lineNumber = 1;
    for (const ln of d.lines) {
      if (!ln || ln.amount == null || ln.amount === "") {
        throw new Error(`apInvoiceReceived: each line requires amount`);
      }
      if (ln.inventory_item_id) {
        if (!ln.inventory_account_id) {
          throw new Error(`apInvoiceReceived: inventory line requires inventory_account_id`);
        }
      } else if (!ln.expense_account_id) {
        throw new Error(`apInvoiceReceived: expense line requires expense_account_id`);
      }

      const accountId = ln.inventory_item_id ? ln.inventory_account_id : ln.expense_account_id;
      const memo = ln.memo || desc;
      const subType = ln.inventory_item_id ? "item" : null;
      const subId = ln.inventory_item_id || null;

      drLines.push({
        line_number: lineNumber++,
        account_id: accountId,
        debit: ln.amount,
        credit: "0",
        memo,
        subledger_type: subType,
        subledger_id: subId,
      });
      totalCents += toCents(ln.amount);
    }

    // CR AP total
    drLines.push({
      line_number: lineNumber,
      account_id: d.ap_account_id,
      debit: "0",
      credit: fromCents(totalCents),
      memo: desc,
      subledger_type: "vendor",
      subledger_id: d.vendor_id,
    });
  } else {
    // Single-amount path
    required(d, ["amount", "expense_account_id"]);
    drLines = [
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
        account_id: d.ap_account_id,
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
    journal_type: "ap_invoice",
    posting_date: d.invoice_date,
    source_module: "ap",
    source_table: "invoices",
    source_id: d.invoice_id,
    description: desc,
    created_by_user_id: event.created_by_user_id ?? null,
    lines: drLines,
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

// Money math in BigInt cents — decimal-string -> bigint(cents) -> decimal-string.
function toCents(amountStr) {
  const s = typeof amountStr === "string" ? amountStr : String(amountStr);
  if (!/^-?\d+(\.\d+)?$/.test(s)) {
    throw new Error(`apInvoiceReceived: invalid amount: ${amountStr}`);
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
  const whole = abs / 100n;
  const frac = abs % 100n;
  const fracStr = frac.toString().padStart(2, "0");
  return `${neg ? "-" : ""}${whole.toString()}.${fracStr}`;
}
