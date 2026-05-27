-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine — style_master.style_name
--
-- Adds an explicit `style_name` column to style_master, distinct from the
-- existing `style_code` (the human ID like RYB0412) and `description` (the
-- free-text long description). UI now renders three labels:
--   Style Number   = style_code
--   Style Name     = style_name   (NEW — short marketing/internal name)
--   Description    = description  (existing long text)
--
-- Nullable; no backfill — operator fills the new column via the admin UI.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE style_master
  ADD COLUMN IF NOT EXISTS style_name text;

COMMENT ON COLUMN style_master.style_name IS
  'Short marketing/internal name for the style (NEW). Distinct from style_code (human ID) and description (long text). Nullable.';

NOTIFY pgrst, 'reload schema';
