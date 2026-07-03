// api/_lib/accounting/posting/rules/mfgServiceCapitalized.js
//
// Manufacturing — capitalize an outsourced conversion/labor SERVICE charge into
// a build's WIP (M4). The factory bills ROF for the print/sew/pack work; that
// vendor charge is added to the finished good's cost via WIP.
//
//   DR 1205 WIP   (subledger=build_order, id=build_order_id)
//   CR 2000 AP    (subledger=vendor,      id=vendor_id)
//
// Non-cash to the inventory books in the sense that it is recognized at the
// bill (accrual) — and we post the identical JE on both bases here for
// simplicity/consistency with the other manufacturing events (the value is an
// asset transfer into WIP regardless of basis; AP settlement cash-flow is
// tracked when the bill is actually paid elsewhere).
//
// Idempotency: source_table='mfg_build_service', source_id = the build
// component id (one capitalization per service component).

/**
 * @param {import('../types.js').PostingEvent} event
 *   event.data = {
 *     build_order_id, component_id, posting_date,
 *     wip_account_id, ap_account_id, vendor_id,
 *     charge_cents, build_number?, service_label?,
 *   }
 */
export function mfgServiceCapitalized(event) {
  const d = event.data;
  required(d, ["build_order_id", "component_id", "posting_date", "wip_account_id", "ap_account_id", "vendor_id", "charge_cents"]);

  const chargeCents = toBigIntCents(d.charge_cents, "charge_cents");
  if (chargeCents <= 0n) throw new Error("mfgServiceCapitalized: charge_cents must be > 0");
  const amountStr = fromCents(chargeCents);
  const desc = `Build conversion service ${d.service_label ? d.service_label + " " : ""}${d.build_number || d.build_order_id}`;

  const lines = [
    { line_number: 1, account_id: d.wip_account_id, debit: amountStr, credit: "0", memo: desc, subledger_type: "build_order", subledger_id: d.build_order_id },
    { line_number: 2, account_id: d.ap_account_id, debit: "0", credit: amountStr, memo: desc, subledger_type: "vendor", subledger_id: d.vendor_id },
  ];
  const base = {
    entity_id: event.entity_id,
    journal_type: "manufacture_service",
    posting_date: d.posting_date,
    source_module: "inventory",
    source_table: "mfg_build_service",
    source_id: d.component_id,
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
    if (obj?.[f] == null || obj[f] === "") throw new Error(`mfgServiceCapitalized: data.${f} is required`);
  }
}
function toBigIntCents(v, name) {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") { if (!Number.isInteger(v)) throw new Error(`mfgServiceCapitalized: ${name} must be integer cents`); return BigInt(v); }
  if (typeof v === "string") { if (!/^-?\d+$/.test(v)) throw new Error(`mfgServiceCapitalized: ${name} must be integer cents string`); return BigInt(v); }
  throw new Error(`mfgServiceCapitalized: ${name} must be number|string|bigint`);
}
function fromCents(cents) {
  const neg = cents < 0n; const abs = neg ? -cents : cents;
  return `${neg ? "-" : ""}${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, "0")}`;
}
function cloneLines(lines) { return lines.map((l) => ({ ...l })); }
