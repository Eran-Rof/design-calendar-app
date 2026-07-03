// api/_lib/accounting/posting/rules/mfgCmtInvoiceMatch.js
//
// Outsourced conversion (subcontracting) — the contractor's CMT vendor bill,
// 3-way matched against the conversion PO + the finished-goods receipt. The CMT
// was already capitalized into WIP at receipt (mfgCmtAccrued: DR WIP / CR 2160
// Accrued CMT). This bill therefore CLEARS 2160 — it does NOT re-capitalize the
// charge (no second WIP/inventory hit). Any difference between the bill and the
// accrued (received) value is a price variance booked to 6320 PO Variance.
//
//   DR 2160 Accrued CMT   = accrued (received) value   (clears the accrual)
//   DR/CR 6320 PO Variance = bill total − accrued value (either side)
//   CR AP                 = bill total                 (subledger vendor)
//
// This mirrors apInvoiceGrirMatch's 3-way math, but posts on BOTH bases (the mfg
// module recognizes WIP/CMT on accrual AND cash — mfgCmtAccrued credited 2160 on
// both, so both must be cleared here or a cash-basis 2160 balance would strand).
//
// Idempotency: source_table='mfg_cmt_invoice', source_id = invoice_id.

/**
 * @param {import('../types.js').PostingEvent} event
 *   event.data = {
 *     invoice_id, vendor_id, invoice_number, invoice_date,
 *     ap_account_id,            // CR — AP control
 *     accrued_cmt_account_id,   // DR — 2160 Accrued CMT (clears the accrual)
 *     variance_account_id,      // DR/CR — 6320 PO Variance; required iff total != accrued
 *     received_amount,          // decimal string — accrued (received) CMT value
 *     total_amount,             // decimal string — vendor bill total
 *     build_number?,
 *   }
 */
export function mfgCmtInvoiceMatch(event) {
  const d = event.data;
  required(d, ["invoice_id", "vendor_id", "invoice_number", "invoice_date",
               "ap_account_id", "accrued_cmt_account_id", "received_amount", "total_amount"]);

  const received = toCents(d.received_amount);
  const total = toCents(d.total_amount);
  if (received < 0n || total < 0n) throw new Error("mfgCmtInvoiceMatch: received_amount and total_amount must be >= 0");
  const variance = total - received; // + = bill over accrued, − = under
  const desc = `CMT vendor bill ${d.invoice_number}${d.build_number ? ` (build ${d.build_number})` : ""} — 3-way matched`;

  function buildLines() {
    const lines = [];
    let n = 1;
    // DR 2160 Accrued CMT for the accrued value — clears the receipt accrual.
    lines.push({
      line_number: n++, account_id: d.accrued_cmt_account_id,
      debit: fromCents(received), credit: "0",
      memo: `${desc} — clear Accrued CMT`, subledger_type: null, subledger_id: null,
    });
    // Price variance to PO Variance (6320): DR when the bill exceeds the accrued
    // value (extra cost), CR when under (cost reduction).
    if (variance !== 0n) {
      if (!d.variance_account_id) throw new Error("mfgCmtInvoiceMatch: variance_account_id required when bill total != accrued value");
      const vAbs = variance < 0n ? -variance : variance;
      lines.push({
        line_number: n++, account_id: d.variance_account_id,
        debit: variance > 0n ? fromCents(vAbs) : "0",
        credit: variance < 0n ? fromCents(vAbs) : "0",
        memo: `${desc} — price variance`, subledger_type: null, subledger_id: null,
      });
    }
    // CR AP for the full bill total (vendor subledger).
    lines.push({
      line_number: n++, account_id: d.ap_account_id,
      debit: "0", credit: fromCents(total),
      memo: desc, subledger_type: "vendor", subledger_id: d.vendor_id,
    });
    return lines;
  }

  const base = {
    entity_id: event.entity_id,
    journal_type: "ap_invoice",
    posting_date: d.invoice_date,
    source_module: "ap",
    source_table: "mfg_cmt_invoice",
    source_id: d.invoice_id,
    description: desc,
    created_by_user_id: event.created_by_user_id ?? null,
  };
  return {
    accrual: { ...base, basis: "ACCRUAL", lines: buildLines() },
    cash:    { ...base, basis: "CASH",    lines: buildLines() },
  };
}

function required(obj, fields) {
  for (const f of fields) {
    if (obj?.[f] == null || obj[f] === "") throw new Error(`mfgCmtInvoiceMatch: data.${f} is required`);
  }
}
function toCents(amountStr) {
  const s = typeof amountStr === "string" ? amountStr : String(amountStr);
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`mfgCmtInvoiceMatch: invalid amount: ${amountStr}`);
  const [whole, frac = ""] = s.split(".");
  const padded = (frac + "00").slice(0, 2);
  const sign = whole.startsWith("-") ? -1n : 1n;
  const wholeAbs = whole.replace(/^-/, "");
  return sign * (BigInt(wholeAbs) * 100n + BigInt(padded));
}
function fromCents(cents) {
  const neg = cents < 0n; const abs = neg ? -cents : cents;
  return `${neg ? "-" : ""}${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, "0")}`;
}
