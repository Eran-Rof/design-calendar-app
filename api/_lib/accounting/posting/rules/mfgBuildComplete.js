// api/_lib/accounting/posting/rules/mfgBuildComplete.js
//
// Manufacturing — complete a build: move accumulated WIP into finished-goods
// inventory (M4). The finished style's FIFO layer is created at the ACTUAL
// accumulated build cost (parts COGS + consumed-style COGS + capitalized
// service charges), so downstream AR/COGS draws the real cost.
//
//   DR <finished-style inventory acct>  (subledger=item)
//   CR 1205 WIP                          (subledger=build_order, id=build_order_id)
//   amount = accumulated_cost_cents
//
// Phase A — per-SIZE outputs. When data.outputs is supplied (an apparel build
// that produced a color x size matrix), the finished-inventory DEBIT and the
// finished-goods FIFO layers are split PER OUTPUT (one debit line + one layer
// per size, subledger=item=output.item_id). Per-unit cost is UNIFORM
// (accumulated / total units); the debit amounts are allocated proportionally
// with the LAST output absorbing the rounding remainder, so the debits sum
// EXACTLY to accumulated and the JE stays balanced against the single WIP
// credit. Without data.outputs it falls back to the original single-layer path
// (finished_item_id, completed_qty).
//
// Idempotency: source_table='mfg_build_complete', source_id=build_order_id.

/**
 * @param {import('../types.js').PostingEvent} event
 *   event.data = {
 *     build_order_id, finished_item_id, posting_date,
 *     wip_account_id, finished_inventory_account_id,
 *     accumulated_cost_cents, completed_qty,
 *     location_id?, build_number?,
 *     outputs?: [{ item_id, qty, color?, size? }],  // Phase A per-size outputs
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
  const desc = `Build complete ${d.build_number || d.build_order_id}`;
  const layerNote = `Manufacturing build ${d.build_number || d.build_order_id}`;

  const outputs = Array.isArray(d.outputs)
    ? d.outputs.filter((o) => o && o.item_id && Number(o.qty) > 0)
    : [];

  let lines;
  let inventoryLayers;
  if (outputs.length > 0) {
    // qty carried at 4dp on mfg_build_outputs → scale to integers for exact
    // BigInt allocation of the accumulated cents across sizes.
    const qtyIntOf = (o) => BigInt(Math.round(Number(o.qty) * 10000));
    const totalQtyInt = outputs.reduce((s, o) => s + qtyIntOf(o), 0n);
    if (totalQtyInt <= 0n) throw new Error("mfgBuildComplete: outputs total qty must be > 0");
    const totalUnits = outputs.reduce((s, o) => s + Number(o.qty), 0);
    const unitCostCents = Number(totalCents / BigInt(Math.max(1, Math.round(totalUnits)))); // uniform per-unit

    lines = [];
    let allocated = 0n;
    outputs.forEach((o, i) => {
      const isLast = i === outputs.length - 1;
      const alloc = isLast ? (totalCents - allocated) : (totalCents * qtyIntOf(o)) / totalQtyInt;
      allocated += alloc;
      const sizeLbl = `${o.color ? o.color + " " : ""}${o.size || ""}`.trim();
      lines.push({ line_number: i + 1, account_id: d.finished_inventory_account_id, debit: fromCents(alloc), credit: "0", memo: sizeLbl ? `${desc} — ${sizeLbl}` : desc, subledger_type: "item", subledger_id: o.item_id });
    });
    lines.push({ line_number: outputs.length + 1, account_id: d.wip_account_id, debit: "0", credit: amountStr, memo: desc, subledger_type: "build_order", subledger_id: d.build_order_id });

    inventoryLayers = outputs.map((o) => ({
      item_id: o.item_id,
      qty: Number(o.qty),
      unit_cost_cents: unitCostCents,
      source_kind: "manufacture",
      // Link the finished-goods layer back to the build (FK-less column) so a
      // reverse-complete can find + deplete exactly these layers. notes carries
      // the same handle for legacy layers created before this linkage existed.
      source_adjustment_id: d.build_order_id,
      location_id: d.location_id || null,
      received_at: d.posting_date,
      notes: layerNote,
    }));
  } else {
    const unitCostCents = Number(totalCents / BigInt(Math.round(qty))); // integer cents per unit
    lines = [
      { line_number: 1, account_id: d.finished_inventory_account_id, debit: amountStr, credit: "0", memo: desc, subledger_type: "item", subledger_id: d.finished_item_id },
      { line_number: 2, account_id: d.wip_account_id, debit: "0", credit: amountStr, memo: desc, subledger_type: "build_order", subledger_id: d.build_order_id },
    ];
    inventoryLayers = [
      {
        item_id: d.finished_item_id,
        qty,
        unit_cost_cents: unitCostCents,
        source_kind: "manufacture",
        source_adjustment_id: d.build_order_id, // build handle for reverse-complete
        location_id: d.location_id || null,
        received_at: d.posting_date,
        notes: layerNote,
      },
    ];
  }

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
    inventoryLayers,
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
