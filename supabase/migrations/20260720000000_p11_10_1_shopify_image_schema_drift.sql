-- P11-10-1 drift remediation — Shopify product mirror + polymorphic images.
--
-- These objects were applied directly to PROD via the Supabase CLI during
-- P11-10-1 but the migration file was never committed. This re-creates them
-- faithfully and idempotently so a fresh rebuild matches prod. Every statement
-- is a no-op where the object already exists (prod), and creates it where it
-- doesn't (fresh env). DDL captured from the live prod schema 2026-06-02.

-- ─── shopify_products (mirror of a Shopify product) ─────────────────────────
CREATE TABLE IF NOT EXISTS shopify_products (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id           uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  shopify_store_id    uuid NOT NULL REFERENCES shopify_stores(id) ON DELETE RESTRICT,
  shopify_product_id  bigint NOT NULL,
  shopify_handle      text NOT NULL,
  title               text NOT NULL,
  product_type        text,
  vendor              text,
  tags                text[] NOT NULL DEFAULT '{}'::text[],
  status              text NOT NULL DEFAULT 'active'
                        CHECK (status = ANY (ARRAY['active','archived','draft'])),
  published_at        timestamptz,
  updated_at_shopify  timestamptz NOT NULL,
  raw_payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolved_style_id   uuid REFERENCES style_master(id) ON DELETE SET NULL,
  match_method        text CHECK (match_method = ANY (ARRAY['handle','tag','manual'])),
  last_synced_at      timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shopify_products_unique UNIQUE (shopify_store_id, shopify_product_id)
);

CREATE INDEX IF NOT EXISTS idx_shopify_products_handle
  ON shopify_products USING btree (shopify_store_id, shopify_handle);
CREATE INDEX IF NOT EXISTS idx_shopify_products_style
  ON shopify_products USING btree (resolved_style_id) WHERE (resolved_style_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_shopify_products_unmatched
  ON shopify_products USING btree (last_synced_at) WHERE (resolved_style_id IS NULL);

-- ─── dropbox_backfill_failures (image migration quarantine) ─────────────────
CREATE TABLE IF NOT EXISTS dropbox_backfill_failures (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id           uuid NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  original_url        text NOT NULL,
  source_entity_type  text NOT NULL,
  source_entity_id    text NOT NULL,
  source_json_path    text,
  error_class         text NOT NULL,
  error_detail        text,
  bytes               bigint,
  mime_type           text,
  attempted_at        timestamptz NOT NULL DEFAULT now(),
  resolution          text CHECK (resolution = ANY (ARRAY['reuploaded','skipped','lost'])),
  resolved_at         timestamptz,
  resolved_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_dbf_unresolved
  ON dropbox_backfill_failures USING btree (attempted_at) WHERE (resolution IS NULL);

-- ─── product_images polymorphic columns ─────────────────────────────────────
ALTER TABLE product_images ADD COLUMN IF NOT EXISTS owner_type           text NOT NULL DEFAULT 'style';
ALTER TABLE product_images ADD COLUMN IF NOT EXISTS owner_id             text;
ALTER TABLE product_images ADD COLUMN IF NOT EXISTS source               text NOT NULL DEFAULT 'manual';
ALTER TABLE product_images ADD COLUMN IF NOT EXISTS shopify_image_id     bigint;
ALTER TABLE product_images ADD COLUMN IF NOT EXISTS original_dropbox_url text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_images_owner_type_check') THEN
    ALTER TABLE product_images ADD CONSTRAINT product_images_owner_type_check
      CHECK (owner_type = ANY (ARRAY['style','task','note_attachment','sku','shopify_product']));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_images_source_check') THEN
    ALTER TABLE product_images ADD CONSTRAINT product_images_source_check
      CHECK (source = ANY (ARRAY['manual','shopify','dropbox_migrated']));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_pi_owner
  ON product_images USING btree (owner_type, owner_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_pi_shopify_image
  ON product_images USING btree (shopify_image_id) WHERE (shopify_image_id IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pi_primary_per_owner
  ON product_images USING btree (owner_type, owner_id) WHERE (is_primary = true);

-- ─── style_master → shopify_products link ───────────────────────────────────
ALTER TABLE style_master ADD COLUMN IF NOT EXISTS shopify_product_id uuid;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'style_master_shopify_product_id_fkey') THEN
    ALTER TABLE style_master ADD CONSTRAINT style_master_shopify_product_id_fkey
      FOREIGN KEY (shopify_product_id) REFERENCES shopify_products(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_style_master_shopify
  ON style_master USING btree (shopify_product_id) WHERE (shopify_product_id IS NOT NULL);
