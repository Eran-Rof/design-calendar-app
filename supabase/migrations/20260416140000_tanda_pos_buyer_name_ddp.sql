-- 20260416140000_tanda_pos_buyer_name_ddp.sql
--
-- Add user-editable override columns for buyer_name and date_expected_delivery.
-- These allow grid edits to persist independently of the Xoro JSONB payload.
-- loadCachedPOs folds these columns on top of r.data so they take priority
-- over whatever Xoro last synced.

ALTER TABLE tanda_pos
  ADD COLUMN IF NOT EXISTS buyer_name text,
  ADD COLUMN IF NOT EXISTS date_expected_delivery text;

CREATE INDEX IF NOT EXISTS idx_tanda_pos_buyer_name
  ON tanda_pos (buyer_name) WHERE buyer_name IS NOT NULL AND buyer_name <> '';

CREATE INDEX IF NOT EXISTS idx_tanda_pos_ddp
  ON tanda_pos (date_expected_delivery) WHERE date_expected_delivery IS NOT NULL AND date_expected_delivery <> '';
