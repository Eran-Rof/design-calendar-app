-- Invoice (vendor submission) parity for Tangerine-native POs (purchase_orders),
-- mirroring the shipment FK relaxation (#1374, migration 20260896130000).
--
-- The vendor portal lists POs from BOTH sources (#1361); to let vendors submit an
-- INVOICE against a Tangerine PO, invoices.po_id and invoice_line_items
-- .po_line_item_id must accept ids from either source. Both were hard-FK'd to the
-- Xoro tables (invoices.po_id -> tanda_pos.uuid_id; invoice_line_items
-- .po_line_item_id -> po_line_items.id), which rejects Tangerine ids. Drop those
-- FKs (keep the columns + indexes). Ownership + invoiceable status are validated
-- server-side (api/vendor/invoices.js).
--
-- NOTE: the vendor invoice SUBMIT is non-GL — it just creates a 'submitted'
-- invoice. The internal AP/GL POSTING of a Tangerine-PO invoice (3-way match +
-- journal entries) is a separate, still-deferred step (the receiving->GL->AP epic).

ALTER TABLE invoices           DROP CONSTRAINT IF EXISTS invoices_po_id_fkey;
ALTER TABLE invoice_line_items DROP CONSTRAINT IF EXISTS invoice_line_items_po_line_item_id_fkey;

COMMENT ON COLUMN invoices.po_id IS 'PO this invoice is for: uuid resolving to tanda_pos.uuid_id (Xoro) OR purchase_orders.id (Tangerine). FK dropped 2026-06-18 to support both PO sources; ownership validated server-side.';
COMMENT ON COLUMN invoice_line_items.po_line_item_id IS 'Invoiced PO line: uuid resolving to po_line_items.id (Xoro) OR purchase_order_lines.id (Tangerine). FK dropped 2026-06-18 for both PO sources.';
