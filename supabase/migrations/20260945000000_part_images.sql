-- Manufacturing — Part images.
--
-- Mirrors product_images (the PIM style image table) but keyed to part_master
-- instead of style_master, so a PART (blank garment, label, trim, packaging,
-- fabric) can carry photos exactly like a finished style does. Same Supabase
-- Storage bucket (`pim-images`) and Sharp derivative pipeline are reused; only
-- the DB anchor differs. Derivatives are stored under
--   pim-images/<entity_id>/parts/<part_id>/<image_id>-<thumb|web|print>.jpg
CREATE TABLE IF NOT EXISTS part_images (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id           uuid NOT NULL DEFAULT rof_entity_id() REFERENCES entities(id) ON DELETE RESTRICT,
  part_id             uuid NOT NULL REFERENCES part_master(id) ON DELETE CASCADE,
  image_kind          text NOT NULL DEFAULT 'photo',
  storage_path        text NOT NULL,
  storage_path_thumb  text,
  storage_path_web    text,
  alt_text            text,
  sort_order          int NOT NULL DEFAULT 0,
  is_primary          boolean NOT NULL DEFAULT false,
  mime_type           text,
  bytes               bigint,
  width               int,
  height              int,
  uploaded_by_user_id uuid,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS part_images_part_idx ON part_images(part_id);
-- At most one primary image per part.
CREATE UNIQUE INDEX IF NOT EXISTS part_images_one_primary_per_part
  ON part_images(part_id) WHERE is_primary;

-- RLS — anon_all + auth_internal (mirrors mfg_build_outputs).
ALTER TABLE part_images ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "anon_all_part_images" ON part_images;
CREATE POLICY "anon_all_part_images" ON part_images FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "auth_internal_part_images" ON part_images;
CREATE POLICY "auth_internal_part_images" ON part_images
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
