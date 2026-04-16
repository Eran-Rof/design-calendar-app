-- 20260416130000_drop_buyer_po_override.sql
--
-- Drops the short-lived `buyer_po_override` column added in the previous
-- session. A user-editable buyer_po column already exists (added in commit
-- 0a2b247), so this one is redundant. Column was empty, unreferenced.

ALTER TABLE tanda_pos
  DROP COLUMN IF EXISTS buyer_po_override;
