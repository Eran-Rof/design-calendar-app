-- Purchase Order lines — per-line dates.
--
-- The operator manages two dates per PO line group (one per style block in the
-- size matrix): the requested ship date and the vendor-confirmed ship date.
-- Stamped onto every SKU line of that style. Both nullable.

ALTER TABLE purchase_order_lines
  ADD COLUMN IF NOT EXISTS requested_ship_date        date,
  ADD COLUMN IF NOT EXISTS vendor_confirmed_ship_date date;

COMMENT ON COLUMN purchase_order_lines.requested_ship_date IS 'Requested ship date for this line (editable per style block in the PO matrix).';
COMMENT ON COLUMN purchase_order_lines.vendor_confirmed_ship_date IS 'Vendor-confirmed ship date for this line.';
