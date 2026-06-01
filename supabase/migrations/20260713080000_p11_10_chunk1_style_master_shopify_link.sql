-- ════════════════════════════════════════════════════════════════════════════
-- P11-10 Chunk 1: style_master.shopify_product_id back-link
--
-- One style can be linked to at most one shopify_products row (per store).
-- ON DELETE SET NULL so an archived Shopify product doesn't cascade-delete
-- the style.
--
-- See docs/tangerine/P11-10-shopify-product-mirror-and-image-unification.md §3.3
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE style_master
  ADD COLUMN IF NOT EXISTS shopify_product_id uuid
    REFERENCES shopify_products(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_style_master_shopify
  ON style_master (shopify_product_id)
  WHERE shopify_product_id IS NOT NULL;

COMMENT ON COLUMN style_master.shopify_product_id IS
  'P11-10: optional FK to the shopify_products row that mirrors this style. NULL means style is not on Shopify (yet, or by design — internal-only style).';

NOTIFY pgrst, 'reload schema';
