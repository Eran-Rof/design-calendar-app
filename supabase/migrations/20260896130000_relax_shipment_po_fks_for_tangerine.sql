-- Shipment (ASN) parity for Tangerine-native POs (purchase_orders), alongside
-- the legacy Xoro tanda_pos. The vendor portal now lists POs from BOTH sources
-- (#1361); to let vendors submit ASNs against a Tangerine PO, shipments.po_id
-- and shipment_lines.po_line_item_id must accept ids from EITHER source.
--
-- Both were hard-FK'd to the Xoro tables (shipments.po_id -> tanda_pos.uuid_id
-- ON DELETE CASCADE; shipment_lines.po_line_item_id -> po_line_items.id), which
-- rejects Tangerine ids. Drop those FKs (keep the columns + indexes). The PO is
-- validated + owned server-side (api/vendor/shipments.js), so referential intent
-- is preserved in the app layer during the Xoro -> Tangerine transition.
--
-- NOTE: dropping shipments_po_id_fkey also drops its ON DELETE CASCADE — but
-- tanda_pos rows are archived (data._archived), not hard-deleted, and vendor ASN
-- records should persist regardless, so this is the desired behavior.

ALTER TABLE shipments      DROP CONSTRAINT IF EXISTS shipments_po_id_fkey;
ALTER TABLE shipment_lines DROP CONSTRAINT IF EXISTS shipment_lines_po_line_item_id_fkey;

COMMENT ON COLUMN shipments.po_id IS 'PO this ASN is for: uuid resolving to tanda_pos.uuid_id (Xoro) OR purchase_orders.id (Tangerine). FK dropped 2026-06-18 to support both PO sources during the Xoro->Tangerine transition; ownership validated server-side.';
COMMENT ON COLUMN shipment_lines.po_line_item_id IS 'Shipped PO line: uuid resolving to po_line_items.id (Xoro) OR purchase_order_lines.id (Tangerine). FK dropped 2026-06-18 for both PO sources.';
