-- Purchase Orders — rich document header.
--
-- Adds the buyer-facing PO header fields (identity, vendor detail, the full date
-- set, logistics/destination, and merchandising classification). The STATUS
-- enum is intentionally left unchanged (draft/issued/in_transit/received/
-- cancelled) — surfaced read-only in the new header. All columns nullable so
-- existing POs are unaffected.

ALTER TABLE purchase_orders
  -- Identity & context
  ADD COLUMN IF NOT EXISTS po_type               text,
  ADD COLUMN IF NOT EXISTS customer_id           uuid REFERENCES customers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS po_prefix             text,                 -- editable number prefix (default 'PO' at issue)
  -- Vendor / supplier detail
  ADD COLUMN IF NOT EXISTS vendor_contact        text,
  ADD COLUMN IF NOT EXISTS vendor_email          text,
  ADD COLUMN IF NOT EXISTS vendor_ref            text,                 -- vendor's PO / reference #
  ADD COLUMN IF NOT EXISTS factory_location      text,
  ADD COLUMN IF NOT EXISTS coo                   text,                 -- country of origin (name)
  -- Dates
  ADD COLUMN IF NOT EXISTS requested_delivery_date date,               -- in-DC / required delivery
  ADD COLUMN IF NOT EXISTS ship_window_start     date,
  ADD COLUMN IF NOT EXISTS ship_window_end       date,
  ADD COLUMN IF NOT EXISTS port_date             date,
  ADD COLUMN IF NOT EXISTS acknowledged_date     date,                 -- vendor-confirmed
  ADD COLUMN IF NOT EXISTS cancel_date           date,
  -- Logistics & destination
  ADD COLUMN IF NOT EXISTS ship_to_location_id   uuid REFERENCES inventory_locations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS bill_to_entity_id     uuid REFERENCES entities(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ship_method           text,                 -- sea / air / ground
  ADD COLUMN IF NOT EXISTS freight_forwarder     text,
  -- Classification
  ADD COLUMN IF NOT EXISTS season                text,                 -- free text, sourced from season_master picklist
  ADD COLUMN IF NOT EXISTS channel_id            uuid REFERENCES channel_master(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS department_category_id uuid REFERENCES ip_category_master(id) ON DELETE SET NULL;

ALTER TABLE purchase_orders
  ADD CONSTRAINT purchase_orders_po_type_chk
    CHECK (po_type IS NULL OR po_type IN ('stock','replenishment','made_to_order','sample','drop_ship')),
  ADD CONSTRAINT purchase_orders_ship_method_chk
    CHECK (ship_method IS NULL OR ship_method IN ('sea','air','ground'));

COMMENT ON COLUMN purchase_orders.po_type IS 'stock / replenishment / made_to_order / sample / drop_ship';
COMMENT ON COLUMN purchase_orders.customer_id IS 'Customer this PO is being bought for (drop-ship / made-to-order).';
COMMENT ON COLUMN purchase_orders.department_category_id IS 'Department = main category (ip_category_master).';
