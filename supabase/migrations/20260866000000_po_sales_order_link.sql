-- Purchase Orders — link to the originating Sales Order.
--
-- When a PO is created from an SO ("Create from Sales Order"), this records the
-- source order for traceability. Nullable; SET NULL if the SO is later removed.

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS sales_order_id uuid REFERENCES sales_orders(id) ON DELETE SET NULL;

COMMENT ON COLUMN purchase_orders.sales_order_id IS 'Originating sales order when the PO was created from an SO.';
