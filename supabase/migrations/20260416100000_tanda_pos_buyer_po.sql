-- 20260416100000_tanda_pos_buyer_po.sql
--
-- Add a buyer_po column to tanda_pos. Initially populated from Xoro's
-- ReferenceNumber on each sync, then user-editable via the detail panel.
-- Sync logic preserves any non-empty value (treated as a user override) so
-- subsequent Xoro fetches don't clobber an edit.

ALTER TABLE tanda_pos
  ADD COLUMN IF NOT EXISTS buyer_po text;

CREATE INDEX IF NOT EXISTS idx_tanda_pos_buyer_po
  ON tanda_pos (buyer_po) WHERE buyer_po IS NOT NULL AND buyer_po <> '';
