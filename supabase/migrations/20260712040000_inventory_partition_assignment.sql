-- P15 stock-pool — assign received inventory to a brand pool ("store").
--
-- inventory_layers (FIFO, P3-3) lumped all of an item's on-hand in one pool with
-- no brand/channel split. This adds the partition link so NEW receipts land in
-- the chosen brand pool. Per operator decision (2026-06-01):
--   • existing layers stay UNPARTITIONED (partition_id NULL = shared/all) —
--     forward-only, no historical backfill (mirrors the GL "no retro-split" rule);
--   • a PO/AP receipt lands in the brand's Wholesale OR Ecom pool, chosen by the
--     user at receipt time (invoices.receiving_channel). PT has one shared pool.
--
-- Stamping is metadata only — FIFO consumption still draws across all of an
-- item's layers as before. Partition-aware consumption (drawing from a specific
-- pool) is a later, BRAND_SCOPE_MODE-gated step.
--
-- All additive + idempotent.

ALTER TABLE inventory_layers
  ADD COLUMN IF NOT EXISTS partition_id uuid REFERENCES inventory_partition(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_inventory_layers_partition ON inventory_layers (partition_id);

COMMENT ON COLUMN inventory_layers.partition_id IS
  'Brand stock pool (inventory_partition) this layer belongs to. NULL = legacy/unpartitioned (pre-P15 on-hand). Set on new receipts from the brand + receiving_channel.';

-- Which side of the brand the receipt goes to. WS = wholesale pool, EC = ecom
-- pool. PT (single shared pool) ignores it. NULL defaults to WS in the app.
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS receiving_channel text;

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_receiving_channel_chk;
ALTER TABLE invoices
  ADD CONSTRAINT invoices_receiving_channel_chk
  CHECK (receiving_channel IS NULL OR receiving_channel IN ('WS', 'EC'));

COMMENT ON COLUMN invoices.receiving_channel IS
  'P15: which brand pool side received inventory lands in — WS (wholesale) or EC (ecom). NULL → WS. PT and wholesale-only brands collapse to their single pool.';

NOTIFY pgrst, 'reload schema';
