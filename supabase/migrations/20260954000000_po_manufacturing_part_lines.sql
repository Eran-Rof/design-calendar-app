-- 20260954000000_po_manufacturing_part_lines.sql
--
-- Manufacturing parts via native PURCHASE ORDERS + RECEIVING (P1, non-matrix).
--
-- Until now a part_master part could only be stocked via a synthesized vendor
-- bill (part-purchases) or an adjustment. This adds a first-class procurement
-- path: a 'manufacturing_part' PO whose lines point at PARTS (not style SKUs),
-- received through the normal Receiving flow into part inventory (1360) with a
-- GRNI 3-way match (DR 1360 Inventory-Parts / CR 2050 GR/IR at receipt; the
-- vendor bill clears 2050).
--
--   1. po_type gains 'manufacturing_part'.
--   2. purchase_order_lines gains part_id (the part a line stocks; mutually
--      exclusive with inventory_item_id — a line is a style SKU OR a part).
--
-- Mirrors invoice_line_items.part_id (mig 20260889000000). Idempotent.

-- 1) Allow the new po_type. Re-create the CHECK to add 'manufacturing_part'.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'purchase_orders_po_type_chk' AND conrelid = 'purchase_orders'::regclass) THEN
    ALTER TABLE purchase_orders DROP CONSTRAINT purchase_orders_po_type_chk;
  END IF;
  ALTER TABLE purchase_orders
    ADD CONSTRAINT purchase_orders_po_type_chk
      CHECK (po_type IS NULL OR po_type IN ('stock','replenishment','made_to_order','sample','drop_ship','manufacturing_part'));
END $$;

COMMENT ON COLUMN purchase_orders.po_type IS 'stock / replenishment / made_to_order / sample / drop_ship / manufacturing_part';

-- 2) part_id on PO lines (a manufacturing-part line stocks a part_master part
--    into part inventory instead of a style SKU into style inventory).
ALTER TABLE purchase_order_lines
  ADD COLUMN IF NOT EXISTS part_id uuid REFERENCES part_master(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS purchase_order_lines_part_idx ON purchase_order_lines(part_id) WHERE part_id IS NOT NULL;

COMMENT ON COLUMN purchase_order_lines.part_id IS 'When set, this PO line stocks a manufacturing part (part_master) into part inventory (1360) on receipt — instead of a style SKU (inventory_item_id).';

-- 3) The vendor bill that 3-way-matches a received manufacturing-part PO clears
--    2050 GR/IR (DR 2050 / +-6320 PPV / CR AP). One bill per part PO; this stamps
--    the invoice so the bill endpoint is idempotent (never bills twice).
ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS part_bill_invoice_id uuid REFERENCES invoices(id) ON DELETE SET NULL;

COMMENT ON COLUMN purchase_orders.part_bill_invoice_id IS 'The vendor AP bill that 3-way-matched this manufacturing-part PO (clears 2050 GR/IR). Set once; makes the part-bill endpoint idempotent.';

NOTIFY pgrst, 'reload schema';
