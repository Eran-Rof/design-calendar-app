-- ════════════════════════════════════════════════════════════════════════════
-- P11-10 Chunk 1: extend product_images to be polymorphic
--
-- Adds (owner_type, owner_id, source, shopify_image_id, original_dropbox_url)
-- so the same table backs PIM styles AND DC tasks/notes/SKUs AND Shopify
-- product mirrors. Backfills owner_id from style_id for existing rows.
-- Replaces the per-style primary-unique constraint with a per-owner
-- partial unique index. style_id stays for back-compat (legacy PIM handler
-- still reads it directly) but becomes nullable.
--
-- Naming note: this table already has an entity_id column (FK to entities,
-- the Tangerine tenant scope). We DELIBERATELY use owner_type/owner_id for
-- polymorphic ownership to avoid the collision. owner_id is the FK to
-- style_master.id, tasks.id, ip_item_master.id, etc. depending on owner_type.
--
-- See docs/tangerine/P11-10-shopify-product-mirror-and-image-unification.md §3.1
--
-- Pre-flight verified 2026-06-01: zero existing rows where multiple
-- product_images.is_primary=true share a style_id. Safe to swap constraint.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE product_images
  ADD COLUMN IF NOT EXISTS owner_type text NOT NULL DEFAULT 'style'
    CHECK (owner_type IN ('style','task','note_attachment','sku','shopify_product')),
  ADD COLUMN IF NOT EXISTS owner_id   text,
  ADD COLUMN IF NOT EXISTS source     text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual','shopify','dropbox_migrated')),
  ADD COLUMN IF NOT EXISTS shopify_image_id bigint,
  ADD COLUMN IF NOT EXISTS original_dropbox_url text;

-- Backfill owner_id := style_id for existing style-grain rows.
UPDATE product_images
   SET owner_id = style_id::text
 WHERE owner_id IS NULL AND style_id IS NOT NULL;

-- Loosen style_id NOT NULL so non-style rows (task/sku/etc) can omit it.
ALTER TABLE product_images
  ALTER COLUMN style_id DROP NOT NULL;

-- Replace per-style primary-unique EXCLUDE with per-owner partial unique index.
ALTER TABLE product_images
  DROP CONSTRAINT IF EXISTS pi_primary_unique_per_style;

CREATE UNIQUE INDEX IF NOT EXISTS uq_pi_primary_per_owner
  ON product_images (owner_type, owner_id)
  WHERE is_primary = true;

CREATE INDEX IF NOT EXISTS idx_pi_owner
  ON product_images (owner_type, owner_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_pi_source
  ON product_images (source) WHERE source <> 'manual';

CREATE INDEX IF NOT EXISTS idx_pi_shopify_image
  ON product_images (shopify_image_id) WHERE shopify_image_id IS NOT NULL;

COMMENT ON COLUMN product_images.owner_type IS
  'P11-10: which entity owns this image. style=style_master, task=tasks (text PK), note_attachment=tanda_notes, sku=ip_item_master, shopify_product=shopify_products. Distinct from entity_id which is Tangerine tenant scope.';

COMMENT ON COLUMN product_images.owner_id IS
  'P11-10: text PK of the owning entity. Widened to text to accept tasks.id which is text not uuid.';

COMMENT ON COLUMN product_images.source IS
  'P11-10: provenance. manual=hand-upload, shopify=pulled from Shopify Admin API, dropbox_migrated=backfilled from legacy /api/dropbox-proxy storage.';

COMMENT ON COLUMN product_images.shopify_image_id IS
  'P11-10: Shopify Admin API image id for idempotency on re-sync. Lets pull-images skip already-mirrored images.';

COMMENT ON COLUMN product_images.original_dropbox_url IS
  'P11-10: audit trail — only set on rows created by the Dropbox backfill. Lets operator trace any rehosted image back to its original Dropbox path if questions arise.';

NOTIFY pgrst, 'reload schema';
