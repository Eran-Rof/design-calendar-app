// api/_lib/accounting/posting/rules/inventoryAdjustment.js
//
// Inventory adjustment (write-up or write-down). Both bases post the same
// JE since cash and accrual treat inventory adjustments identically — the
// adjustment is a non-cash event that affects the inventory asset on both
// books.
//
// Direction = 'up' (positive amount): DR inventory / CR adjustment_account
// Direction = 'down':                 DR adjustment_account / CR inventory
//
// TODO P3-5 (FIFO wire-point, arch §4.5 row 3):
//   Positive ('up') adjustments must INSERT a new inventory_layers row:
//     inventoryFifoAPI.createLayer(supabase, {
//       entity_id, item_id, qty, unit_cost_cents, source_kind: 'adjustment',
//       source_adjustment_id: adjustment_id, received_at: adjustment_date,
//       created_by_user_id,
//     })
//   To support this the rule should accept qty + unit_cost_cents on
//   event.data (or per-line) and pass them through on
//   PostingRuleOutput.inventoryLayers[] — same pattern P3-4 introduced for
//   apInvoiceReceived. postEvent already drains inventoryLayers; we just need
//   the per-rule data to flow through.
//
//   Negative ('down') adjustments must call inventoryFifoAPI.consume() with
//   consumer_kind='adjustment_decrease' and source_adjustment_id=adjustment_id,
//   then use the returned cogs_cents as the JE amount (overriding the
//   operator-supplied amount, which is descriptive only). This is the
//   FIFO-derived dollar value of inventory removed.

/**
 * @param {import('../types.js').PostingEvent} event
 *   event.data = {
 *     adjustment_id: string,
 *     item_id: string,
 *     adjustment_date: 'YYYY-MM-DD',
 *     amount: string,                  // POSITIVE
 *     direction: 'up' | 'down',
 *     inventory_account_id: string,
 *     adjustment_account_id: string,
 *     reason?: string
 *   }
 * @returns {import('../types.js').PostingRuleOutput}
 */
export function inventoryAdjustment(event) {
  const d = event.data;
  required(d, ["adjustment_id", "item_id", "adjustment_date", "amount", "direction",
               "inventory_account_id", "adjustment_account_id"]);
  if (!["up", "down"].includes(d.direction)) {
    throw new Error(`inventoryAdjustment: direction must be 'up' or 'down' (got '${d.direction}')`);
  }

  const desc = `Inventory adjustment ${d.adjustment_id} (${d.direction})${d.reason ? `: ${d.reason}` : ""}`;
  const isUp = d.direction === "up";

  const lines = [
    {
      line_number: 1,
      account_id: isUp ? d.inventory_account_id : d.adjustment_account_id,
      debit: d.amount,
      credit: "0",
      memo: desc,
      subledger_type: isUp ? "item" : null,
      subledger_id:   isUp ? d.item_id : null,
    },
    {
      line_number: 2,
      account_id: isUp ? d.adjustment_account_id : d.inventory_account_id,
      debit: "0",
      credit: d.amount,
      memo: desc,
      subledger_type: isUp ? null : "item",
      subledger_id:   isUp ? null : d.item_id,
    },
  ];

  const base = {
    entity_id: event.entity_id,
    journal_type: "adjustment",
    posting_date: d.adjustment_date,
    source_module: "inventory",
    source_table: "inventory_adjustments",
    source_id: d.adjustment_id,
    description: desc,
    created_by_user_id: event.created_by_user_id ?? null,
    lines,
  };

  return {
    accrual: { ...base, basis: "ACCRUAL" },
    cash:    { ...base, basis: "CASH" },
  };
}

function required(obj, fields) {
  for (const f of fields) {
    if (obj?.[f] == null || obj[f] === "") {
      throw new Error(`inventoryAdjustment: data.${f} is required`);
    }
  }
}
