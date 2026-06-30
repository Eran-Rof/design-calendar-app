// api/_lib/sales-orders/reopenFromInvoice.js
//
// When an AR invoice that was generated from a sales order is DELETED (draft) or
// VOIDED (posted), the sales order must be RE-OPENED — otherwise the SO is stuck
// in 'invoiced' with qty_invoiced == qty_ordered and is effectively lost (you
// can't re-invoice or re-ship it). This reverses create-invoice's stamping:
//
//   - For each invoice line linked to a SO line (sales_order_line_id), subtract
//     the invoiced quantity back off the SO line's qty_invoiced (floored at 0).
//   - Re-derive each SO line's status from what remains:
//       qty_invoiced > 0            → 'invoiced' (still partially invoiced)
//       else qty_allocated >= ord   → 'allocated' (soft reservation is intact —
//                                      invoicing never released allocations)
//       else                        → 'confirmed'
//   - Re-derive the SO header status the same way (only when it is currently a
//     terminal 'invoiced'/'closed'; never touches 'cancelled').
//
// Allocations (qty_allocated, a soft reservation) are NOT touched by invoicing,
// so re-opening simply returns the order to its allocated/confirmed state with
// those allocations still in place. GL/FIFO reversal is handled by the caller
// (the void flow reverses the JEs); this only repairs the SO state machine.
//
// Returns { reopened, so_id, so_number } — reopened=false when the invoice has
// no linked sales order (a standalone invoice) so callers can no-op cleanly.

export async function reopenSalesOrderFromInvoice(admin, invoiceId) {
  const { data: inv } = await admin
    .from("ar_invoices")
    .select("id, sales_order_id")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!inv || !inv.sales_order_id) return { reopened: false, so_id: null, so_number: null };
  const soId = inv.sales_order_id;

  const { data: so } = await admin
    .from("sales_orders")
    .select("id, so_number, status")
    .eq("id", soId)
    .maybeSingle();
  if (!so) return { reopened: false, so_id: soId, so_number: null };

  // Quantities this invoice billed, per SO line.
  const { data: invLines } = await admin
    .from("ar_invoice_lines")
    .select("sales_order_line_id, quantity")
    .eq("ar_invoice_id", invoiceId);
  const billedByLine = new Map(); // so_line_id -> qty
  for (const l of invLines || []) {
    if (!l.sales_order_line_id) continue;
    billedByLine.set(l.sales_order_line_id, (billedByLine.get(l.sales_order_line_id) || 0) + (Number(l.quantity) || 0));
  }

  const { data: soLines } = await admin
    .from("sales_order_lines")
    .select("id, qty_ordered, qty_invoiced, qty_allocated, status")
    .eq("sales_order_id", soId);

  const lineStatus = (qtyInvoiced, qtyOrdered, qtyAllocated) => {
    if (qtyInvoiced > 0) return "invoiced";
    return (Number(qtyAllocated) || 0) >= (Number(qtyOrdered) || 0) && (Number(qtyOrdered) || 0) > 0
      ? "allocated" : "confirmed";
  };

  let anyStillInvoiced = false;
  let allFullyAllocated = true;
  const nowIso = new Date().toISOString();
  for (const l of soLines || []) {
    const billed = billedByLine.get(l.id) || 0;
    const ordered = Number(l.qty_ordered) || 0;
    const allocated = Number(l.qty_allocated) || 0;
    // Only adjust lines this invoice actually billed; leave the rest untouched.
    const newInvoiced = billed > 0 ? Math.max(0, (Number(l.qty_invoiced) || 0) - billed) : (Number(l.qty_invoiced) || 0);
    if (newInvoiced > 0) anyStillInvoiced = true;
    if (allocated < ordered || ordered === 0) allFullyAllocated = false;
    if (billed > 0) {
      const newStatus = l.status === "cancelled" ? "cancelled" : lineStatus(newInvoiced, ordered, allocated);
      await admin.from("sales_order_lines")
        .update({ qty_invoiced: newInvoiced, status: newStatus, updated_at: nowIso })
        .eq("id", l.id);
    }
  }

  // Re-open the header only if it is currently terminal (invoiced/closed). Leave
  // partially-invoiced orders 'invoiced'; never resurrect a 'cancelled' order.
  if ((so.status === "invoiced" || so.status === "closed") && !anyStillInvoiced) {
    const headerStatus = allFullyAllocated ? "allocated" : "confirmed";
    await admin.from("sales_orders")
      .update({ status: headerStatus, updated_at: nowIso })
      .eq("id", soId);
  }

  return { reopened: true, so_id: soId, so_number: so.so_number || null };
}
