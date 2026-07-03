// api/_lib/inventory/restoreInvoiceConsumption.js
//
// Reverse the FIFO inventory consumption of a posted AR invoice — used when the
// invoice is VOIDED. Posting an AR invoice draws stock down (reduces the source
// layers' remaining_qty + appends inventory_consumption rows) and books the COGS
// pair. The void flow already reverses the GL journal entries, but that only
// restores the inventory ASSET dollars — the physical on-hand quantity stays
// drawn down. This puts the units back: for each live consumption row tied to the
// invoice's lines, it adds qty_consumed back to that layer's remaining_qty (true
// reversal — restores the exact layers, so on-hand returns to its pre-post state)
// and stamps the consumption row reversed_at so the append-only ledger records
// that the draw was undone.
//
// consumer linkage: arInvoiceSent records consumer_ref_id = the AR INVOICE LINE id
// (ln.id), stored in inventory_consumption.consumer_invoice_id (a polymorphic id —
// its FK was dropped in mig 20260898). So we resolve the invoice's line ids first.
//
// Idempotent: rows already reversed (reversed_at IS NOT NULL) are skipped, so a
// re-run is a no-op. Multi-statement (not a single txn), matching the codebase's
// accepted "FIFO ledger may lead GL by one event" tradeoff; the per-row guard
// keeps any partial run consistent.
//
// Returns { restored_qty, rows_reversed } (both 0 when nothing was consumed, e.g.
// a never-posted draft).

export async function restoreInvoiceConsumption(admin, invoiceId, userId = null) {
  // 1. The invoice's line ids — consumption rows reference these (not the header).
  const { data: invLines } = await admin
    .from("ar_invoice_lines")
    .select("id")
    .eq("ar_invoice_id", invoiceId);
  const lineIds = (invLines || []).map((l) => l.id);
  if (lineIds.length === 0) return { restored_qty: 0, rows_reversed: 0 };

  // 2. Live (un-reversed) FIFO draws made by those lines.
  const { data: draws } = await admin
    .from("inventory_consumption")
    .select("id, layer_id, qty_consumed")
    .eq("consumer_kind", "ar_invoice")
    .is("reversed_at", null)
    .in("consumer_invoice_id", lineIds);
  if (!draws || draws.length === 0) return { restored_qty: 0, rows_reversed: 0 };

  // 3. Put each draw back on its source layer, then mark the draw reversed.
  const nowIso = new Date().toISOString();
  let restoredQty = 0;
  let rowsReversed = 0;
  for (const d of draws) {
    const qty = Number(d.qty_consumed) || 0;
    if (qty <= 0 || !d.layer_id) continue;
    const { data: layer } = await admin
      .from("inventory_layers")
      .select("id, original_qty, remaining_qty")
      .eq("id", d.layer_id)
      .maybeSingle();
    if (layer) {
      // Guard against ever exceeding the layer's original size (defensive — the
      // sum of live draws can never exceed it, but a double-run shouldn't inflate).
      const restored = Math.min(
        Number(layer.original_qty),
        (Number(layer.remaining_qty) || 0) + qty,
      );
      await admin
        .from("inventory_layers")
        .update({ remaining_qty: restored })
        .eq("id", d.layer_id);
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
