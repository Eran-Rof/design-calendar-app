// api/_lib/accounting/posting/rules/mfgBuildComplete.js
//
// Manufacturing — complete a build: move accumulated WIP into finished-goods
// inventory (M4). The finished style's FIFO layer is created at the ACTUAL
// accumulated build cost (parts COGS + consumed-style COGS + capitalized
// service charges), so downstream AR/COGS draws the real cost.
//
//   DR <finished-style inventory acct>  (subledger=item, id=finished_item_id)
//   CR 1305 WIP                          (subledger=build_order, id=build_order_id)
//   amount = accumulated_cost_cents
//   + one inventory_layers row for the finished item at
//     unit_cost = accumulated_cost_cents / completed_qty, source_kind='manufacture'.
//
// Idempotency: source_table='mfg_build_complete', source_id=build_order_id.

/**
 * @param {import('../types.js').PostingEvent} event
 *   event.data = {
 *     build_order_id, finished_item_id, posting_date,
 *     wip_account_id, finished_inventory_account_id,
 *     accumulated_cost_cents, completed_qty,
 *     location_id?, build_number?,
 *   }
 */
export function mfgBuildComplete(event) {
  const d = event.data;
  required(d, ["build_order_id", "finished_item_id", "posting_date", "wip_account_id", "finished_inventory_account_id", "accumulated_cost_cents", "completed_qty"]);

  const totalCents = toBigIntCents(d.accumulated_cost_cents, "accumulated_cost_cents");
  if (totalCents <= 0n) throw new Error("mfgBuildComplete: accumulated_cost_cents must be > 0 (issue components / capitalize services first)");
  const qty = Number(d.completed_qty);
  if (!Number.isFinite(qty) || qty <= 0) throw new Error("mfgBuildComplete: completed_qty must be > 0");

  const amountStr = fromCents(totalCents);
  const unitCostCents = Number(totalCents / BigInt(Math.round(qty))); // integer cents per unit
  const desc = `Build complete ${d.build_number || d.build_order_id}`;

  const lines = [
    { line_number: 1, account_id: d.finished_inventory_account_id, debit: amountStr, credit: "0", memo: desc, subledger_type: "item", subledger_id: d.finished_item_id },
    { line_number: 2, account_id: d.wip_account_id, debit: "0", credit: amountStr, memo: desc, subledger_type: "build_order", subledger_id: d.build_order_id },
  ];
  const base = {
    entity_id: event.entity_id,
    journal_type: "manufacture_complete",
    posting_date: d.posting_date,
    source_module: "inventory",
    source_table: "mfg_build_complete",
    source_id: d.build_order_id,
    description: desc,
    created_by_user_id: event.created_by_user_id ?? null,
    lines,
  };
  return {
    accrual: { ...base, basis: "ACCRUAL", lines: cloneLines(lines) },
    cash:    { ...base, basis: "CASH",    lines: cloneLines(lines) },
    inventoryLayers: [
      {
        item_id: d.finished_item_id,
        qty,
        unit_cost_cents: unitCostCents,
        source_kind: "manufacture",
        location_id: d.location_id || null,
        received_at: d.posting_date,
        notes: `Manufacturing build ${d.build_number || d.build_order_id}`,
      },
    ],
  };
}

function required(obj, fields) {
  for (const f of fields) {
    if (obj?.[f] == null || obj[f] === "") throw new Error(`mfgBuildComplete: data.${f} is required`);
  }
}
function toBigIntCents(v, name) {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") { if (!Number.isInteger(v)) throw new Error(`mfgBuildComplete: ${name} must be integer cents`); return BigInt(v); }
  if (typeof v === "string") { if (!/^-?\d+$/.test(v)) throw new Error(`mfgBuildComplete: ${name} must be integer cents string`); return BigInt(v); }
  throw new Error(`mfgBuildComplete: ${name} must be number|string|bigint`);
}
function fromCents(cents) {
  const neg = cents < 0n; const abs = neg ? -cents : cents;
  return `${neg ? "-" : ""}${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, "0")}`;
}
function cloneLines(lines) { return lines.map((l) => ({ ...l })); }
