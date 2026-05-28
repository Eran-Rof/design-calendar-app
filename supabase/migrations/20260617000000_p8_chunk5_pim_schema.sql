-- ════════════════════════════════════════════════════════════════════════════
-- Tangerine P8-5 — M42 PIM (Product Information Management) schema (arch §5)
--
-- Five new tables:
--   1. product_categories          — 3-level taxonomy (Category > SubCat > Style-Type)
--   2. product_attribute_definitions — per-category attribute schema (mutable by ops)
--   3. product_attributes          — per-style attribute values (jsonb)
--   4. product_descriptions        — per-style x locale long/short copy + SEO + lifecycle
--   5. product_images              — per-style multi-size derivative paths + EXCLUDE
--                                    (only one is_primary=true per style)
--
-- Storage: the Sharp upload pipeline (P8-7) will populate a Supabase Storage
-- bucket `pim-images`. Bucket creation is via Dashboard, NOT SQL (mirrors
-- P2-5 bucket-setup pattern). See PR body for operator action.
--
-- See docs/tangerine/P8-data-crm-architecture.md §5.
-- ════════════════════════════════════════════════════════════════════════════

-- Required by EXCLUDE constraint on product_images (gist_btree for uuid =).
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ─── 1. product_categories ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS product_categories (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id            uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  parent_category_id   uuid REFERENCES product_categories(id) ON DELETE RESTRICT,
  code                 text NOT NULL,
  name                 text NOT NULL,
  sort_order           int  NOT NULL DEFAULT 0,
  is_active            boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_categories_code_per_entity_unique UNIQUE (entity_id, code),
  CONSTRAINT product_categories_code_nonempty CHECK (char_length(trim(code)) > 0),
  CONSTRAINT product_categories_name_nonempty CHECK (char_length(trim(name)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_pcat_parent
  ON product_categories (parent_category_id)
  WHERE parent_category_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pcat_entity_active
  ON product_categories (entity_id, is_active);

COMMENT ON TABLE product_categories IS
  'P8 M42: 3-level product taxonomy (Category > SubCategory > Style-Type) via self-FK.';

-- ─── 2. product_attribute_definitions ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS product_attribute_definitions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id            uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  category_id          uuid REFERENCES product_categories(id) ON DELETE CASCADE,
  attribute_key        text NOT NULL,
  label                text NOT NULL,
  value_type           text NOT NULL CHECK (value_type IN ('enum','number','text','boolean','date')),
  options              jsonb,
  is_required          boolean NOT NULL DEFAULT false,
  sort_order           int NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pad_unique_per_category UNIQUE (entity_id, category_id, attribute_key),
  CONSTRAINT pad_attribute_key_nonempty CHECK (char_length(trim(attribute_key)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_pad_category
  ON product_attribute_definitions (category_id);

COMMENT ON TABLE product_attribute_definitions IS
  'P8 M42: per-category attribute schema. value_type enum drives UI input. options jsonb {"options":[...]} for enum-type.';

-- ─── 3. product_attributes (per-style values) ──────────────────────────────
CREATE TABLE IF NOT EXISTS product_attributes (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id            uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  style_id             uuid NOT NULL REFERENCES style_master(id) ON DELETE CASCADE,
  attribute_key        text NOT NULL,
  value                jsonb NOT NULL,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT pa_unique_per_style UNIQUE (style_id, attribute_key),
  CONSTRAINT pa_attribute_key_nonempty CHECK (char_length(trim(attribute_key)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_pa_style
  ON product_attributes (style_id);
CREATE INDEX IF NOT EXISTS idx_pa_attribute_key
  ON product_attributes (attribute_key);

COMMENT ON TABLE product_attributes IS
  'P8 M42: per-style attribute values. value jsonb e.g. {"value":"slim"} or {"value":42}.';

-- ─── 4. product_descriptions ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS product_descriptions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id            uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  style_id             uuid NOT NULL REFERENCES style_master(id) ON DELETE CASCADE,
  locale               text NOT NULL DEFAULT 'en-US',
  short_description    text,
  long_description     text,
  bullet_1             text,
  bullet_2             text,
  bullet_3             text,
  bullet_4             text,
  bullet_5             text,
  seo_title            text,
  seo_description      text,
  publish_status       text NOT NULL DEFAULT 'draft' CHECK (publish_status IN ('draft','published')),
  published_at         timestamptz,
  published_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT pd_unique_per_style_locale UNIQUE (style_id, locale),
  CONSTRAINT pd_locale_nonempty CHECK (char_length(trim(locale)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_pd_style_publish
  ON product_descriptions (style_id, publish_status);
CREATE INDEX IF NOT EXISTS idx_pd_published
  ON product_descriptions (publish_status, published_at DESC)
  WHERE publish_status = 'published';

COMMENT ON TABLE product_descriptions IS
  'P8 M42: per-style x locale long/short copy. draft/published lifecycle for future M12 Shopify feed.';

-- ─── 5. product_images ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS product_images (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id            uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  style_id             uuid NOT NULL REFERENCES style_master(id) ON DELETE CASCADE,
  image_kind           text NOT NULL DEFAULT 'flat'
                        CHECK (image_kind IN ('flat','lifestyle','spec','swatch','other')),
  storage_path         text NOT NULL,
  storage_path_thumb   text,
  storage_path_web     text,
  storage_path_print   text,
  alt_text             text,
  sort_order           int NOT NULL DEFAULT 0,
  is_primary           boolean NOT NULL DEFAULT false,
  mime_type            text,
  bytes                bigint,
  width                int,
  height               int,
  uploaded_by_user_id  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pi_storage_path_nonempty CHECK (char_length(trim(storage_path)) > 0),
  CONSTRAINT pi_primary_unique_per_style EXCLUDE (style_id WITH =) WHERE (is_primary = true)
);

CREATE INDEX IF NOT EXISTS idx_pi_style
  ON product_images (style_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_pi_primary_by_style
  ON product_images (style_id)
  WHERE is_primary = true;

COMMENT ON TABLE product_images IS
  'P8 M42: per-style images with multi-size derivative paths (thumb/web/print). EXCLUDE constraint enforces at-most-one is_primary=true per style. Sharp pipeline P8-7 populates storage_path_*.';
COMMENT ON COLUMN product_images.storage_path IS
  'Original upload path in pim-images bucket. Pattern: <entity_id>/<style_id>/<image_id>.{ext}.';

-- ─── 6. RLS template (anon FOR ALL per P1 standing pattern) ────────────────
ALTER TABLE product_categories            ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_attribute_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_attributes            ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_descriptions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_images                ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'anon_all_product_categories' AND tablename = 'product_categories') THEN
    CREATE POLICY anon_all_product_categories            ON product_categories            FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'anon_all_product_attribute_definitions' AND tablename = 'product_attribute_definitions') THEN
    CREATE POLICY anon_all_product_attribute_definitions ON product_attribute_definitions FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'anon_all_product_attributes' AND tablename = 'product_attributes') THEN
    CREATE POLICY anon_all_product_attributes            ON product_attributes            FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'anon_all_product_descriptions' AND tablename = 'product_descriptions') THEN
    CREATE POLICY anon_all_product_descriptions          ON product_descriptions          FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'anon_all_product_images' AND tablename = 'product_images') THEN
    CREATE POLICY anon_all_product_images                ON product_images                FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
END $$;

-- ─── 7. Seed root product categories for ROF entity ───────────────────────
-- Resolved by entity slug='rof' (or code='ROF') so seed is environment-stable.
-- Idempotent via ON CONFLICT (entity_id, code) DO NOTHING.
DO $$
DECLARE
  rof_entity_id uuid;
BEGIN
  SELECT id INTO rof_entity_id
    FROM entities
   WHERE slug = 'rof' OR code = 'ROF'
   LIMIT 1;

  IF rof_entity_id IS NOT NULL THEN
    INSERT INTO product_categories (entity_id, code, name, sort_order, is_active) VALUES
      (rof_entity_id, 'DENIM',       'Denim',       10, true),
      (rof_entity_id, 'TOPS',        'Tops',        20, true),
      (rof_entity_id, 'BOTTOMS',     'Bottoms',     30, true),
      (rof_entity_id, 'OUTERWEAR',   'Outerwear',   40, true),
      (rof_entity_id, 'DRESSES',     'Dresses',     50, true),
      (rof_entity_id, 'ACCESSORIES', 'Accessories', 60, true)
    ON CONFLICT (entity_id, code) DO NOTHING;

    -- Example Denim attribute definitions (mutable by ops post-deploy).
    INSERT INTO product_attribute_definitions
      (entity_id, category_id, attribute_key, label, value_type, options, is_required, sort_order)
    SELECT
      rof_entity_id, pc.id, 'fit_type', 'Fit', 'enum',
      '{"options":["slim","regular","relaxed"]}'::jsonb, false, 10
      FROM product_categories pc
     WHERE pc.entity_id = rof_entity_id AND pc.code = 'DENIM'
    ON CONFLICT (entity_id, category_id, attribute_key) DO NOTHING;

    INSERT INTO product_attribute_definitions
      (entity_id, category_id, attribute_key, label, value_type, options, is_required, sort_order)
    SELECT
      rof_entity_id, pc.id, 'rise', 'Rise', 'enum',
      '{"options":["low","mid","high"]}'::jsonb, false, 20
      FROM product_categories pc
     WHERE pc.entity_id = rof_entity_id AND pc.code = 'DENIM'
    ON CONFLICT (entity_id, category_id, attribute_key) DO NOTHING;

    INSERT INTO product_attribute_definitions
      (entity_id, category_id, attribute_key, label, value_type, options, is_required, sort_order)
    SELECT
      rof_entity_id, pc.id, 'wash', 'Wash', 'text',
      NULL, false, 30
      FROM product_categories pc
     WHERE pc.entity_id = rof_entity_id AND pc.code = 'DENIM'
    ON CONFLICT (entity_id, category_id, attribute_key) DO NOTHING;
  END IF;
END $$;

-- ─── 8. PostgREST schema cache reload ─────────────────────────────────────
NOTIFY pgrst, 'reload schema';
