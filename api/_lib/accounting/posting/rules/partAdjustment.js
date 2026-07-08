// api/_lib/accounting/posting/rules/partAdjustment.js
//
// Manufacturing — part inventory adjustment posting rule. The parts analogue of
// inventoryAdjustment.js: parts live in their own FIFO pool (part_inventory_layers)
// and their own asset account (1207 Inventory-Parts), so this rule emits
// partInventoryLayers[] / partConsumePlan[] (drained by postEvent via the part
// FIFO engine) rather than the style inventory variants.
//
// Both bases post the same JE (non-cash internal event).
//
// POSITIVE qty_delta (opening balance / found / correction-up):
//   Amount = qty_delta × unit_cost_cents
//   DR inventory_parts_account_id (subledger='part', id=part_id)
//   CR gl_account_id              (counter: opening-balance equity / found income)
//   Side-effect: one part_inventory_layers row queued (source_kind='adjustment').
//
// NEGATIVE qty_delta (shrinkage / damage / write-off / correction-down):
//   Amount = cogs_cents (FIFO-derived; sentinel "0" until postEvent rewrites)
//   DR gl_account_id              (counter: shrinkage / write-off expense)
//   CR inventory_parts_account_id (subledger='part', id=part_id)
//   Side-effect: partConsumePlan drained → part_fifo_consume(adjustment_decrease).

/**
 * @param {import('../types.js').PostingEvent} event
 *   event.data = {
 *     adjustment_id, part_id, adjustment_type, qty_delta (signed),
 *     unit_cost_cents (required when qty_delta>0),
 *     inventory_parts_account_id, gl_account_id, posting_date, reason?, location_id?
 *   }
 */
export function partAdjustment(event) {
  const d = event.data;
  required(d, [
    "adjustment_id", "part_id", "adjustment_type", "qty_delta",
    "inventory_parts_account_id", "gl_account_id", "posting_date",
  ]);

  const qtyDelta = toNumeric(d.qty_delta, "qty_delta");
  if (qtyDelta === 0) throw new Error("partAdjustment: qty_delta cannot be zero");

  const validTypes = ["opening_balance", "found", "correction", "damage", "shrinkage", "write_off"];
  if (!validTypes.includes(d.adjustment_type)) {
    throw new Error(`partAdjustment: adjustment_type must be one of ${validTypes.join("|")} (got '${d.adjustment_type}')`);
  }

  const isUp = qtyDelta > 0;
  const descBase = `Part adjustment ${d.adjustment_id} (${d.adjustment_type}, ${isUp ? "+" : ""}${qtyDelta})`;
  const desc = d.reason ? `${descBase}: ${d.reason}` : descBase;

  if (isUp) {
    if (d.unit_cost_cents == null || d.unit_cost_cents === "") {
      throw new Error("partAdjustment: unit_cost_cents required for positive qty_delta");
    }
    const unitCostCents = toBigIntCents(d.unit_cost_cents, "unit_cost_cents");
    if (unitCostCents < 0n) throw new Error("partAdjustment: unit_cost_cents must be >= 0");
    const totalCents = BigInt(Math.trunc(Math.abs(qtyDelta) * 10000)) * unitCostCents / 10000n;
    const amountStr = fromCents(totalCents);

    const lines = [
      { line_number: 1, account_id: d.inventory_parts_account_id, debit: amountStr, credit: "0", memo: desc, subledger_type: "part", subledger_id: d.part_id },
      { line_number: 2, account_id: d.gl_account_id, debit: "0", credit: amountStr, memo: desc, subledger_type: null, subledger_id: null },
    ];
    const base = baseEntry(event, d, desc, lines);
    return {
      accrual: { ...base, basis: "ACCRUAL", lines: cloneLines(lines) },
      cash:    { ...base, basis: "CASH",    lines: cloneLines(lines) },
      partInventoryLayers: [
        {
          part_id: d.part_id,
          qty: Math.abs(qtyDelta),
          unit_cost_cents: d.unit_cost_cents,
          source_kind: d.adjustment_type === "opening_balance" ? "opening_balance" : "adjustment",
          source_adjustment_id: d.adjustment_id,
          location_id: d.location_id || null,
          received_at: d.posting_date,
          notes: d.reason || null,
        },
      ],
    };
  }

  // Negative — sentinel lines rewritten by postEvent after part_fifo_consume.
  const qtyAbs = Math.abs(qtyDelta);
  const sentinel = "0";
  const lines = [
    { line_number: 1, account_id: d.gl_account_id, debit: sentinel, credit: "0", memo: desc, subledger_type: null, subledger_id: null },
    { line_number: 2, account_id: d.inventory_parts_account_id, debit: "0", credit: sentinel, memo: desc, subledger_type: "part", subledger_id: d.part_id },
  ];
  const base = baseEntry(event, d, desc, lines);
  return {
    accrual: { ...base, basis: "ACCRUAL", lines: cloneLines(lines) },
    cash:    { ...base, basis: "CASH",    lines: cloneLines(lines) },
    partConsumePlan: [
      {
        part_id: d.part_id,
        qty: qtyAbs,
        consumer_kind: "adjustment_decrease",
        consumer_ref_id: d.adjustment_id,
        location_id: d.location_id || null,
      },
    ],
  };
}

function baseEntry(event, d, desc, lines) {
  return {
    entity_id: event.entity_id,
    journal_type: "adjustment",
    posting_date: d.posting_date,
    source_module: "inventory",
    source_table: "part_adjustments",
    source_id: d.adjustment_id,
    description: desc,
    created_by_user_id: event.created_by_user_id ?? null,
    lines,
  };
}

function required(obj, fields) {
  for (const f of fields) {
    if (obj?.[f] == null || obj[f] === "") {
      throw new Error(`partAdjustment: data.${f} is required`);
    }
  }
}
function toNumeric(v, name) {
  if (typeof v === "number") { if (!Number.isFinite(v)) throw new Error(`partAdjustment: ${name} must be finite`); return v; }
  if (typeof v === "string") { if (!/^-?\d+(\.\d+)?$/.test(v)) throw new Error(`partAdjustment: ${name} must be numeric (got ${v})`); return Number(v); }
  if (typeof v === "bigint") return Number(v);
  throw new Error(`partAdjustment: ${name} must be number|string|bigint`);
}
function toBigIntCents(v, name) {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") { if (!Number.isInteger(v)) throw new Error(`partAdjustment: ${name} must be integer cents`); return BigInt(v); }
  if (typeof v === "string") { if (!/^-?\d+$/.test(v)) throw new Error(`partAdjustment: ${name} must be integer cents string`); return BigInt(v); }
  throw new Error(`partAdjustment: ${name} must be number|string|bigint`);
}
function fromCents(cents) {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const whole = abs / 100n;
  const frac = abs % 100n;
  return `${neg ? "-" : ""}${whole.toString()}.${frac.toString().padStart(2, "0")}`;
}
function cloneLines(lines) { return lines.map((l) => ({ ...l })); }
