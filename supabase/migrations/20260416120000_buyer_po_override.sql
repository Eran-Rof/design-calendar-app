-- 20260416120000_buyer_po_override.sql
--
-- [REVERTED by 20260416130000] Added a local-override column for Buyer PO.
-- Dropped in the next migration because a `buyer_po` column with the same
-- purpose was added earlier in commit 0a2b247 — this one was redundant.
-- Kept here only because the migration was already applied to the remote
-- DB and the drop lives in 20260416130000.

ALTER TABLE tanda_pos
  ADD COLUMN IF NOT EXISTS buyer_po_override text;
