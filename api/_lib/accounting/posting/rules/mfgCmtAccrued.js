// api/_lib/accounting/posting/rules/mfgCmtAccrued.js
//
// Outsourced conversion (subcontracting) — accrue the contractor's CMT charge
// into a build's WIP at the moment the finished goods are RECEIVED against the
// conversion PO. This is the CMT analogue of the goods GR/IR entry: the charge
// is capitalized now (so the finished-goods layer holds the true cost) and the
// liability sits in 2160 Accrued CMT until the vendor's bill clears it (3-way
// match — see mfgCmtInvoiceMatch).
//
//   DR 1205 WIP           (subledger=build_order, id=build_order_id)
//   CR 2160 Accrued CMT   (clearing — no subledger, mirrors 2050 GR/IR)
//
// Posted on BOTH bases, like every other manufacturing event (mfg_build_issue /
// mfg_service_capitalized / mfg_build_complete): mfg_build_complete moves the
// full accumulated WIP (parts + styles + this CMT) into finished goods on both
// the ACCRUAL and CASH books, so the CMT must be in WIP on both bases or the
// cash-basis WIP would go negative at completion. 2160 is closed on both bases
// by mfgCmtInvoiceMatch.
//
// Idempotency: source_table='mfg_cmt_accrual', source_id = build_order_id (one
// CMT accrual per build).

/**
 * @param {import('../types.js').PostingEvent} event
 *   event.data = {
 *     build_order_id, posting_date,
 *     wip_account_id, accrued_cmt_account_id,
 *     cmt_cents, build_number?,
 *   }
 */
export function mfgCmtAccrued(event) {
  const d = event.data;
  required(d, ["build_order_id", "posting_date", "wip_account_id", "accrued_cmt_account_id", "cmt_cents"]);

  const cmtCents = toBigIntCents(d.cmt_cents, "cmt_cents");
  if (cmtCents <= 0n) throw new Error("mfgCmtAccrued: cmt_cents must be > 0");
  const amountStr = fromCents(cmtCents);
  const desc = `Conversion CMT accrued — build ${d.build_number || d.build_order_id}`;

  const lines = [
    { line_number: 1, account_id: d.wip_account_id, debit: amountStr, credit: "0", memo: desc, subledger_type: "build_order", subledger_id: d.build_order_id },
    { line_number: 2, account_id: d.accrued_cmt_account_id, debit: "0", credit: amountStr, memo: `${desc} — accrued CMT`, subledger_type: null, subledger_id: null },
  ];
  const base = {
    entity_id: event.entity_id,
    journal_type: "manufacture_service",
    posting_date: d.posting_date,
    source_module: "inventory",
    source_table: "mfg_cmt_accrual",
    source_id: d.build_order_id,
    description: desc,
    created_by_user_id: event.created_by_user_id ?? null,
    lines,
  };
  return {
    accrual: { ...base, basis: "ACCRUAL", lines: cloneLines(lines) },
    cash:    { ...base, basis: "CASH",    lines: cloneLines(lines) },
  };
}

function required(obj, fields) {
  for (const f of fields) {
    if (obj?.[f] == null || obj[f] === "") throw new Error(`mfgCmtAccrued: data.${f} is required`);
  }
}
function toBigIntCents(v, name) {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") { if (!Number.isInteger(v)) throw new Error(`mfgCmtAccrued: ${name} must be integer cents`); return BigInt(v); }
  if (typeof v === "string") { if (!/^-?\d+$/.test(v)) throw new Error(`mfgCmtAccrued: ${name} must be integer cents string`); return BigInt(v); }
  throw new Error(`mfgCmtAccrued: ${name} must be number|string|bigint`);
}
function fromCents(cents) {
  const neg = cents < 0n; const abs = neg ? -cents : cents;
  return `${neg ? "-" : ""}${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, "0")}`;
}
function cloneLines(lines) { return lines.map((l) => ({ ...l })); }
