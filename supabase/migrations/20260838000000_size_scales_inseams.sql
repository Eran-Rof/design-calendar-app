-- 20260838000000_size_scales_inseams.sql
-- Add an ordered `inseams` list to size scales, parallel to `sizes`.
--
-- A size scale already carries an ordered text[] of size labels. Bottoms (pants,
-- shorts) also vary by inseam — e.g. waist 30/32/34 × inseam 30/32. Rather than a
-- separate inseam-scale master, inseams live on the same size_scales row and are
-- entered the same way sizes are (comma-separated, order preserved). A style that
-- references the scale inherits BOTH axes. Empty inseams ('{}') = a size-only
-- scale (tops, accessories), which is the default and unchanged behavior.

ALTER TABLE size_scales
  ADD COLUMN IF NOT EXISTS inseams text[] NOT NULL DEFAULT '{}'::text[];

COMMENT ON COLUMN size_scales.inseams IS 'Ordered inseam labels for bottoms (e.g. {30,32,34}). Empty = size-only scale. Parallel to sizes; order preserved as entered.';
