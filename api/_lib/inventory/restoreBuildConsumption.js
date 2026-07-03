// api/_lib/inventory/restoreBuildConsumption.js
//
// Reverse the FIFO consumption a manufacturing build made when it was ISSUED —
// used when an issued build is CANCELLED. Issuing a build draws parts (from
// part_inventory_layers) and consumed finished-styles (from inventory_layers)
// into WIP at actual FIFO cost. Cancelling reverses the GL, but that only puts
// the inventory ASSET dollars back; the physical on-hand stays drawn down. These
// helpers put the units back: for each live consumption row tied to the build,
// add qty_consumed back onto its source layer (capped at original_qty) and stamp
// the draw reversed_at so the append-only ledger records the undo.
//
// Mirrors restoreInvoiceConsumption.js. Idempotent — rows already reversed
// (reversed_at IS NOT NULL) are skipped, so a re-run is a no-op. Multi-statement
// (not one txn), matching the codebase's accepted "FIFO ledger may lead GL by one
// event" tradeoff; the per-row guard keeps a partial run consistent.
//
// Linkage (see mfgBuildIssue.js + the FIFO consume paths):
//   • styles → inventory_consumption, consumer_kind='transfer_out',
//     consumer_adjustment_id = build_order_id (RPC routes transfer_out's
//     consumer_ref_id into consumer_adjustment_id).
//   • parts  → part_inventory_consumption, consumer_kind='build_issue',
//     consumer_build_order_id = build_order_id.
//
// Each returns { restored_qty, rows_reversed } (0/0 when nothing to restore).

// Style (finished-good component) consumption → inventory_layers.
export async function restoreBuildStyleConsumption(admin, buildOrderId, userId = null) {
  const { data: draws } = await admin
    .from("inventory_consumption")
    .select("id, layer_id, qty_consumed")
    .eq("consumer_kind", "transfer_out")
    .eq("consumer_adjustment_id", buildOrderId)
    .is("reversed_at", null);
  if (!draws || draws.length === 0) return { restored_qty: 0, rows_reversed: 0 };

  const nowIso = new Date().toISOString();
  let restoredQty = 0, rowsReversed = 0;
  for (const d of draws) {
    const qty = Number(d.qty_consumed) || 0;
    if (qty <= 0 || !d.layer_id) continue;
    const { data: layer } = await admin
      .from("inventory_layers")
      .select("id, original_qty, remaining_qty")
      .eq("id", d.layer_id)
      .maybeSingle();
    if (layer) {
      const restored = Math.min(
        Number(layer.original_qty),
        (Number(layer.remaining_qty) || 0) + qty,
      );
      await admin.from("inventory_layers").update({ remaining_qty: restored }).eq("id", d.layer_id);
    }
    await admin
      .from("inventory_consumption")
      .update({ reversed_at: nowIso, reversed_by_user_id: userId })
      .eq("id", d.id);
    restoredQty += qty;
    rowsReversed += 1;
  }
  return { restored_qty: restoredQty, rows_reversed: rowsReversed };
}

// Part consumption → part_inventory_layers.
export async function restoreBuildPartConsumption(admin, buildOrderId, userId = null) {
  const { data: draws } = await admin
    .from("part_inventory_consumption")
    .select("id, layer_id, qty_consumed")
    .eq("consumer_kind", "build_issue")
    .eq("consumer_build_order_id", buildOrderId)
    .is("reversed_at", null);
  if (!draws || draws.length === 0) return { restored_qty: 0, rows_reversed: 0 };

  const nowIso = new Date().toISOString();
  let restoredQty = 0, rowsReversed = 0;
  for (const d of draws) {
    const qty = Number(d.qty_consumed) || 0;
    if (qty <= 0 || !d.layer_id) continue;
    const { data: layer } = await admin
      .from("part_inventory_layers")
      .select("id, original_qty, remaining_qty")
      .eq("id", d.layer_id)
      .maybeSingle();
    if (layer) {
      const restored = Math.min(
        Number(layer.original_qty),
        (Number(layer.remaining_qty) || 0) + qty,
      );
      await admin.from("part_inventory_layers").update({ remaining_qty: restored }).eq("id", d.layer_id);
    }
    await admin
      .from("part_inventory_consumption")
      .update({ reversed_at: nowIso, reversed_by_user_id: userId })
      .eq("id", d.id);
    restoredQty += qty;
    rowsReversed += 1;
  }
  return { restored_qty: restoredQty, rows_reversed: rowsReversed };
}
