-- Manufacturing module (M5) — link a goods receipt to a build order.
--
-- When a conversion/subcontract PO (native purchase_orders) is cut for a build's
-- finished style, receiving the finished good against that PO COMPLETES the
-- build (WIP → finished goods) instead of running the normal goods-receipt path.
-- The link is derived from mfg_build_orders.conversion_po_id, but this explicit
-- column lets a receipt be tied to a build directly and is stamped on post.
ALTER TABLE tanda_po_receipts
  ADD COLUMN IF NOT EXISTS build_order_id uuid REFERENCES mfg_build_orders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS tanda_po_receipts_build_order_idx ON tanda_po_receipts(build_order_id);

-- Now that mfg_build_orders exists (M4), add the real FK for the conversion PO
-- link (was an FK-less uuid placeholder in M4 to avoid coupling).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='purchase_orders') THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE constraint_name='mfg_build_orders_conversion_po_fk' AND table_name='mfg_build_orders'
    ) THEN
      ALTER TABLE mfg_build_orders
        ADD CONSTRAINT mfg_build_orders_conversion_po_fk
        FOREIGN KEY (conversion_po_id) REFERENCES purchase_orders(id) ON DELETE SET NULL;
    END IF;
  END IF;
END;
$$;
