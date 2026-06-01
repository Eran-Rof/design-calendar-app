-- P15 stock-pool: let a positive inventory adjustment pick the brand pool side.
-- Mirrors invoices.receiving_channel — a found/correction-up adjustment creates
-- a FIFO layer; this says whether it lands in the brand's WS or EC pool.
-- NULL → WS in the app. Negative adjustments (consume) ignore it.

ALTER TABLE inventory_adjustments
  ADD COLUMN IF NOT EXISTS receiving_channel text;

ALTER TABLE inventory_adjustments DROP CONSTRAINT IF EXISTS inventory_adjustments_receiving_channel_chk;
ALTER TABLE inventory_adjustments
  ADD CONSTRAINT inventory_adjustments_receiving_channel_chk
  CHECK (receiving_channel IS NULL OR receiving_channel IN ('WS', 'EC'));

COMMENT ON COLUMN inventory_adjustments.receiving_channel IS
  'P15: brand pool side (WS|EC) a positive adjustment lands in. NULL → WS. Single-pool brands ignore it.';

NOTIFY pgrst, 'reload schema';
