-- Audit marker for FIFO consumption that has been REVERSED — i.e. when a posted
-- AR invoice is voided, the units it drew from inventory are put back on-hand and
-- the original inventory_consumption rows are stamped reversed (kept, not deleted,
-- so the append-only draw ledger is preserved). A NULL reversed_at = a live draw.
--
-- The actual put-back (adding qty_consumed back to inventory_layers.remaining_qty)
-- is done by api/_lib/inventory/restoreInvoiceConsumption.js, called from the AR
-- invoice void flow. This migration only adds the columns. Additive + idempotent.

ALTER TABLE inventory_consumption
  ADD COLUMN IF NOT EXISTS reversed_at         timestamptz,
  ADD COLUMN IF NOT EXISTS reversed_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN inventory_consumption.reversed_at IS 'When set, this FIFO draw was reversed (e.g. AR invoice voided) and the qty was returned to inventory_layers.remaining_qty. NULL = live draw.';

-- Partial index so the restore lookup (live ar_invoice draws for a set of lines)
-- skips already-reversed rows cheaply.
CREATE INDEX IF NOT EXISTS idx_inventory_consumption_live_ar
  ON inventory_consumption (consumer_invoice_id)
  WHERE consumer_kind = 'ar_invoice' AND reversed_at IS NULL;

NOTIFY pgrst, 'reload schema';
