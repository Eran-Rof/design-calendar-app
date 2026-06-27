-- 20260908000000_adjustment_type_description.sql
--
-- Add an optional free-text description to adjustment_type_master so operators
-- can record details about how each inventory-adjustment category/reason is
-- intended to be used. Idempotent.

ALTER TABLE adjustment_type_master ADD COLUMN IF NOT EXISTS description text;

COMMENT ON COLUMN adjustment_type_master.description IS
  'Optional free-text notes describing how this adjustment type is used. Curated picklist metadata only; not used in FIFO accounting.';
