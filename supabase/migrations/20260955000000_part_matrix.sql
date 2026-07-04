-- 20260955000000_part_matrix.sql
--
-- Matrix (by-size) manufacturing PARTS — modeled on styles (P2).
--
-- A "matrix part" is a size-scaled part (e.g. a blank tee that comes in S/M/L).
-- It mirrors the style→SKU shape within one table:
--   • a PARENT part_master row (is_matrix=true, size_scale_id set) — the thing
--     you pick on a BOM / PO; holds NO inventory of its own.
--   • per-size CHILD rows (parent_part_id set, size set) — each is an ordinary
--     part with its own FIFO inventory (part_inventory_layers.part_id → child).
-- Children are find-or-created on demand (resolveOrCreatePartSize), exactly how
-- a style's per-size ip_item_master SKUs are materialized by resolveOrCreateSku.
--
-- Non-matrix parts are unaffected (is_matrix=false, parent_part_id/size NULL).
-- Idempotent.

ALTER TABLE part_master
  ADD COLUMN IF NOT EXISTS is_matrix      boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS size_scale_id  uuid REFERENCES size_scales(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS parent_part_id uuid REFERENCES part_master(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS size           text;

-- One child per (parent, size).
CREATE UNIQUE INDEX IF NOT EXISTS uq_part_master_parent_size
  ON part_master(parent_part_id, size) WHERE parent_part_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS part_master_parent_idx
  ON part_master(parent_part_id) WHERE parent_part_id IS NOT NULL;

COMMENT ON COLUMN part_master.is_matrix IS 'True = a size-scaled matrix PARENT part; its per-size children (parent_part_id set) hold the inventory. Mirrors a style with per-size SKUs.';
COMMENT ON COLUMN part_master.size_scale_id IS 'For a matrix parent: the size scale (size_scales) that defines its sizes.';
COMMENT ON COLUMN part_master.parent_part_id IS 'Set on a per-size CHILD row → its matrix parent. Child rows carry the FIFO inventory for one size.';
COMMENT ON COLUMN part_master.size IS 'The size this child row represents (NULL on parents / non-matrix parts).';

NOTIFY pgrst, 'reload schema';
