-- PO status: add 'partially_received' and stop overloading 'in_transit'.
--
-- Xoro "Partially Received" was mapped to native status 'in_transit', which is
-- misleading: in-transit means goods physically on the water/air (an ASN /
-- shipment overlay, a separate dimension a PO can carry ON TOP of its lifecycle
-- status), NOT "some units received". Give partial receipts their own lifecycle
-- status so the grid reads "Partially Received", and reserve 'in_transit' for
-- the shipment overlay (introduced with po_shipments in a follow-up). Both stay
-- in the CHECK for backward-compat; the import mapping now emits
-- 'partially_received' for Xoro "Partially Received".
ALTER TABLE purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_status_check;
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_status_check
  CHECK (status IN ('draft','issued','partially_received','in_transit','received','cancelled'));

-- Migrate existing rows: every current 'in_transit' native PO is a Xoro
-- "Partially Received" (that was the old mapping) -> partially_received.
UPDATE purchase_orders SET status = 'partially_received' WHERE status = 'in_transit';
