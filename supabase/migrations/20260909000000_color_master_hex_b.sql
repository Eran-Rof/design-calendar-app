-- 20260909000000_color_master_hex_b.sql
--
-- Two-tone (Color A / Color B) swatches in the Color Master.
--
-- `color_master.hex` is Color A. This migration adds an optional `hex_b` for
-- Color B so a two-tone colourway (e.g. "Black/Grey") can render an explicit
-- half-and-half swatch instead of relying only on parsing the colour name.
-- Idempotent.

ALTER TABLE color_master ADD COLUMN IF NOT EXISTS hex_b text;

COMMENT ON COLUMN color_master.hex   IS 'Primary swatch colour (Color A), #RRGGBB. Also the single colour for a plain colourway.';
COMMENT ON COLUMN color_master.hex_b IS 'Optional second swatch colour (Color B), #RRGGBB. When set, the swatch renders a half-and-half two-tone split of hex (A) / hex_b (B).';
