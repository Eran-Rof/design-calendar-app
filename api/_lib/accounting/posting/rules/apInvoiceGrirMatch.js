// api/_lib/accounting/posting/rules/apInvoiceGrirMatch.js
//
// A vendor AP invoice that passed 3-way match against a PO + its posted goods
// receipt(s). The goods were already booked into inventory at receipt time
// (the GRNI JE: DR Inventory / CR GR/IR-goods). This invoice therefore CLEARS
// the GR/IR liability — it does NOT re-debit inventory and creates no second
// inventory layer. Any difference between the invoice and the received-and-
// accepted value is a price variance booked to PO Variance (6320).
//
//   DR GR/IR Clearing (2050)   = received-and-accepted value  (clears the GRNI)
//   DR/CR PO Variance (6320)   = invoice total − received value (either side)
//   CR AP (2010)               = invoice total                (subledger vendor)
//
// Cash basis recognizes expense at payment, so the cash JE is null.

/**
 * @param {import('../types.js').PostingEvent} event
 *   event.data = {
 *     invoice_id, vendor_id, invoice_number, invoice_date,
 *     ap_account_id,            // CR — AP control
 *     grir_account_id,          // DR — GR/IR clearing (2050)
 *     variance_account_id,      // DR/CR — PO Variance (6320); required iff total != received
 *     received_amount,          // decimal string — received-and-accepted value
 *     total_amount,             // decimal string — invoice total
 *   }
 * @returns {import('../types.js').PostingRuleOutput}
 */
export function apInvoiceGrirMatch(event) {
  const d = event.data;
  required(d, ["invoice_id", "vendor_id", "invoice_number", "invoice_date",
               "ap_account_id", "grir_account_id", "received_amount", "total_amount"]);

  const received = toCents(d.received_amount);
  const total = toCents(d.total_amount);
  if (received < 0n || total < 0n) {
    throw new Error("apInvoiceGrirMatch: received_amount and total_amount must be >= 0");
  }
  const variance = total - received; // + = invoice over received, − = under
  const desc = `AP invoice ${d.invoice_number} (3-way matched)`;

  const lines = [];
  let n = 1;

  // DR GR/IR clearing for the received value — clears the receipt's GR/IR-goods.
  lines.push({
    line_number: n++,
    account_id: d.grir_account_id,
    debit: fromCents(received),
    credit: "0",
    memo: `${desc} — clear GR/IR`,
    subledger_type: null,
    subledger_id: null,
  });

  // Price variance to PO Variance: DR when the invoice exceeds the received
  // value (extra cost), CR when it is under (cost reduction).
  if (variance !== 0n) {
    if (!d.variance_account_id) {
      throw new Error("apInvoiceGrirMatch: variance_account_id required when invoice total != received value");
    }
    const vAbs = variance < 0n ? -variance : variance;
    lines.push({
      line_number: n++,
      account_id: d.variance_account_id,
      debit: variance > 0n ? fromCents(vAbs) : "0",
      credit: variance < 0n ? fromCents(vAbs) : "0",
      memo: `${desc} — price variance`,
      subledger_type: null,
      subledger_id: null,
    });
  }

  // CR AP for the full invoice total (vendor subledger).
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
      throw new Error(`apInvoiceGrirMatch: data.${f} is required`);
    }
  }
}

function toCents(amountStr) {
  const s = typeof amountStr === "string" ? amountStr : String(amountStr);
  if (!/^-?\d+(\.\d+)?$/.test(s)) {
    throw new Error(`apInvoiceGrirMatch: invalid amount: ${amountStr}`);
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
  return `${neg ? "-" : ""}${whole.toString()}.${frac.toString().padStart(2, "0")}`;
}
